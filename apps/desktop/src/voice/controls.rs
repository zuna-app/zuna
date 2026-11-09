//! What the person does in the room: muting, deafening, the camera, volumes, push to talk, and
//! the soundboard.

use super::*;

impl Voice {
    pub fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        if self.no_mic || self.server_muted {
            return;
        }
        // Unmuting while deafened undoes both, as being deafened means hearing nothing and saying nothing.
        if self.deafened {
            self.deafened = false;
            self.muted = false;
            self.apply_volumes();
            self.apply_mute(cx);
            self.sound(VoiceSound::Undeafen);
            cx.notify();
            return;
        }
        let was = self.muted;
        self.muted = !was;
        self.apply_mute(cx);
        self.sound(if was { VoiceSound::Unmute } else { VoiceSound::Mute });
        cx.notify();
    }

    pub fn toggle_deafen(&mut self, cx: &mut Context<Self>) {
        let was = self.deafened;
        self.deafened = !was;
        self.apply_volumes();
        self.apply_mute(cx);
        self.sound(if was { VoiceSound::Undeafen } else { VoiceSound::Deafen });
        cx.notify();
    }

    pub fn toggle_camera(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.room.clone() else { return };
        let on = !self.camera;
        let device = self.settings.camera_device.clone();
        cx.spawn(async move |this, cx| {
            let result = crate::host::tokio().spawn(async move { room.set_camera(on, &device).await }).await.unwrap_or_else(|_| Err("There's no camera Zuna can use.".into()));
            this.update(cx, |voice, cx| {
                match result {
                    Ok(()) => {
                        voice.camera = on;
                        voice.announce(cx);
                    }
                    Err(error) => voice.toast(error, ToastKind::Error, cx),
                }
                voice.sync_videos(cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn set_volume(&mut self, user_id: &str, volume: f32, cx: &mut Context<Self>) {
        self.volumes.insert(user_id.to_string(), volume);
        self.save_soon(cx);
        self.apply_volumes();
        cx.notify();
    }

    pub fn set_stream_volume(&mut self, user_id: &str, volume: f32, cx: &mut Context<Self>) {
        self.stream_volumes.insert(user_id.to_string(), volume);
        self.save_soon(cx);
        self.apply_volumes();
        cx.notify();
    }

    /// Saves the settings and everyone's volumes once changes stop for a moment, off the
    /// window's thread, as a slider being dragged changes them many times a second.
    pub(super) fn save_soon(&mut self, cx: &mut Context<Self>) {
        self.save_task = Some(cx.spawn(async move |voice, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let Ok((settings, volumes, stream_volumes)) = voice.read_with(cx, |voice, _| (voice.settings.clone(), voice.volumes.clone(), voice.stream_volumes.clone())) else { return };
            cx.background_executor()
                .spawn(async move {
                    settings.save();
                    settings::save_volumes(&volumes, false);
                    settings::save_volumes(&stream_volumes, true);
                })
                .await;
        }));
    }

    pub fn toggle_local_mute(&mut self, user_id: &str, cx: &mut Context<Self>) {
        if !self.local_mutes.remove(user_id) {
            self.local_mutes.insert(user_id.to_string());
        }
        self.apply_volumes();
        cx.notify();
    }

    pub fn set_focus(&mut self, focus: Option<String>, cx: &mut Context<Self>) {
        self.focus = focus;
        cx.notify();
    }

    pub fn update_settings(&mut self, change: impl FnOnce(&mut VoiceSettings), cx: &mut Context<Self>) {
        let before = self.settings.clone();
        change(&mut self.settings);
        self.save_soon(cx);
        if before.output_device != self.settings.output_device && (self.status != VoiceStatus::Idle || self.ringing.is_some()) {
            self.mixer.open(&self.settings.output_device);
        }
        if self.mic.is_some() {
            if before.capture_key() != self.settings.capture_key() {
                self.reopen_mic(None, cx);
            } else if let Some(mic) = &self.mic {
                mic.apply(&self.settings);
            }
        }
        if let Some((mic, _)) = &self.mic_test {
            mic.apply(&self.settings);
        }
        self.apply_volumes();
        self.update_ptt(cx);
        cx.notify();
    }

    pub fn set_key_held(&mut self, down: bool, cx: &mut Context<Self>) {
        if self.key_held == down || self.settings.input_mode != "ptt" || self.status == VoiceStatus::Idle {
            return;
        }
        self.key_held = down;
        if let Some(mic) = &self.mic {
            mic.set_key(down);
        }
        if self.settings.sounds && !self.muted && !self.deafened {
            self.mixer.once(sounds::render(if down { VoiceSound::PttDown } else { VoiceSound::PttUp }, 0.4), 1.);
        }
        cx.notify();
    }

    // --- Soundboard ---

    /// Plays a sound from the soundboard to everyone in the voice channel or call, here too.
    pub fn play_sound(&mut self, sound_id: String, cx: &mut Context<Self>) {
        let (Some(server_id), Some(channel_id)) = (self.server_id.clone(), self.channel_id.clone()) else { return };
        let self_id = self.state.read(cx).servers.get(&server_id).map(|server| server.self_id().to_string()).unwrap_or_default();
        let call = self.core(cx).call(Some(&server_id), "playSound", vec![json!(channel_id), json!(sound_id)]);
        cx.spawn(async move |this, cx| {
            // The server says first whether it may be played, and only then does it play here.
            let result = call.await;
            this.update(cx, |voice, cx| match result {
                Ok(_) => voice.play_here(server_id, sound_id, self_id, cx),
                Err(error) => voice.toast(error.message, ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Plays a sound from the soundboard here, as someone played it, unless this device hears nothing
    /// of theirs: deafened, the person muted for this device, or the soundboard turned all the way down.
    pub(super) fn play_here(&mut self, server_id: String, sound_id: String, user_id: String, cx: &mut Context<Self>) {
        if self.room.is_none() || self.server_id.as_deref() != Some(&server_id) || self.deafened || self.local_mutes.contains(&user_id) || self.settings.soundboard_volume <= 0. {
            return;
        }
        let key = format!("{server_id}/{sound_id}");
        if let Some(samples) = self.sound_cache.get(&key).cloned() {
            self.play_samples(&server_id, &sound_id, &user_id, samples, cx);
            return;
        }
        let call = self.core(cx).call(Some(&server_id), "soundFile", vec![json!(sound_id)]);
        cx.spawn(async move |this, cx| {
            let file = call.await;
            let samples = file.ok().and_then(|value| crate::host::value_bytes(&value)).and_then(|bytes| decode_wav(&bytes));
            this.update(cx, |voice, cx| {
                let Some(samples) = samples else { return };
                let samples = Arc::new(samples);
                voice.sound_cache.insert(key, samples.clone());
                if voice.room.is_some() && !voice.deafened {
                    voice.play_samples(&server_id, &sound_id, &user_id, samples, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn play_samples(&mut self, server_id: &str, sound_id: &str, user_id: &str, samples: Arc<Vec<f32>>, cx: &mut Context<Self>) {
        let seconds = samples.len() as f64 / 2. / audio::RATE as f64;
        self.mixer.once(samples.as_ref().clone(), self.settings.output_volume * self.settings.soundboard_volume);
        let emoji = self.state.read(cx).servers.get(server_id).and_then(|server| server.sounds.iter().find(|sound| sound.id == sound_id)).map(|sound| sound.emoji.clone()).filter(|emoji| !emoji.is_empty()).unwrap_or_else(|| "🔊".into());
        self.sounding.insert(user_id.to_string(), emoji);
        let user = user_id.to_string();
        let hold = Duration::from_millis((seconds * 1000.) as u64 + SOUNDING_HOLD_MS);
        self.sounding_tasks.insert(
            user.clone(),
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(hold).await;
                this.update(cx, |voice, cx| {
                    voice.sounding.remove(&user);
                    voice.sounding_tasks.remove(&user);
                    cx.notify();
                })
                .ok();
            }),
        );
        cx.notify();
    }

    /// Plays a sound from the soundboard here only, outside any call, as when an admin listens to one.
    pub fn preview_sound(&mut self, server_id: String, sound_id: String, cx: &mut Context<Self>) {
        let volume = { let level = self.settings.output_volume * self.settings.soundboard_volume; if level > 0. { level } else { 0.6 } };
        let key = format!("{server_id}/{sound_id}");
        if let Some(samples) = self.sound_cache.get(&key).cloned() {
            self.mixer.open(&self.settings.output_device);
            self.mixer.once(samples.as_ref().clone(), volume);
            return;
        }
        let call = self.core(cx).call(Some(&server_id), "soundFile", vec![json!(sound_id)]);
        cx.spawn(async move |this, cx| {
            let samples = call.await.ok().and_then(|value| crate::host::value_bytes(&value)).and_then(|bytes| decode_wav(&bytes));
            this.update(cx, |voice, cx| match samples {
                Some(samples) => {
                    let samples = Arc::new(samples);
                    voice.sound_cache.insert(key, samples.clone());
                    voice.mixer.open(&voice.settings.output_device);
                    voice.mixer.once(samples.as_ref().clone(), volume);
                }
                None => voice.toast("That sound couldn't be played.", ToastKind::Error, cx),
            })
            .ok();
        })
        .detach();
    }

    // --- Ringing ---
}
