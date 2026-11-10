//! What the core says of voice channels and calls: keys, who's in them, calls ringing, and
//! endings.

use super::*;

impl Voice {
    /// Rings for a call coming in, or for the one calling while it rings the others and nobody else has come.
    pub fn update_ringing(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        let incoming = incoming_calls(state, self.server_id.as_deref(), self.channel_id.as_deref());
        let server = self.server_id.as_ref().and_then(|id| state.servers.get(id));
        let self_id = server.map(|server| server.self_id().to_string()).unwrap_or_default();
        let ringing_others = self.call
            && self.status == VoiceStatus::Connected
            && self.channel_id.as_ref().is_some_and(|room| {
                server.is_some_and(|server| server.calls.get(room).is_some_and(|call| !call.ringing.is_empty()) && !server.voice.values().any(|member| &member.channel_id == room && member.user_id != self_id))
            });
        let ring = if incoming.iter().any(|item| !item.quiet) {
            Some(Ringing::Incoming)
        } else if ringing_others {
            Some(Ringing::Outgoing)
        } else {
            None
        };
        if ring == self.ringing {
            return;
        }
        self.ringing = ring;
        self.ring_task = None;
        let Some(kind) = ring else { return };
        // Held for as long as it rings, as it's quiet between one ring and the next.
        let hold = self.mixer.hold(&self.settings.output_device);
        let (every, samples) = sounds::ring(kind, self.settings.output_volume.min(1.));
        let mixer = self.mixer.clone();
        let executor = cx.background_executor().clone();
        self.ring_task = Some(cx.background_executor().spawn(async move {
            let _hold = hold;
            loop {
                mixer.once(samples.clone(), 1.);
                executor.timer(Duration::from_millis(every)).await;
            }
        }));
    }

    // --- What the core says ---

    /// Who's in the voice channel this device is in changed, so its media key did too.
    pub fn on_key(&mut self, server_id: &str, channel_id: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        let Some(room) = self.room.clone() else { return };
        let call = self.core(cx).call(Some(server_id), "voiceKey", vec![json!(channel_id)]);
        cx.background_executor()
            .spawn(async move {
                match call.await {
                    Ok(key) => {
                        let epoch = key.get("epoch").and_then(Value::as_u64).unwrap_or(0);
                        if let Some(bytes) = key.get("key").and_then(read_bytes) {
                            room.update_keys(epoch, bytes, false);
                        }
                    }
                    Err(error) => log::warn!("voice keys: {}", error.message),
                }
            })
            .detach();
    }

    /// This device has been taken out of a voice channel or a call.
    pub fn on_ended(&mut self, server_id: &str, channel_id: &str, reason: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        self.attempt += 1;
        self.close_room();
        self.reset();
        self.close_stage(Some(server_id.to_string()), Some(channel_id.to_string()), cx);
        let was_call = !self.state.read(cx).servers.get(server_id).is_some_and(|server| server.channels.iter().any(|channel| channel.id == channel_id));
        let message = match (was_call, reason) {
            (false, "elsewhere") => "You joined this voice channel on another device.",
            (false, "disconnected") => "An admin took you out of the voice channel.",
            (false, "deleted") => "That voice channel was deleted.",
            (_, "banned") => "You were removed from this server.",
            (true, "elsewhere") => "You joined this call on another device.",
            (true, "removed") => "You're no longer in this conversation, so you left its call.",
            (true, "deleted") => "That conversation was deleted.",
            (true, _) => "You left the call.",
            (false, _) => "You left the voice channel.",
        };
        self.toast(message, ToastKind::Info, cx);
        self.sound(VoiceSound::SelfLeave);
        self.update_ringing(cx);
        self.update_ptt(cx);
        cx.notify();
    }

    /// A direct message's call that nobody answers ends by itself, as a phone call does.
    pub fn on_call(&mut self, server_id: &str, group_id: &str, call: Option<CallView>, cx: &mut Context<Self>) {
        self.update_ringing(cx);
        let Some(call) = call else { return };
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(group_id) || self.status == VoiceStatus::Idle {
            return;
        }
        if !call.ringing.is_empty() {
            self.call_rang = true;
            return;
        }
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(server_id) else { return };
        let self_id = server.self_id().to_string();
        let Some(conversation) = conversation_of_group(server, group_id) else { return };
        if !self.call_rang || conversation.kind != "dm" || call.started_by != self_id {
            return;
        }
        if server.voice.values().any(|member| member.channel_id == group_id && member.user_id != self_id) {
            return;
        }
        let name = conversation.peer_id.as_ref().and_then(|peer| server.users.get(peer)).map(|user| user.display_name.clone()).unwrap_or_else(|| conversation.title.clone());
        let declined = conversation.peer_id.as_ref().is_some_and(|peer| call.declined.contains(peer));
        self.leave(cx);
        self.toast(if declined { format!("{name} declined the call.") } else { format!("{name} didn't answer.") }, ToastKind::Info, cx);
    }

    /// Being muted by an admin, or no longer, comes with the rest of what's said about this device.
    pub fn on_member(&mut self, server_id: &str, member: &VoiceMember, cx: &mut Context<Self>) {
        self.update_ringing(cx);
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(member.channel_id.as_str()) {
            return;
        }
        let device = self.state.read(cx).servers.get(server_id).and_then(|server| server.me.as_ref()).map(|me| me.device_id.clone()).unwrap_or_default();
        if member.device_id != device || member.server_muted == self.server_muted {
            return;
        }
        self.server_muted = member.server_muted;
        self.apply_mute(cx);
        self.toast(if member.server_muted { "An admin muted you." } else { "An admin unmuted you." }, ToastKind::Info, cx);
        self.sound(if member.server_muted { VoiceSound::Mute } else { VoiceSound::Unmute });
        cx.notify();
    }

    /// And once the other person in a direct message's call hangs up, it's over.
    pub fn on_left(&mut self, server_id: &str, channel_id: &str, user_id: &str, cx: &mut Context<Self>) {
        self.update_ringing(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(server_id) else { return };
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) || self.status == VoiceStatus::Idle || user_id == server.self_id() {
            return;
        }
        if conversation_of_group(server, channel_id).is_none_or(|conversation| conversation.kind != "dm") {
            return;
        }
        let (server_id, channel_id) = (server_id.to_string(), channel_id.to_string());
        self.hang_up = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(PEER_GONE).await;
            this.update(cx, |voice, cx| {
                if voice.server_id.as_deref() != Some(&server_id) || voice.channel_id.as_deref() != Some(&channel_id) {
                    return;
                }
                let state = voice.state.read(cx);
                let alone = state.servers.get(&server_id).is_none_or(|server| {
                    let self_id = server.self_id();
                    !server.voice.values().any(|member| member.channel_id == channel_id && member.user_id != self_id)
                });
                if alone {
                    voice.leave(cx);
                }
            })
            .ok();
        }));
    }

    /// Someone else in the voice channel or call this device is in played a sound from the soundboard.
    pub fn on_sound(&mut self, server_id: &str, channel_id: &str, user_id: &str, sound_id: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() != Some(server_id) || self.channel_id.as_deref() != Some(channel_id) {
            return;
        }
        self.play_here(server_id.to_string(), sound_id.to_string(), user_id.to_string(), cx);
    }

    /// This device is no longer on a server, so it can't be in any of its voice channels.
    pub fn on_server_gone(&mut self, server_id: &str, cx: &mut Context<Self>) {
        if self.server_id.as_deref() == Some(server_id) {
            self.leave(cx);
        }
        self.update_ringing(cx);
    }
}
