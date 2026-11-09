//! Joining a voice channel or call, the room's events, and leaving it.

use super::*;

impl Voice {
    /// Comes into a voice channel or a call. `return_to` is what to open again on leaving a voice channel, if it's said.
    pub fn join(&mut self, server_id: String, channel_id: String, return_to: Option<Option<String>>, how: JoinHow, cx: &mut Context<Self>) {
        // Moving between voice channels keeps what was open before the first of them.
        let before = match return_to {
            Some(value) => value,
            None => self.open_before.clone(),
        };
        self.open_before = before.clone();
        if self.server_id.as_deref() == Some(&server_id) && self.channel_id.as_deref() == Some(&channel_id) && self.status != VoiceStatus::Idle {
            return;
        }
        if self.status != VoiceStatus::Idle {
            self.leave(cx);
        }
        self.open_before = before;
        self.attempt += 1;
        let mine = self.attempt;
        self.reconnects = 0;
        let call = !self.state.read(cx).servers.get(&server_id).is_some_and(|server| server.channels.iter().any(|channel| channel.id == channel_id));
        self.stop_mic_test(cx);
        self.reset();
        self.status = VoiceStatus::Connecting;
        self.server_id = Some(server_id.clone());
        self.channel_id = Some(channel_id.clone());
        self.call = call;
        self.ring_on_announce = how.ring && call;
        cx.notify();
        self.connect(server_id, channel_id, mine, how, cx);
        self.update_ringing(cx);
        self.update_ptt(cx);
    }

    /// Opens the microphone for the room, off the window's thread, with the source its sound
    /// goes to, which is published.
    pub(super) fn open_room_microphone(&self, settings: &VoiceSettings, cx: &mut Context<Self>) -> Task<Result<(Microphone, livekit::webrtc::audio_source::native::NativeAudioSource), String>> {
        let source = VoiceRoom::microphone_source();
        let sending = source.clone();
        let opening = open_microphone(settings, self.mic_off(), self.processing.clone(), move |frame| room::send_frame(&sending, frame, 1), cx);
        cx.background_executor().spawn(async move { opening.await.map(|mic| (mic, source)) })
    }

    pub(super) fn connect(&mut self, server_id: String, channel_id: String, mine: u64, how: JoinHow, cx: &mut Context<Self>) {
        let core = self.core(cx);
        let bitrate = self.state.read(cx).servers.get(&server_id).and_then(|server| server.channels.iter().find(|channel| channel.id == channel_id)).map(|channel| channel.bitrate as u64).unwrap_or(0);
        self.mixer.open(&self.settings.output_device);
        // Nothing about voice needs a microphone: someone without one can still listen. It's
        // opened alongside joining, off the window's thread, and joining waits for it.
        let opening = self.open_room_microphone(&self.settings.clone(), cx);
        let volumes = self.volumes_fn();
        let mixer = self.mixer.clone();
        cx.spawn(async move |this, cx| {
            let result: Result<(VoiceRoom, futures::channel::mpsc::UnboundedReceiver<Event>, bool), String> = async {
                let access = core.call(Some(&server_id), "voiceAccess", vec![json!(channel_id)]).await.map_err(|error| error.message)?;
                let text = |name: &str| access.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
                let (url, token, identity) = (text("url"), text("token"), text("identity"));
                let server_muted = access.get("serverMuted").and_then(Value::as_bool).unwrap_or(false);
                let key = core.call(Some(&server_id), "voiceKey", vec![json!(channel_id)]).await.map_err(|error| error.message)?;
                let epoch = key.get("epoch").and_then(Value::as_u64).unwrap_or(0);
                let room_key = key.get("key").and_then(read_bytes).ok_or_else(|| "Couldn't connect to voice.".to_string())?;
                let (room, events) = crate::host::tokio().spawn(VoiceRoom::join(url, token, identity, epoch, room_key, mixer, volumes)).await.map_err(|_| "Couldn't connect to voice.".to_string())??;
                Ok((room, events, server_muted))
            }
            .await;
            let opened = opening.await;
            this.update(cx, |voice, cx| {
                // A microphone for a join that's been given up goes, unless another one took its place.
                let mic_problem = match opened {
                    Ok((mic, source)) if mine == voice.attempt => {
                        voice.mic = Some(mic);
                        voice.mic_source = Some(source);
                        None
                    }
                    Ok(_) => None,
                    Err(problem) => {
                        if mine == voice.attempt {
                            *voice.processing.lock() = None;
                        }
                        Some(problem)
                    }
                };
                voice.joined(result, mine, server_id, channel_id, how, mic_problem, bitrate, cx)
            })
            .ok();
        })
        .detach();
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn joined(&mut self, result: Result<(VoiceRoom, futures::channel::mpsc::UnboundedReceiver<Event>, bool), String>, mine: u64, server_id: String, channel_id: String, how: JoinHow, mic_problem: Option<String>, bitrate: u64, cx: &mut Context<Self>) {
        match result {
            Ok((room, mut events, server_muted)) => {
                if mine != self.attempt {
                    room.close();
                    return;
                }
                room.server_muted.store(server_muted, std::sync::atomic::Ordering::Relaxed);
                let room = Arc::new(room);
                self.room = Some(room.clone());
                self.events_task = Some(cx.spawn(async move |this, cx| {
                    while let Some(event) = events.next().await {
                        if this.update(cx, |voice, cx| voice.on_room_event(mine, event, cx)).is_err() {
                            break;
                        }
                    }
                }));
                if let Some(problem) = mic_problem {
                    self.toast(format!("{problem} You can still listen."), ToastKind::Info, cx);
                }
                self.no_mic = self.mic.is_none();
                self.server_muted = server_muted;
                if let Some(source) = self.mic_source.clone() {
                    let muted = self.mic_off();
                    let publishing = room.clone();
                    crate::host::tokio().spawn(async move {
                        if let Err(error) = publishing.publish_mic(source, bitrate, muted).await {
                            log::warn!("voice microphone: {error}");
                        }
                    });
                }
                self.status = VoiceStatus::Connected;
                self.apply_mute(cx);
                self.sync_videos(cx);
                if self.reconnects == 0 {
                    self.sound(VoiceSound::SelfJoin);
                }
                self.start_ticker(cx);
                if how.camera && !self.camera {
                    self.toggle_camera(cx);
                }
                self.update_ringing(cx);
                cx.notify();
            }
            Err(message) => {
                if mine != self.attempt {
                    return;
                }
                log::warn!("joining a voice channel: {message}");
                self.toast(if message.is_empty() { "Couldn't connect to voice.".to_string() } else { message }, ToastKind::Error, cx);
                // A server that hasn't set this up, or a channel that's full, won't change in a moment.
                self.close_room();
                self.reset();
                self.close_stage(Some(server_id.clone()), Some(channel_id), cx);
                self.update_ptt(cx);
                let call = self.core(cx).call(Some(&server_id), "setVoiceState", vec![Value::Null, Value::Null]);
                cx.background_executor().spawn(async move { call.await.ok() }).detach();
                self.update_ringing(cx);
                cx.notify();
            }
        }
    }

    /// Watches the microphone's gate, for whether this person shows as speaking, and a device going away.
    pub(super) fn start_ticker(&mut self, cx: &mut Context<Self>) {
        self.tick_task = Some(cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(60)).await;
            let going = this
                .update(cx, |voice, cx| {
                    if voice.status == VoiceStatus::Idle {
                        return false;
                    }
                    let open = voice.reading().is_some_and(|reading| reading.open);
                    if open != voice.open {
                        voice.open = open;
                        cx.notify();
                    }
                    if voice.mic.as_ref().is_some_and(|mic| mic.lost.load(std::sync::atomic::Ordering::Relaxed)) {
                        voice.toast("Your microphone went away, so Zuna switched to the default one.", ToastKind::Info, cx);
                        voice.reopen_mic(Some("default".into()), cx);
                    }
                    true
                })
                .unwrap_or(false);
            if !going {
                break;
            }
        }));
    }

    /// Opens the microphone again, for a different device or for what only applies when it's opened.
    pub(super) fn reopen_mic(&mut self, device: Option<String>, cx: &mut Context<Self>) {
        if self.mic.is_none() && self.mic_task.is_none() {
            return;
        }
        let mut settings = self.settings.clone();
        if let Some(device) = device {
            settings.input_device = device;
        }
        self.mic = None;
        let attempt = self.attempt;
        let opening = self.open_room_microphone(&settings, cx);
        self.mic_task = Some(cx.spawn(async move |this, cx| {
            let opened = opening.await;
            this.update(cx, |voice, cx| {
                voice.mic_task = None;
                if voice.attempt != attempt || voice.status == VoiceStatus::Idle {
                    return;
                }
                match opened {
                    Ok((mic, source)) => {
                        voice.mic = Some(mic);
                        voice.mic_source = Some(source);
                        // The room's source stays the same, so nothing has to be published again.
                        if let (Some(room), Some(source)) = (voice.room.clone(), voice.mic_source.clone()) {
                            if room.mic_source().is_none() {
                                let muted = voice.mic_off();
                                crate::host::tokio().spawn(async move { room.publish_mic(source, 0, muted).await.ok() });
                            }
                        }
                    }
                    Err(problem) => log::warn!("voice microphone: {problem}"),
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    pub(super) fn on_room_event(&mut self, mine: u64, event: Event, cx: &mut Context<Self>) {
        if mine != self.attempt {
            return;
        }
        match event {
            Event::Status(room::Status::Connected) => {
                self.reconnects = 0;
                self.status = VoiceStatus::Connected;
            }
            Event::Status(room::Status::Reconnecting) => self.status = VoiceStatus::Reconnecting,
            Event::Closed(reason) => self.on_closed(reason, cx),
            Event::Media => self.sync_videos(cx),
            Event::Speaking(users) => self.speaking = users,
            Event::Quality(quality) => self.quality = quality,
            Event::Participants(came, left) => {
                if came.is_some() || left.is_some() {
                    self.sound(if came.is_some() { VoiceSound::Join } else { VoiceSound::Leave });
                }
            }
            Event::Permissions => self.on_permissions(cx),
        }
        cx.notify();
    }

    /// An admin muted or unmuted this person, which takes the microphone away or lets it back.
    pub(super) fn on_permissions(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.room.clone() else { return };
        let muted = !room.may_publish(room::MICROPHONE_SOURCE);
        room.server_muted.store(muted, std::sync::atomic::Ordering::Relaxed);
        if muted {
            crate::host::tokio().spawn(async move { room.unpublish_mic().await });
        } else if let Some(source) = self.mic_source.clone() {
            let off = self.mic_off();
            crate::host::tokio().spawn(async move { room.publish_mic(source, 0, off).await.ok() });
        }
        cx.notify();
    }

    /// What to do when the room goes away without anyone asking: try coming back, as far as that's worth it.
    pub(super) fn on_closed(&mut self, reason: Option<livekit::DisconnectReason>, cx: &mut Context<Self>) {
        use livekit::DisconnectReason as Reason;
        let (server_id, channel_id) = (self.server_id.clone(), self.channel_id.clone());
        self.close_room();
        // Coming back shares nothing until someone asks again, and the server knows that from the new connection.
        self.screen = None;
        let (Some(server_id), Some(channel_id)) = (server_id, channel_id) else { return };
        if matches!(reason, Some(Reason::ParticipantRemoved | Reason::RoomDeleted | Reason::DuplicateIdentity | Reason::ClientInitiated)) {
            self.leave(cx);
            return;
        }
        if self.reconnects >= RECONNECT_ATTEMPTS {
            self.toast("Lost the connection to voice.", ToastKind::Error, cx);
            self.leave(cx);
            return;
        }
        self.reconnects += 1;
        self.status = VoiceStatus::Reconnecting;
        self.attempt += 1;
        let mine = self.attempt;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RECONNECT_WAIT).await;
            this.update(cx, |voice, cx| {
                if mine == voice.attempt {
                    voice.connect(server_id, channel_id, mine, JoinHow::default(), cx);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Calls the people in a conversation, starting a direct message if nobody's written in it yet.
    pub fn start_call(&mut self, server_id: String, conversation_key: String, camera: bool, cx: &mut Context<Self>) {
        let call = self.core(cx).call(Some(&server_id), "prepareCall", vec![json!(conversation_key)]);
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |voice, cx| match result {
                Ok(group) => {
                    let group_id = group.as_str().unwrap_or_default().to_string();
                    // Someone else may have called meanwhile, which this joins rather than ringing anyone.
                    let going = voice.state.read(cx).servers.get(&server_id).is_some_and(|server| server.voice.values().any(|member| member.channel_id == group_id));
                    voice.join(server_id, group_id, None, JoinHow { ring: !going, camera }, cx);
                }
                Err(error) => voice.toast(if error.message.is_empty() { "Couldn't start the call.".to_string() } else { error.message }, ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Stops a call ringing on all this person's devices.
    pub fn decline(&mut self, server_id: &str, group_id: &str, cx: &mut Context<Self>) {
        let call = self.core(cx).call(Some(server_id), "declineCall", vec![json!(group_id)]);
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Err(error) = call.await {
                state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
            }
        })
        .detach();
    }

    /// Rings everyone in the call's conversation who isn't in it.
    pub fn ring_again(&mut self, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        if !self.call {
            return;
        }
        let call = self.core(cx).call(Some(&server_id), "ringCall", vec![json!(channel_id), json!([])]);
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            if let Err(error) = call.await {
                state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
            }
        })
        .detach();
    }

    pub fn leave(&mut self, cx: &mut Context<Self>) {
        if self.status == VoiceStatus::Idle {
            return;
        }
        let (server_id, channel_id) = (self.server_id.clone(), self.channel_id.clone());
        self.attempt += 1;
        self.close_room();
        if let Some(server_id) = &server_id {
            let call = self.core(cx).call(Some(server_id), "setVoiceState", vec![Value::Null, Value::Null]);
            cx.background_executor().spawn(async move { call.await.ok() }).detach();
        }
        self.reset();
        self.close_stage(server_id, channel_id, cx);
        self.sound(VoiceSound::SelfLeave);
        self.update_ringing(cx);
        self.update_ptt(cx);
        cx.notify();
    }
}
