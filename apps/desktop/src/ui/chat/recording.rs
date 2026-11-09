//! Recording voice and round video messages from the message box.

use super::*;

impl ChatView {
    pub(super) fn start_voice(&mut self, cx: &mut Context<Self>) {
        match crate::media::record::Microphone::start() {
            Ok(microphone) => {
                self.recording = Some(Recording::Voice(microphone));
                self.tick_recording(cx);
            }
            Err(error) => self.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx)),
        }
        cx.notify();
    }

    pub(super) fn start_round(&mut self, cx: &mut Context<Self>) {
        let path = crate::host::cache_dir().join("media").join(format!("round-{}.mp4", now_ms() as u64));
        std::fs::create_dir_all(path.parent().unwrap()).ok();
        match crate::media::record::RoundRecorder::start(path) {
            Ok(recorder) => {
                self.recording = Some(Recording::Round(recorder));
                self.tick_recording(cx);
            }
            Err(error) => self.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx)),
        }
        cx.notify();
    }

    /// Draws the time and the bars as it records, and sends what reaches its limit.
    pub(super) fn tick_recording(&mut self, cx: &mut Context<Self>) {
        self.recording_tick = Some(cx.spawn(async move |view, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            let going = view
                .update(cx, |view, cx| {
                    let over = match &view.recording {
                        Some(Recording::Voice(microphone)) => microphone.elapsed() >= MAX_VOICE_SECONDS,
                        Some(Recording::Round(recorder)) => recorder.elapsed() >= crate::media::record::MAX_ROUND_SECONDS,
                        None => return false,
                    };
                    if over {
                        view.send_recording(cx);
                        return false;
                    }
                    cx.notify();
                    true
                })
                .unwrap_or(false);
            if !going {
                break;
            }
        }));
    }

    pub(super) fn cancel_recording(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.recording = None;
        self.recording_tick = None;
        self.composer.focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    /// Sends what was recorded, written away from the window. A click straight back isn't a message.
    pub(super) fn send_recording(&mut self, cx: &mut Context<Self>) {
        let Some(recording) = self.recording.take() else { return };
        self.recording_tick = None;
        let Some(conversation) = self.conversation(cx) else { return };
        let key = conversation.key.clone();
        let list_id = conversation.list_id();
        let reply = self.state.read(cx).reply_to.get(&list_id).map(|message| message.id.clone());
        let server_id = self.server_id.clone();
        let is_admin = self.state.read(cx).servers.get(&self.server_id).is_some_and(|server| conversation.is_admin(&server.self_id()));
        if conversation.slow_mode > 0. && !is_admin {
            self.sent_until = now_ms() + conversation.slow_mode * 1000.;
        }
        self.state.update(cx, |state, cx| state.set_reply(&list_id, None, cx));
        cx.spawn(async move |view, cx| {
            // The file to send, and where it was recorded, which goes once it's sent.
            let prepared: Result<Option<(serde_json::Value, std::path::PathBuf)>, String> = cx
                .background_executor()
                .spawn(async move {
                    match recording {
                        Recording::Voice(microphone) => {
                            let (samples, levels) = microphone.stop();
                            let duration = samples.len() as f64 / crate::media::encode::RATE as f64;
                            if duration < 0.5 {
                                return Ok(None);
                            }
                            let path = crate::host::cache_dir().join("media").join(format!("voice-{}.m4a", now_ms() as u64));
                            std::fs::create_dir_all(path.parent().unwrap()).ok();
                            crate::media::encode::write_voice(&path, &samples).map_err(|_| "The voice message couldn't be recorded.".to_string())?;
                            let file = json!({
                                "blob": crate::host::file(&path.to_string_lossy(), "audio/mp4"),
                                "name": "Voice message.m4a",
                                "mime": "audio/mp4",
                                "duration": duration,
                                "voice": true,
                                "waveform": crate::media::record::encode_waveform(&levels),
                            });
                            Ok(Some((file, path)))
                        }
                        Recording::Round(recorder) => {
                            let path = recorder.path.clone();
                            let duration = recorder.stop()?;
                            if duration < 0.5 {
                                return Ok(None);
                            }
                            let thumb = crate::media::mf::poster(&path, 0., 160, 50).map(|(jpeg, _, _)| {
                                use base64::Engine;
                                format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg))
                            });
                            let size = crate::media::encode::ROUND_SIZE;
                            let file = json!({
                                "blob": crate::host::file(&path.to_string_lossy(), "video/mp4"),
                                "name": "Video message.mp4",
                                "mime": "video/mp4",
                                "width": size,
                                "height": size,
                                "duration": duration,
                                "thumb": thumb,
                                "round": true,
                            });
                            Ok(Some((file, path)))
                        }
                    }
                })
                .await;
            view.update(cx, |view, cx| {
                match prepared {
                    Ok(Some((file, recorded))) => {
                        let mut body = json!({});
                        if let Some(reply) = reply {
                            body["replyTo"] = json!(reply);
                        }
                        view.state.update(cx, |state, cx| {
                            state.call(Some(&server_id), "sendWithAttachments", vec![json!(key), json!([file]), body], cx, move |state, result, cx| match result {
                                // It's been uploaded, sealed, and is the server's to keep now.
                                Ok(_) => {
                                    std::fs::remove_file(&recorded).ok();
                                }
                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                            })
                        });
                    }
                    Ok(None) => {}
                    Err(error) => view.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The row in place of the message box while recording: delete, the time, the bars, send.
    pub(super) fn recording_row(&mut self, is_channel: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = theme(cx);
        let recording = self.recording.as_ref()?;
        let (elapsed, levels, round) = match recording {
            Recording::Voice(microphone) => (microphone.elapsed(), microphone.levels(60), false),
            Recording::Round(recorder) => (recorder.elapsed(), Vec::new(), true),
        };
        let mut bars = div().flex_1().h(px(24.)).flex().items_center().gap(px(2.)).overflow_hidden();
        for level in &levels {
            bars = bars.child(div().w(px(3.)).flex_none().h(gpui::relative((level * 1.).max(0.08))).rounded(px(2.)).bg(theme.text2));
        }
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .px(px(10.))
                .when(is_channel, |el| el.pl(px(8.)).min_h(px(44.)))
                .when(!is_channel, |el| el.py(px(8.)))
                .child(icon_button("delete-recording", "trash", 18., false, false, cx).tip("Delete recording", Side::Top).on_click(cx.listener(|view, _, window, cx| view.cancel_recording(window, cx))))
                // `.recording-dot`: 9 px, its opacity pulsing every 1.2 s.
                .child(crate::ui::motion::pulse(div().size(px(9.)).flex_none().rounded_full().bg(theme.red), "recording-dot", 1200, |el, t| el.opacity(1. - 0.65 * gpui::ease_in_out(1. - (t * 2. - 1.).abs()))))
                .child(div().text_size(px(13.)).text_color(theme.text1).child(crate::format::format_duration(elapsed)))
                .when(round, |el| el.child(div().flex_1().text_size(px(13.5)).text_color(theme.text2).child("Recording a video message")))
                .when(!round, |el| el.child(bars))
                .child(
                    div()
                        .id("send-recording")
                        .size(px(32.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(RADIUS_M)
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover_strong))
                        
                        .on_click(cx.listener(|view, _, _, cx| view.send_recording(cx)))
                        .child(icon("send-horizontal", 18., theme.text1)),
                )
                .into_any_element(),
        )
    }

    /// The camera while a video message is recorded, mirrored, with the minute going round.
    pub(super) fn round_preview(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = theme(cx);
        let Some(Recording::Round(recorder)) = &self.recording else { return None };
        let progress = (recorder.elapsed() / crate::media::record::MAX_ROUND_SECONDS).min(1.) as f32;
        if let Some(frame) = recorder.preview() {
            let size = crate::media::encode::ROUND_SIZE;
            if let Some(buffer) = image::RgbaImage::from_raw(size, size, frame) {
                let image = Arc::new(gpui::RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
                if let Some(old) = self.preview_frame.replace(image) {
                    self.retired_frames.push(old);
                }
            }
        }
        let accent = theme.accent;
        Some(
            div()
                .absolute()
                .right(px(18.))
                .bottom(gpui::relative(1.))
                .mb(px(14.))
                .size(px(240.))
                .rounded_full()
                .overflow_hidden()
                .bg(gpui::black())
                .shadow(shadow_m())
                .when_some(self.preview_frame.clone(), |el, frame| el.child(img(frame).size_full().object_fit(gpui::ObjectFit::Cover).rounded_full()))
                .child(
                    gpui::canvas(
                        |_, _, _| {},
                        move |bounds, _, window, _| {
                            let center = bounds.center();
                            let radius = bounds.size.width / 2. - px(2.5);
                            let mut path = gpui::PathBuilder::stroke(px(3.));
                            let steps = (progress * 120.).ceil().max(2.) as usize;
                            for step in 0..=steps {
                                let angle = -std::f32::consts::FRAC_PI_2 + progress * std::f32::consts::TAU * step as f32 / steps as f32;
                                let at = gpui::point(center.x + radius * angle.cos(), center.y + radius * angle.sin());
                                if step == 0 { path.move_to(at) } else { path.line_to(at) }
                            }
                            if let Ok(path) = path.build() {
                                window.paint_path(path, accent);
                            }
                        },
                    )
                    .absolute()
                    .inset_0(),
                )
                .into_any_element(),
        )
    }

    // --- Picking by dragging ---
}
