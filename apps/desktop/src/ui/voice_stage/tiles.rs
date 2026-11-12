//! The stage's tiles: each person, each screen being shared, and whoever a call is ringing,
//! with their menus and full screen.

use super::*;

impl VoiceStage {
    pub(super) fn open_member_menu(&self, user_id: String, member: Option<VoiceMember>, position: gpui::Point<Pixels>, cx: &mut App) {
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.room.server_id) else { return };
        let voice = self.voice.read(cx);
        let self_id = server.self_id().to_string();
        let is_self = user_id == self_id;
        let role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let target_role = server.users.get(&user_id).map(|user| user.role.clone()).unwrap_or_default();
        // In a call, which is between the people in it, admins have no say.
        let can_moderate = !self.room.call && !is_self && (role == "owner" || (role == "admin" && target_role == "member"));
        let stream_sound = voice.videos.iter().any(|video| video.user_id == user_id && video.sound);
        let mut entries = Vec::new();
        let voice_entity = self.voice.clone();
        if is_self {
            // On yourself, what the buttons below the call do, as there's nothing to do to yourself.
            if !voice.server_muted && !voice.no_mic {
                let voice = voice_entity.clone();
                let off = voice_entity.read(cx).muted || voice_entity.read(cx).deafened;
                entries.push(MenuEntry::new(if off { "Unmute" } else { "Mute" }, if off { "mic" } else { "mic-off" }, move |_, cx| voice.update(cx, |voice, cx| voice.toggle_mute(cx))));
            }
            let deafened = voice.deafened;
            let deafen = voice_entity.clone();
            entries.push(MenuEntry::new(if deafened { "Undeafen" } else { "Deafen" }, if deafened { "headphones" } else { "headphone-off" }, move |_, cx| deafen.update(cx, |voice, cx| voice.toggle_deafen(cx))));
            let settings = self.state.clone();
            entries.push(MenuEntry::new("Voice settings", "settings", move |_, cx| settings.update(cx, |state, cx| state.set_overlay(Some(Overlay::Settings { section: Some("voice".into()) }), cx))));
        } else {
            let local_muted = voice.local_mutes.contains(&user_id);
            let (mute, user) = (voice_entity.clone(), user_id.clone());
            entries.push(MenuEntry::new(if local_muted { "Unmute for me" } else { "Mute for me" }, if local_muted { "volume-2" } else { "volume-x" }, move |_, cx| mute.update(cx, |voice, cx| voice.toggle_local_mute(&user, cx))));
            let (verify, user) = (self.state.clone(), user_id.clone());
            entries.push(MenuEntry::new("Verify with emoji", "lock", move |_, cx| verify.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user.clone() }), cx))));
        }
        if can_moderate {
            entries.push(MenuEntry::separator());
            let server_muted = member.as_ref().is_some_and(|member| member.server_muted);
            let act = |method: &'static str, args: Vec<serde_json::Value>| {
                let (state, server_id) = (self.state.clone(), self.room.server_id.clone());
                move |_: &mut Window, cx: &mut App| {
                    let args = args.clone();
                    state.update(cx, |state, cx| {
                        state.call(Some(&server_id), method, args, cx, |state, result, cx| {
                            if let Err(error) = result {
                                state.toast(error.message, ToastKind::Error, cx);
                            }
                        })
                    })
                }
            };
            let channel = serde_json::json!(self.room.id);
            let user = serde_json::json!(user_id);
            entries.push(MenuEntry::new(if server_muted { "Let them talk" } else { "Mute for everyone" }, "shield-off", act("voiceMute", vec![channel.clone(), user.clone(), serde_json::json!(!server_muted)])));
            if member.as_ref().is_some_and(|member| member.screen) {
                entries.push(MenuEntry::new("Stop their screen share", "monitor-off", act("voiceScreenStopOf", vec![channel.clone(), user.clone()])));
            }
            entries.push(MenuEntry::new("Disconnect", "user-x", act("voiceDisconnect", vec![channel, user])).danger());
        }
        let header: Option<Header> = (!is_self).then(|| {
            let (voice, user) = (voice_entity.clone(), user_id.clone());
            Rc::new(move |_: &mut Window, cx: &mut App| -> AnyElement {
                let theme = theme(cx);
                let current = voice.read(cx);
                let level = current.volumes.get(&user).copied().unwrap_or(1.);
                let stream = current.stream_volumes.get(&user).copied().unwrap_or(1.);
                let row = |id: &'static str, label: &'static str, value: f32, stream_volume: bool, voice: Entity<Voice>, user: String, cx: &App| {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .px(px(10.))
                        .pt(px(6.))
                        .pb(px(6.))
                        .min_w(px(210.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .child(div().flex().gap(px(4.)).child(label).child(div().font_weight(FontWeight::MEDIUM).text_color(theme.text1).child(format!("{}%", (value * 100.).round()))))
                        .child(slider(id, value / 2., move |fraction, _, cx| {
                            let user = user.clone();
                            voice.update(cx, |voice, cx| if stream_volume { voice.set_stream_volume(&user, fraction * 2., cx) } else { voice.set_volume(&user, fraction * 2., cx) })
                        }, cx))
                };
                let mut header = div().flex().flex_col().child(row("member-volume", "Volume", level, false, voice.clone(), user.clone(), cx));
                if stream_sound {
                    header = header.child(row("member-stream-volume", "Stream volume", stream, true, voice.clone(), user.clone(), cx));
                }
                header.into_any_element()
            }) as Header
        });
        open_menu_with_header(position, header, entries, false, cx);
    }

    pub(super) fn person_tile(&mut self, member: &VoiceMember, camera: Option<&VideoTile>, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.room.server_id) else { return div().into_any_element() };
        let is_self = member.user_id == server.self_id();
        let user = server.users.get(&member.user_id).cloned();
        let voice = self.voice.read(cx);
        let speaking = if is_self { voice.self_speaking() } else { voice.speaking.contains(&member.user_id) };
        let local_muted = voice.local_mutes.contains(&member.user_id);
        let sounding = voice.sounding.get(&member.user_id).cloned();
        let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = self.room.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        let content = match camera {
            Some(tile) => self.video(tile, false),
            None => avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 84., online: false, rounded: false, dot_border: theme.bg2 }, cx).into_any_element(),
        };
        let user_id = member.user_id.clone();
        let menu_member = member.clone();
        let focus_key = camera.map(|tile| tile.key.clone());
        let mut label = div().absolute().left(px(8.)).bottom(px(8.)).max_w(px(size.0 - 16.)).flex().items_center().gap(px(5.)).px(px(8.)).py(px(3.)).rounded(px(6.)).text_size(px(12.5)).text_color(gpui::white()).bg(theme::color(theme::black_a(0.62)));
        if member.server_muted {
            label = label.child(icon("mic-off", 13., theme.red));
        } else if member.muted {
            label = label.child(icon("mic-off", 13., gpui::white()));
        }
        if member.deafened {
            label = label.child(icon("headphone-off", 13., gpui::white()));
        }
        if local_muted {
            label = label.child(icon("volume-x", 13., gpui::white()));
        }
        label = label.child(div().min_w_0().one_line().child(if is_self { format!("{name} (you)") } else { name.clone() }));
        div()
            .id(SharedString::from(format!("person-{}", member.device_id)))
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .rounded(RADIUS_L)
            .bg(if camera.is_some() { gpui::black() } else { mix(theme::css(avatar_color(&member.user_id)), theme.bg2, 0.16) })
            .child(content)
            .when_some(sounding, |el, emoji| {
                // `.voice-tile-played`: in over 160 ms, as it starts playing.
                el.child(div().absolute().right(px(8.)).top(px(8.)).min_w(px(30.)).h(px(30.)).px(px(6.)).flex().items_center().justify_center().rounded(px(15.)).bg(theme::color(theme::black_a(0.62))).text_size(px(17.)).child(emoji.clone()).appear(SharedString::from(format!("played-{}-{emoji}", member.user_id)), Enter::Pop, 160))
            })
            .child(label)
            .when(speaking, |el| el.child(div().absolute().inset_0().rounded(RADIUS_L).border_2().border_color(theme.green)))
            .when_some(focus_key, |el, key| {
                let voice = self.voice.clone();
                el.cursor_pointer().on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.set_focus(Some(key.clone()), cx)))
            })
            .on_mouse_down(MouseButton::Right, cx.listener(move |stage, event: &gpui::MouseDownEvent, _, cx| {
                stage.open_member_menu(user_id.clone(), Some(menu_member.clone()), event.position, cx);
                cx.stop_propagation();
            }))
            .into_any_element()
    }

    /// A shared screen onto the whole screen, or back, as the button or a double click does on
    /// the web: the window goes full screen with the share over all of it. The video watched
    /// together goes the same way on Windows, from YouTube's own button (`follow_player_full_screen`).
    pub(super) fn toggle_full_screen(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.full_screen.is_some() {
            self.leave_full_screen(window, cx);
            return;
        }
        self.full_screen = Some((key.to_string(), window.is_fullscreen()));
        if !window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        let stage = cx.entity().downgrade();
        self.full_screen_keys = Some(cx.intercept_keystrokes(move |event, window, cx| {
            if event.keystroke.key == "escape" {
                stage.update(cx, |stage, cx| stage.leave_full_screen(window, cx)).ok();
                cx.stop_propagation();
            }
        }));
        cx.notify();
    }

    pub(super) fn leave_full_screen(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let left = self.full_screen.take();
        if left.is_some() && window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        // The player comes out of its own full screen with the window, where it's still in it.
        #[cfg(windows)]
        if left.is_some_and(|(key, _)| key == crate::voice::watch::WATCH_FOCUS) {
            if let Some(player) = &self.watch_player {
                player.leave_full_screen();
            }
        }
        self.full_screen_keys = None;
        cx.notify();
    }

    /// A shared screen in the stage, or `full` over the whole window, where a click does nothing
    /// and a right click opens no menu, as a full screen hides the app's.
    pub(super) fn screen_tile(&mut self, tile: &VideoTile, focused: bool, size: (f32, f32), full: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let name = self.state.read(cx).servers.get(&self.room.server_id).and_then(|server| server.users.get(&tile.user_id)).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        #[cfg(target_os = "macos")]
        let surface = if full { Self::surface(tile, gpui::ObjectFit::Contain, px(0.)) } else { None };
        #[cfg(not(target_os = "macos"))]
        let surface: Option<AnyElement> = None;
        let video = if let Some(surface) = surface {
            surface
        } else if full {
            match self.picture(tile, false) {
                Some(image) => img(image).size_full().object_fit(gpui::ObjectFit::Contain).into_any_element(),
                None => div().size_full().into_any_element(),
            }
        } else {
            self.video(tile, true)
        };
        let key = tile.key.clone();
        let user_id = tile.user_id.clone();
        // The tile and its copy over the window are told apart, as both are drawn.
        let suffix = if full { "-full" } else { "" };
        let id = move |name: &str| SharedString::from(format!("screen-{name}-{key}{suffix}"));
        let key = tile.key.clone();
        let group = id("group");
        let voice = self.voice.clone();
        let toggle_focus = {
            let (voice, key) = (voice.clone(), key.clone());
            move |cx: &mut App| voice.update(cx, |voice, cx| voice.set_focus(if focused { None } else { Some(key.clone()) }, cx))
        };
        let stream_volume = self.voice.read(cx).stream_volumes.get(&tile.user_id).copied().unwrap_or(1.);
        let double_click_key = key.clone();
        let mut element = div()
            .id(id("tile"))
            .group(group.clone())
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .overflow_hidden()
            .when(!full, |el| el.rounded(RADIUS_L).cursor_pointer())
            .bg(gpui::black())
            .on_click(cx.listener(move |stage, event: &gpui::ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    stage.toggle_full_screen(&double_click_key, window, cx);
                } else if !full {
                    let before = stage.voice.read(cx).focus.clone();
                    stage.screen_clicked = Some((double_click_key.clone(), before, std::time::Instant::now()));
                    stage.voice.update(cx, |voice, cx| voice.set_focus(if focused { None } else { Some(double_click_key.clone()) }, cx));
                }
            }))
            .child(video)
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .bottom(px(8.))
                    .max_w(px((size.0 - if tile.sound { 150. } else { 16. }).max(40.)))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .text_size(px(12.5))
                    .text_color(gpui::white())
                    .bg(theme::color(theme::black_a(0.62)))
                    .child(icon("monitor-up", 13., gpui::white()))
                    .child(div().min_w_0().one_line().child(if tile.local { "Your screen".to_string() } else { format!("{name}'s screen") })),
            )
            .child(
                div()
                    .absolute()
                    .right(px(8.))
                    .top(px(8.))
                    .flex()
                    .gap(px(4.))
                    .opacity(0.)
                    .group_hover(group.clone(), |style| style.opacity(1.))
                    .when(!full, |el| {
                        el.child(
                            div()
                                .id(id("pin"))
                                .size(px(28.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(RADIUS_S)
                                .bg(theme::color(theme::black_a(0.62)))
                                .tip(if focused { "Back to everyone" } else { "Fill the stage" }, Side::Bottom)
                                .on_click(move |_, _, cx| {
                                    cx.stop_propagation();
                                    toggle_focus(cx);
                                })
                                .child(icon(if focused { "pin-off" } else { "pin" }, 15., gpui::white())),
                        )
                    })
                    .child({
                        let key = key.clone();
                        div()
                            .id(id("full"))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(RADIUS_S)
                            .bg(theme::color(theme::black_a(0.62)))
                            .tip(if full { "Exit full screen" } else { "Full screen" }, Side::Bottom)
                            .on_click(cx.listener(move |stage, _, window, cx| {
                                cx.stop_propagation();
                                stage.toggle_full_screen(&key, window, cx);
                            }))
                            .child(icon(if full { "shrink" } else { "expand" }, 15., gpui::white()))
                    }),
            )
            .on_mouse_down(MouseButton::Right, cx.listener(move |stage, event: &gpui::MouseDownEvent, _, cx| {
                if !full {
                    stage.open_member_menu(user_id.clone(), None, event.position, cx);
                }
                cx.stop_propagation();
            }));
        if tile.sound {
            // A share's sound, at the bottom right as in a video player, with room left for the name.
            let (mute_voice, slide_voice, user, slide_user) = (voice.clone(), voice, tile.user_id.clone(), tile.user_id.clone());
            let silent = stream_volume == 0.;
            element = element.child(
                div()
                    .id(id("sound"))
                    .absolute()
                    .right(px(8.))
                    .bottom(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .pr(px(10.))
                    .rounded(px(6.))
                    .bg(theme::color(theme::black_a(0.62)))
                    .opacity(0.)
                    .group_hover(group, |style| style.opacity(1.))
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .id(id("mute"))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .tooltip(tooltip(if silent { "Unmute stream" } else { "Mute stream" }))
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                let user = user.clone();
                                mute_voice.update(cx, |voice, cx| {
                                    let before = voice.stream_volumes.get(&user).copied().unwrap_or(1.);
                                    voice.set_stream_volume(&user, if before == 0. { 1. } else { 0. }, cx);
                                });
                            })
                            .child(icon(if silent { "volume-x" } else { "volume-2" }, 15., gpui::white())),
                    )
                    .when(size.0 > 300., |el| {
                        el.child(div().w(px(96.)).child(slider(id("volume"), stream_volume / 2., move |fraction, _, cx| {
                            let user = slide_user.clone();
                            slide_voice.update(cx, |voice, cx| voice.set_stream_volume(&user, fraction * 2., cx));
                        }, cx)))
                    }),
            );
        }
        let _ = theme;
        element.into_any_element()
    }

    pub(super) fn ringing_tile(&mut self, user_id: &str, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let user = self.state.read(cx).servers.get(&self.room.server_id).and_then(|server| server.users.get(user_id)).cloned();
        let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
            let server_id = self.room.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
        });
        div()
            .relative()
            .w(px(size.0))
            .h(px(size.1))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden()
            .rounded(RADIUS_L)
            .opacity(0.8)
            .bg(mix(theme::css(avatar_color(user_id)), theme.bg2, 0.1))
            .child(
                div().child(avatar(AvatarProps { name: name.clone(), seed: user_id.to_string(), image, size: 84., online: false, rounded: false, dot_border: theme.bg2 }, cx)).map(|ring| crate::ui::motion::pulse(ring, SharedString::from(format!("ringing-{user_id}")), 1600, |el, delta| el.opacity(1. - 0.3 * (1. - (delta * 2. - 1.).abs())))),
            )
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .bottom(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .text_size(px(12.5))
                    .text_color(gpui::white())
                    .bg(theme::color(theme::black_a(0.62)))
                    .child(div().one_line().child(name))
                    .child(div().text_color(theme::color(theme::white_a(0.7))).child("Calling…")),
            )
            .into_any_element()
    }
}
