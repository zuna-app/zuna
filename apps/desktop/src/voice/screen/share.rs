//! Starting and stopping this device's share in the room it's in, from this device's own
//! connection: captured and encoded on the GPU here (`zuna-screenshare`), or on macOS through
//! ScreenCaptureKit, with the computer's sound beside it.

use super::*;

impl Voice {
    pub(in crate::voice) fn stop_share_handles(&mut self) {
        #[cfg(not(target_os = "macos"))]
        let sharing = self.share.native.take().inspect(|native| native.stop()).is_some();
        #[cfg(target_os = "macos")]
        let sharing = self.share.capture.take().inspect(|_| crate::platform::screen_capture::picked_done()).is_some();
        if let Some(sound) = self.share.sound.take() {
            sound.stop();
        }
        if let (true, Some(room)) = (sharing, self.room.clone()) {
            crate::host::tokio().spawn(async move { room.stop_share_video().await });
        }
        self.share = ShareHandles::default();
    }

    /// Stops what this device is sharing, if anything. A server that stopped it has already given up its place.
    pub(super) fn end_share(&mut self, give_up_place: bool, cx: &mut Context<Self>) {
        if self.screen.take().is_none() {
            return;
        }
        self.stop_share_handles();
        if let Some(room) = self.room.clone() {
            crate::host::tokio().spawn(async move { room.stop_share_sound().await });
        }
        if give_up_place {
            if let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) {
                let call = self.core(cx).call(Some(&server_id), "voiceScreenStop", vec![json!(channel_id)]);
                cx.background_executor().spawn(async move { call.await.ok() }).detach();
            }
        }
        self.announce(cx);
        self.sound(VoiceSound::SelfLeave);
        cx.notify();
    }

    /// Stops what this device is sharing.
    pub fn stop_screen(&mut self, cx: &mut Context<Self>) {
        self.end_share(true, cx);
    }

    /// This device's screen share has been stopped: by an admin, or by a change to the rules.
    pub fn on_screen_ended(&mut self, server_id: &str, channel_id: &str, reason: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) || self.screen.is_none() {
            return;
        }
        self.end_share(false, cx);
        self.toast(if reason == "stopped" { "An admin stopped your screen share." } else { "This server's rules changed, so your screen share stopped." }, ToastKind::Info, cx);
    }

    /// Shares a screen or a window, natively, once the server says it may.
    pub fn start_screen(&mut self, choice: ScreenChoice, cx: &mut Context<Self>) {
        let (Some(room), Some(server_id), Some(channel_id)) = (self.room.clone(), self.server_id.clone(), self.channel_id.clone()) else { return };
        if self.screen.is_some() {
            return;
        }
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&server_id) else { return };
        let rules = server.info.as_ref().and_then(|info| info.screen_share.clone());
        let role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let settings = self.settings.clone();
        let terms = screen_terms(&ScreenChoices { height: settings.screen_height, fps: settings.screen_fps, kbps: settings.screen_bitrate, sound_kbps: settings.screen_sound_kbps }, rules.as_ref(), &role);
        let wants_sound = choice.audio && terms.sound;
        let held = terms
            .held
            .iter()
            .map(|held| match held {
                Held::Height => height_name(terms.height),
                Held::Fps => rate_name(terms.fps),
                Held::Kbps => bitrate_name(terms.kbps),
                Held::SoundKbps => format!("{} of sound", bitrate_name(terms.sound_kbps)),
            })
            .collect::<Vec<_>>();
        let share = ShareInfo { name: choice.source.name.clone(), fps: terms.fps, kbps: terms.kbps, height: terms.height, held, info: None };
        let core = self.core(cx);
        #[cfg(target_os = "macos")]
        self.start_screen_here(choice, terms, share, core, room, server_id, channel_id, wants_sound, settings.screen_cursor, cx);
        #[cfg(not(target_os = "macos"))]
        self.start_screen_native(choice, terms, share, core, room, server_id, channel_id, wants_sound, &settings, cx);
    }

    /// On Windows and Linux: captured and encoded on the GPU on a thread of its own, after the
    /// portal's dialog on Linux, each frame handed to LiveKit already encoded.
    #[cfg(not(target_os = "macos"))]
    #[allow(clippy::too_many_arguments)]
    fn start_screen_native(&mut self, choice: ScreenChoice, terms: crate::voice::rules::ScreenTerms, share: ShareInfo, core: crate::host::Core, room: Arc<VoiceRoom>, server_id: String, channel_id: String, wants_sound: bool, settings: &crate::voice::settings::VoiceSettings, cx: &mut Context<Self>) {
        use zuna_screenshare::{Codec, Event, Options, Quality, Share, Source};
        let encoder = settings.screen_encoder.as_str();
        let codec = if settings.screen_codec == "av1" { Codec::Av1 } else { Codec::H264 };
        let options = Options {
            codec,
            // The encoder's family, which goes for either codec.
            encoder: if ["auto", "h264_nvenc", "h264_amf", "h264_mf", "h264_vaapi"].contains(&encoder) { encoder.into() } else { "auto".into() },
            quality: match settings.screen_effort.as_str() {
                "speed" => Quality::Speed,
                "best" => Quality::Best,
                _ => Quality::Balanced,
            },
            fps: terms.fps.max(1),
            bitrate_kbps: terms.kbps.max(1) as u64,
            // A screen, or where the system's own dialog picks, a window.
            source: if choice.source.screen { Source::Screen } else { Source::Window },
            monitor_at: choice.source.monitor_at(),
            window: choice.source.window(),
            cursor: settings.screen_cursor,
            max_height: (terms.height > 0).then_some(terms.height),
            ..Options::default()
        };
        cx.spawn(async move |this, cx| {
            let access = core.call(Some(&server_id), "voiceScreenAccess", vec![json!(channel_id), json!({ "sound": wants_sound })]).await;
            let access = match access {
                Ok(access) => access,
                Err(error) => {
                    this.update(cx, |voice, cx| voice.toast(error.message, ToastKind::Error, cx)).ok();
                    return;
                }
            };
            let sound_allowed = access.get("sound").and_then(Value::as_bool).unwrap_or(false);
            let (events, mut said) = unbounded::<Event>();
            let native = match Share::start(options, move |event| {
                events.unbounded_send(event).ok();
            }) {
                Ok(native) => native,
                Err(problem) => {
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            };
            // Waits for it to say it's capturing, or to stop.
            let ready = {
                let timeout = cx.background_executor().timer(START_TIMEOUT);
                futures::pin_mut!(timeout);
                loop {
                    let next = said.next();
                    futures::pin_mut!(next);
                    match futures::future::select(next, &mut timeout).await {
                        futures::future::Either::Left((Some(Event::Ready(ready)), _)) => break Ok(ready),
                        futures::future::Either::Left((Some(Event::Stats(_)), _)) => continue,
                        futures::future::Either::Left((Some(Event::Ended(problem)), _)) => break Err(problem.unwrap_or_else(|| "It stopped by itself.".into())),
                        futures::future::Either::Left((None, _)) => break Err("It stopped by itself.".into()),
                        futures::future::Either::Right(_) => break Err("It took too long to start.".into()),
                    }
                }
            };
            let ready = match ready {
                Ok(ready) => ready,
                Err(problem) => {
                    native.stop();
                    // FFmpeg's word for a card without AV1 says nothing of what to do about it.
                    let problem = if codec == Codec::Av1 && problem.starts_with("Opening av1_") { format!("This graphics card may not encode AV1, so try H.264 in Settings, Screen sharing. {problem}") } else { problem };
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            };
            // The media server lets this connection share once the chat server has told it.
            let waited = std::time::Instant::now();
            while !room.may_publish(SCREEN_SOURCE) && waited.elapsed() < SHARE_PERMISSION_WAIT {
                cx.background_executor().timer(Duration::from_millis(100)).await;
            }
            let publishing = room.clone();
            let (width, height, fps, kbps) = (ready.width, ready.height, terms.fps, terms.kbps);
            let track_codec = match ready.codec {
                Codec::H264 => livekit::options::VideoCodec::H264,
                Codec::Av1 => livekit::options::VideoCodec::AV1,
            };
            let source = crate::host::tokio().spawn(async move { publishing.start_share_video(width, height, fps, kbps, track_codec).await }).await.map_err(|error| error.to_string()).and_then(|result| result);
            match source {
                Ok(source) => native.publish(Box::new(LiveKitOutput(source))),
                Err(problem) => {
                    native.stop();
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            }
            // A window's title is in the description, and could be anything.
            let info = json!({ "description": ready.description, "source": ready.source, "codec": ready.codec.name(), "width": width, "height": height, "fps": fps, "e2ee": room.encrypted(), "idrFix": ready.codec == Codec::H264 });
            let ok = this
                .update(cx, |voice, cx| {
                    if voice.room.as_ref().is_none_or(|current| !Arc::ptr_eq(current, &room)) {
                        native.stop();
                        let stopping = room.clone();
                        crate::host::tokio().spawn(async move { stopping.stop_share_video().await });
                        return false;
                    }
                    voice.share.native = Some(native);
                    voice.screen = Some(ShareInfo { info: Some(info), ..share.clone() });
                    voice.share.watch = Some(cx.spawn(async move |this, cx| {
                        while let Some(event) = said.next().await {
                            let going = this
                                .update(cx, |voice, cx| match event {
                                    Event::Stats(stats) => {
                                        voice.share.stats = Some(stats);
                                        true
                                    }
                                    Event::Ended(problem) => {
                                        if voice.screen.is_some() {
                                            voice.end_share(true, cx);
                                            if let Some(problem) = problem {
                                                voice.toast(format!("Your screen share stopped: {}", problem.chars().take(200).collect::<String>()), ToastKind::Error, cx);
                                            }
                                        }
                                        false
                                    }
                                    Event::Ready(_) => true,
                                })
                                .unwrap_or(false);
                            if !going {
                                break;
                            }
                        }
                    }));
                    voice.announce(cx);
                    voice.sound(VoiceSound::SelfJoin);
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            log::info!("screen share publishing from this connection, {width}×{height}, sound {}", if sound_allowed { "allowed" } else { "not allowed" });
            if ok && sound_allowed {
                // The media server allows the sound once the chat server has told it.
                let waited = std::time::Instant::now();
                while !room.may_publish(SCREEN_SOUND_SOURCE) && waited.elapsed() < SHARE_PERMISSION_WAIT {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                }
                this.update(cx, |voice, cx| voice.start_share_sound(room.clone(), terms.sound_kbps, choice.sound_app.clone(), cx)).ok();
            }
        })
        .detach();
    }

    /// On macOS: macOS's picker chooses, the app captures with ScreenCaptureKit, and the picture
    /// goes from this device's own connection, as Chromium's did from the Electron app there,
    /// each frame handed to VideoToolbox as it was captured, in an IOSurface.
    #[cfg(target_os = "macos")]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn start_screen_here(&mut self, choice: ScreenChoice, terms: crate::voice::rules::ScreenTerms, share: ShareInfo, core: crate::host::Core, room: Arc<VoiceRoom>, server_id: String, channel_id: String, wants_sound: bool, cursor: bool, cx: &mut Context<Self>) {
        use crate::platform::screen_capture as capture;
        use livekit::webrtc::prelude::{VideoFrame, VideoRotation};
        use livekit::webrtc::video_frame::native::NativeBuffer;
        // Shown now, from the window's thread, where macOS's picker belongs.
        let picking = (!capture::fake()).then(|| capture::pick(!choice.source.screen));
        cx.spawn(async move |this, cx| {
            let picked = match picking {
                Some(picking) => match cx.background_executor().spawn(async move { picking.recv().ok() }).await {
                    Some(Ok(picked)) => Some(picked),
                    // Cancelled, with nothing to say, or the picker couldn't start.
                    Some(Err(problem)) => {
                        capture::picked_done();
                        if !problem.is_empty() {
                            this.update(cx, |voice, cx| voice.toast(format!("Couldn't share your screen. {problem}"), ToastKind::Error, cx)).ok();
                        }
                        return;
                    }
                    None => return,
                },
                None => None,
            };
            let access = core.call(Some(&server_id), "voiceScreenAccess", vec![json!(channel_id), json!({ "sound": wants_sound })]).await;
            let access = match access {
                Ok(access) => access,
                Err(error) => {
                    capture::picked_done();
                    this.update(cx, |voice, cx| voice.toast(error.message, ToastKind::Error, cx)).ok();
                    return;
                }
            };
            let sound_allowed = access.get("sound").and_then(Value::as_bool).unwrap_or(false);
            // The media server lets this connection share once the chat server has told it.
            let waited = std::time::Instant::now();
            while !room.may_publish(SCREEN_SOURCE) && waited.elapsed() < SHARE_PERMISSION_WAIT {
                cx.background_executor().timer(Duration::from_millis(100)).await;
            }
            let (width, height) = match &picked {
                Some(picked) => capture::size(picked, terms.height),
                None => capture::fake_size(terms.height),
            };
            let publishing = room.clone();
            let (fps, kbps) = (terms.fps, terms.kbps);
            let source = crate::host::tokio().spawn(async move { publishing.start_share_video(width, height, fps, kbps, livekit::options::VideoCodec::H264).await }).await.map_err(|error| error.to_string()).and_then(|result| result);
            let source = match source {
                Ok(source) => source,
                Err(problem) => {
                    capture::picked_done();
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            };
            let send = move |picture: capture::Picture| {
                let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|since| since.as_micros() as i64).unwrap_or(0);
                // SAFETY: the buffer comes with a reference of its own, which LiveKit takes.
                let buffer = unsafe { NativeBuffer::from_cv_pixel_buffer(capture::into_native(picture)) };
                source.capture_frame(&VideoFrame { rotation: VideoRotation::VideoRotation0, timestamp_us: at, frame_metadata: None, buffer });
            };
            let (stopped, mut ended) = unbounded::<Option<String>>();
            let running = match picked {
                Some(picked) => capture::capture(picked, terms.height, fps, cursor, send, move |problem| {
                    stopped.unbounded_send(problem).ok();
                }),
                None => Ok(capture::capture_fake(terms.height, fps, send)),
            };
            let running = match running {
                Ok(running) => running,
                Err(problem) => {
                    capture::picked_done();
                    let stopping = room.clone();
                    crate::host::tokio().spawn(async move { stopping.stop_share_video().await });
                    this.update(cx, |voice, cx| voice.share_failed(&server_id, &channel_id, problem, cx)).ok();
                    return;
                }
            };
            let ok = this
                .update(cx, |voice, cx| {
                    if voice.room.as_ref().is_none_or(|current| !Arc::ptr_eq(current, &room)) {
                        drop(running);
                        let stopping = room.clone();
                        crate::host::tokio().spawn(async move { stopping.stop_share_video().await });
                        return false;
                    }
                    voice.share.capture = Some(running);
                    voice.screen = Some(share.clone());
                    // macOS ends it as the picked window closes, or from Stop in the menu bar.
                    voice.share.watch = Some(cx.spawn(async move |this, cx| {
                        if let Some(problem) = ended.next().await {
                            this.update(cx, |voice, cx| {
                                if voice.share.capture.is_some() {
                                    voice.end_share(true, cx);
                                    if let Some(problem) = problem {
                                        voice.toast(format!("Your screen share stopped: {problem}"), ToastKind::Error, cx);
                                    }
                                }
                            })
                            .ok();
                        }
                    }));
                    voice.announce(cx);
                    voice.sound(VoiceSound::SelfJoin);
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            log::info!("screen share publishing from this connection, {width}×{height}, sound {}", if sound_allowed { "allowed" } else { "not allowed" });
            if ok && sound_allowed {
                let waited = std::time::Instant::now();
                while !room.may_publish(SCREEN_SOUND_SOURCE) && waited.elapsed() < SHARE_PERMISSION_WAIT {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                }
                this.update(cx, |voice, cx| voice.start_share_sound(room.clone(), terms.sound_kbps, choice.sound_app.clone(), cx)).ok();
            }
        })
        .detach();
    }

    pub(super) fn share_failed(&mut self, server_id: &str, channel_id: &str, problem: String, cx: &mut Context<Self>) {
        log::warn!("the screen share didn't start: {problem}");
        let call = self.core(cx).call(Some(server_id), "voiceScreenStop", vec![json!(channel_id)]);
        cx.background_executor().spawn(async move { call.await.ok() }).detach();
        self.toast(format!("Couldn't share your screen. {}", problem.chars().take(200).collect::<String>()), ToastKind::Error, cx);
    }

    /// Sends the computer's sound beside a share. A share without its sound is still worth having, so this only says so.
    pub(super) fn start_share_sound(&mut self, room: Arc<VoiceRoom>, kbps: u32, app: Option<String>, cx: &mut Context<Self>) {
        if self.screen.is_none() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let publishing = room.clone();
            let source = crate::host::tokio().spawn(async move { publishing.start_share_sound(kbps as u64).await }).await.map_err(|error| error.to_string()).and_then(|result| result);
            log::info!("screen share sound track: {}", if source.is_ok() { "published" } else { "refused" });
            let started = match source {
                Ok(source) => cx.background_executor().spawn(async move { start_sound(app.as_deref(), source) }).await,
                Err(error) => Err(error),
            };
            this.update(cx, |voice, cx| match started {
                Ok((sound, mut ended)) => {
                    if voice.screen.is_none() {
                        sound.stop();
                        return;
                    }
                    log::info!("sharing the computer's sound beside the screen");
                    voice.share.sound = Some(sound);
                    voice.share.sound_watch = Some(cx.spawn(async move |this, cx| {
                        if let Some(problem) = ended.next().await {
                            this.update(cx, |voice, cx| {
                                if let Some(sound) = voice.share.sound.take() {
                                    sound.stop();
                                }
                                if let Some(room) = voice.room.clone() {
                                    crate::host::tokio().spawn(async move { room.stop_share_sound().await });
                                }
                                voice.toast(format!("Your screen's sound stopped: {problem}"), ToastKind::Error, cx);
                            })
                            .ok();
                        }
                    }));
                }
                Err(error) => {
                    log::warn!("sharing the computer's sound: {error}");
                    let room = room.clone();
                    crate::host::tokio().spawn(async move { room.stop_share_sound().await });
                    voice.toast("Your screen is being shared without its sound.", ToastKind::Info, cx);
                }
            })
            .ok();
        })
        .detach();
    }
}
