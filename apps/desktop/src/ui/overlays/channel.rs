//! Making a channel, or changing one.

use super::*;

impl Dialog {
    /// Making a channel, or changing one, for a server admin (ChannelDialog.tsx).
    pub(super) fn channel(&mut self, channel_id: Option<String>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let channel = channel_id.as_ref().and_then(|id| server.channels.iter().find(|item| item.id == *id)).cloned();
        let Some(form) = &self.channel_form else { return div().into_any_element() };
        let text = form.kind == "text";
        let final_name = if text { text_channel_name(self.name.read(cx).text()).trim_matches('-').to_string() } else { self.name.read(cx).text().trim().to_string() };
        let voice_ready = server.info.as_ref().is_some_and(|info| info.voice.is_some_and(|voice| voice > 0.));
        let mut body = Vec::new();
        if channel.is_none() {
            let choice = |kind: &'static str, icon_name: &'static str, title: &'static str, text: &'static str, active: bool, cx: &mut Context<Self>| {
                // Two equal columns, as `.channel-types`, the text wrapping inside each.
                named_div(kind)
                    .flex_1()
                    .flex_basis(px(0.))
                    .min_w_0()
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .p(px(10.))
                    .rounded(RADIUS_M)
                    .border_1()
                    .border_color(if active { theme.accent } else { theme.line_strong })
                    .when(active, |el| el.bg(theme.accent_soft))
                    .text_color(if active { theme.text1 } else { theme.text2 })
                    .cursor_pointer()
                    .hover(move |style| if active { style } else { style.bg(theme.hover) })
                    .on_click(cx.listener(move |dialog, _, _, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            form.kind = kind.to_string();
                        }
                        let placeholder = if kind == "text" { "new-channel" } else { "Lounge" };
                        dialog.name.update(cx, |input, cx| input.set_placeholder(placeholder, cx));
                        cx.notify();
                    }))
                    .child(icon(icon_name, 18., if active { theme.text1 } else { theme.text2 }))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(title)).child(div().mt(px(1.)).text_size(px(12.)).text_color(theme.text3).child(text)))
            };
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Type"))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(choice("text", "hash", "Text", "Messages, pictures and files", text, cx))
                            .child(choice("voice", "volume-2", "Voice", "Talk, share a camera or a screen", !text, cx)),
                    )
                    .into_any_element(),
            );
        }
        if !text && !voice_ready {
            body.push(
                div()
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .bg(theme.amber_soft)
                    .text_size(px(13.))
                    .text_color(theme.amber)
                    .child("This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit (see SELF_HOSTING.md).")
                    .into_any_element(),
            );
        }
        let form = self.channel_form.as_ref().unwrap();
        body.push(field(Some("Name"), self.name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element());
        body.push(field(Some("Topic"), form.topic.clone(), None, None, false, None, cx).into_any_element());
        body.push(field(Some("Heading"), form.category.clone(), None, None, false, None, cx).into_any_element());
        let (slow_on, slow_mode) = (form.slow_on, form.slow_mode);
        body.push(
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Slow mode")).child(div().text_size(px(12.5)).text_color(theme.text3).child("Each person waits between messages, except admins.")))
                .child(switch("slow-mode", slow_on, cx).on_click(cx.listener(|dialog, _, _, cx| {
                    if let Some(form) = &mut dialog.channel_form {
                        form.slow_on = !form.slow_on;
                    }
                    cx.notify();
                })))
                .into_any_element(),
        );
        if slow_on {
            let mut times: Vec<f64> = SLOW_MODE_TIMES.to_vec();
            if !times.contains(&slow_mode) {
                times.push(slow_mode);
            }
            let weak = cx.entity().downgrade();
            let choices = times
                .iter()
                .map(|seconds| {
                    let (weak, seconds) = (weak.clone(), *seconds);
                    let action: std::rc::Rc<dyn Fn(&mut Window, &mut gpui::App)> = std::rc::Rc::new(move |_, cx| {
                        weak.update(cx, |dialog, cx| {
                            if let Some(form) = &mut dialog.channel_form {
                                form.slow_mode = seconds;
                            }
                            cx.notify();
                        })
                        .ok();
                    });
                    (crate::format::timer_text(seconds), action)
                })
                .collect();
            body.push(labeled("Time between messages", select_box("slow-time", crate::format::timer_text(slow_mode), choices, cx).into_any_element(), cx));
        }
        if !text {
            let form = self.channel_form.as_ref().unwrap();
            let weak = cx.entity().downgrade();
            let pick = |value: f64, apply: fn(&mut ChannelForm, f64)| -> std::rc::Rc<dyn Fn(&mut Window, &mut gpui::App)> {
                let weak = weak.clone();
                std::rc::Rc::new(move |_, cx| {
                    weak.update(cx, |dialog, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            apply(form, value);
                        }
                        cx.notify();
                    })
                    .ok();
                })
            };
            let qualities = [(0., "Usual (64 kbit/s)"), (96., "Better (96 kbit/s)"), (128., "Great (128 kbit/s)"), (256., "Best (256 kbit/s)")];
            let quality_label = qualities.iter().find(|(kbps, _)| *kbps == form.bitrate).map(|(_, label)| label.to_string()).unwrap_or_else(|| format!("{} kbit/s", form.bitrate));
            let quality_choices = qualities.iter().map(|(kbps, label)| (label.to_string(), pick(*kbps, |form, value| form.bitrate = value))).collect();
            body.push(labeled("Audio quality", select_box("audio-quality", quality_label, quality_choices, cx).into_any_element(), cx));
            let limit = form.user_limit;
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .child(div().flex().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("People who fit: ").child(div().text_color(theme.text1).child(if limit == 0. { "no limit".to_string() } else { (limit as u32).to_string() })))
                    .child(slider("user-limit", (limit / 99.) as f32, {
                        let weak = weak.clone();
                        move |value, _, cx| {
                            weak.update(cx, |dialog, cx| {
                                if let Some(form) = &mut dialog.channel_form {
                                    form.user_limit = (value * 99.).round() as f64;
                                }
                                cx.notify();
                            })
                            .ok();
                        }
                    }, cx))
                    .into_any_element(),
            );
            let mut limits: Vec<(f64, String)> = vec![(0., "Server default".into()), (-1., "Off".into())];
            limits.extend([1., 2., 3., 4., 5., 10.].iter().map(|limit| (*limit, if *limit == 1. { "1 at a time".to_string() } else { format!("Up to {limit} at once") })));
            if !limits.iter().any(|(limit, _)| *limit == form.screen_limit) {
                limits.push((form.screen_limit, format!("Up to {} at once", form.screen_limit)));
            }
            let screen_label = limits.iter().find(|(limit, _)| *limit == form.screen_limit).map(|(_, label)| label.clone()).unwrap_or_default();
            let screen_choices = limits.iter().map(|(limit, label)| (label.clone(), pick(*limit, |form, value| form.screen_limit = value))).collect();
            body.push(labeled("Screen sharing", select_box("screen-limit", screen_label, screen_choices, cx).into_any_element(), cx));
            let sounds = form.sounds;
            body.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Soundboard")).child(div().text_size(px(12.5)).text_color(theme.text3).child("Anyone in the channel can play the server's sounds to everyone there.")))
                    .child(switch("soundboard", sounds, cx).on_click(cx.listener(|dialog, _, _, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            form.sounds = !form.sounds;
                        }
                        cx.notify();
                    })))
                    .into_any_element(),
            );
            let watch = form.watch;
            body.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Watch together")).child(div().text_size(px(12.5)).text_color(theme.text3).child("Anyone in the channel can put a YouTube video on for everyone there. It only plays for those who press Watch.")))
                    .child(switch("watch-together", watch, cx).on_click(cx.listener(|dialog, _, _, cx| {
                        if let Some(form) = &mut dialog.channel_form {
                            form.watch = !form.watch;
                        }
                        cx.notify();
                    })))
                    .into_any_element(),
            );
        }
        body.push(div().text_size(px(12.5)).text_color(theme.text3).child("Everyone on this server can see and join channels. The name and everything said are end-to-end encrypted, so the server can't read them.").into_any_element());
        let busy = self.busy;
        let ready = !final_name.is_empty() && !busy;
        let editing = channel.is_some();
        let delete_channel = channel.clone();
        let footer = div()
            .flex()
            .w_full()
            .gap(px(8.))
            .when_some(delete_channel, |el, channel| {
                el.child(button("delete-channel", ButtonKind::Danger, ButtonSize::Normal, busy, cx).child(icon("trash", 14., theme.red)).child("Delete").on_click(cx.listener(move |_, _, window, cx| {
                    let answer = window.prompt(gpui::PromptLevel::Warning, &format!("Delete {}?", channel.name), Some("Its messages go for everyone."), &["Delete", "Cancel"], cx);
                    let (id, key) = (channel.id.clone(), channel.key.clone());
                    cx.spawn(async move |dialog, cx| {
                        if answer.await != Ok(0) {
                            return;
                        }
                        dialog
                            .update(cx, |dialog, cx| {
                                dialog.state.update(cx, |state, cx| {
                                    let server = state.active_server.clone();
                                    let open = state.active().and_then(|server| server.active_key.clone()) == Some(key.clone());
                                    state.call(server.as_deref(), "deleteChannel", vec![json!(id)], cx, move |state, result, cx| match result {
                                        Ok(_) => {
                                            if open {
                                                state.select_conversation(None, cx);
                                            }
                                            state.set_overlay(None, cx);
                                        }
                                        Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                    });
                                })
                            })
                            .ok();
                    })
                    .detach();
                })))
                .child(div().flex_1())
            })
            .child(button("cancel", ButtonKind::Default, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("save-channel", ButtonKind::Primary, ButtonSize::Normal, !ready, cx).child(if busy { "Saving…" } else if editing { "Save" } else { "Create channel" }).when(ready, |el| el.on_click(cx.listener(move |dialog, _, _, cx| dialog.save_channel(cx)))));
        self.modal(Some(if editing { "Edit channel".into() } else { "New channel".into() }), 460., body, Some(footer.into_any_element()), cx)
    }

    pub(super) fn save_channel(&mut self, cx: &mut Context<Self>) {
        let DialogKind::Channel { channel_id, .. } = &self.kind else { return };
        let Some(form) = &self.channel_form else { return };
        let channel_id = channel_id.clone();
        let text = form.kind == "text";
        let name = if text { text_channel_name(self.name.read(cx).text()).trim_matches('-').to_string() } else { self.name.read(cx).text().trim().to_string() };
        let mut details = json!({
            "name": name,
            "topic": form.topic.read(cx).text().trim(),
            "category": form.category.read(cx).text().trim(),
            "userLimit": if text { 0. } else { form.user_limit },
            "screenLimit": if text { 0. } else { form.screen_limit },
            "slowMode": if form.slow_on { form.slow_mode } else { 0. },
        });
        if !text && form.bitrate > 0. {
            details["bitrate"] = json!(form.bitrate);
        }
        if !text {
            details["sounds"] = json!(form.sounds);
            details["watch"] = json!(form.watch);
        }
        let call = {
            let state = self.state.read(cx);
            let server = state.active_server.clone();
            match &channel_id {
                Some(id) => state.core.call(server.as_deref(), "updateChannel", vec![json!(id), details]),
                None => {
                    details["type"] = json!(if text { "text" } else { "voice" });
                    state.core.call(server.as_deref(), "createChannel", vec![details])
                }
            }
        };
        self.busy = true;
        cx.notify();
        let created = channel_id.is_none();
        cx.spawn(async move |dialog, cx| {
            let result = call.await;
            dialog
                .update(cx, |dialog, cx| match result {
                    Ok(id) => dialog.state.update(cx, |state, cx| {
                        // Opening a voice channel is coming into it, which making one isn't asking for.
                        if created && text {
                            if let Some(id) = id.as_str() {
                                state.select_conversation(Some(format!("group:{id}")), cx);
                            }
                        }
                        state.set_overlay(None, cx);
                    }),
                    Err(error) => {
                        dialog.busy = false;
                        dialog.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx));
                        cx.notify();
                    }
                })
                .ok();
        })
        .detach();
    }
}
