//! The conversation's header, or a channel's, and the call above the messages.

use super::*;

impl ChatView {
    pub(super) fn header(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.servers.get(&self.server_id) else { return div().into_any_element() };
        let panel = state.panel;
        let peer = conversation.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_saved = conversation.peer_id.as_deref() == Some(server.self_id());
        // A chat of the Telegram account linked here, which says so wherever a Zuna chat has its lock.
        let telegram = server.entry.is_telegram();
        let typing: Vec<String> = conversation.group_id.as_ref().and_then(|group| server.typing.get(group)).map(|typing| typing.keys().cloned().collect()).unwrap_or_default();
        let status: AnyElement = if !typing.is_empty() {
            let names: Vec<String> = typing.iter().map(|id| server.users.get(id).map(|u| u.display_name.split(' ').next().unwrap_or("").to_string()).unwrap_or("Someone".into())).collect();
            let label = if conversation.kind == "dm" {
                "typing".to_string()
            } else if names.len() == 1 {
                format!("{} is typing", names[0])
            } else {
                format!("{} people are typing", names.len())
            };
            div().flex().items_center().gap(px(5.)).text_color(theme.text1).child(label).child(typing_dots(theme.text1)).into_any_element()
        } else if conversation.kind == "group" && telegram {
            div().text_color(theme.text3).child("group on Telegram").into_any_element()
        } else if conversation.kind == "group" {
            let online = conversation.members.iter().filter(|member| server.users.get(&member.user_id).is_some_and(|u| u.online)).count();
            let count = conversation.members.len();
            div()
                .text_color(theme.text3)
                .child(format!("{count} {}{}", if count == 1 { "member" } else { "members" }, if online > 0 { format!(", {online} online") } else { String::new() }))
                .into_any_element()
        } else if is_saved {
            div().text_color(theme.text3).child("Notes to yourself").into_any_element()
        } else if peer.as_ref().is_some_and(|p| p.deleted) {
            div().text_color(theme.text3).child("Deleted their account").into_any_element()
        } else if peer.as_ref().is_some_and(|p| p.banned) {
            div().text_color(theme.text3).child("Removed from this server").into_any_element()
        } else if peer.as_ref().is_some_and(|p| p.bot.is_some()) {
            // Nobody is using a bot, so it's never online, and was never last seen.
            div().text_color(theme.text3).child("bot").into_any_element()
        } else if peer.as_ref().is_some_and(|p| p.online) {
            div().text_color(theme.green).child("online").into_any_element()
        } else {
            div().text_color(theme.text3).child(format_last_seen(peer.as_ref().and_then(|p| p.last_seen_at), peer.as_ref().is_some_and(|p| p.hides_last_seen), false)).into_any_element()
        };
        let avatar_el: AnyElement = if is_saved {
            div().size(px(36.)).flex_none().rounded_full().bg(theme.bg4).flex().items_center().justify_center().child(icon("bookmark", 16., theme.text1)).into_any_element()
        } else {
            let image = conversation.avatar.as_ref().and_then(|avatar| {
                let server_id = self.server_id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            avatar(
                AvatarProps {
                    name: conversation.title.clone(),
                    seed: conversation.peer_id.clone().or(conversation.group_id.clone()).unwrap_or_default(),
                    image,
                    size: 36.,
                    online: false,
                    rounded: false,
                    dot_border: theme.bg1,
                },
                cx,
            )
            .into_any_element()
        };
        let mut title = div().flex().items_center().gap(px(5.)).text_size(px(14.5)).font_weight(FontWeight::SEMIBOLD).line_height(gpui::relative(1.3)).child(div().one_line().child(conversation.title.clone()));
        if conversation.bot {
            title = title.child(bot_badge(cx));
        }
        if peer.as_ref().is_some_and(|p| p.trust == "verified") && !is_saved {
            title = title.child(icon("badge-check", 14., theme.text2));
        }
        if telegram {
            title = title.child(
                div()
                    .id("telegram-mark")
                    .flex_none()
                    .px(px(6.))
                    .rounded(px(4.))
                    .bg(theme.bg3)
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text2)
                    .tip("Not end-to-end encrypted. Telegram keeps these messages.", Side::Bottom)
                    .child("Telegram"),
            );
        }
        if conversation.disappear_after > 0. {
            title = title.child(div().id("timer-icon").tip(format!("Messages disappear after {}", timer_text(conversation.disappear_after)), Side::Bottom).child(icon("timer", 14., theme.text2)));
        }
        let toggle = |panel_kind: Panel, state: Entity<AppState>| move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut gpui::App| state.update(cx, |state, cx| state.toggle_panel(panel_kind, cx));
        let has_group = conversation.group_id.is_some();
        // Telegram's calls ring in Telegram's own app, and no plugin reaches its chats.
        let call_buttons = if telegram { Vec::new() } else { crate::ui::voice::call_buttons(&self.state, &self.server_id, conversation, cx).into_iter().collect() };
        let plugin_buttons = if telegram { Vec::new() } else { crate::ui::plugins::header_buttons(cx).into_iter().collect() };
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .h(px(52.))
            .pl(px(14.))
            .pr(px(10.))
            .bg(theme.bg1)
            .border_b_1()
            .border_color(theme.line)
            .child(
                div()
                    .id("chat-identity")
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .cursor_pointer()
                    .on_click(toggle(Panel::Info, self.state.clone()))
                    .child(avatar_el)
                    .child(div().min_w_0().flex().flex_col().child(title).child({
                        let line = div().text_size(px(12.5)).line_height(gpui::relative(1.3)).child(status);
                        if !typing.is_empty() {
                            *self.typed_in.borrow_mut() = Some(conversation.key.clone());
                        }
                        if self.typed_in.borrow().as_deref() == Some(conversation.key.as_str()) {
                            // Faded in afresh each time it turns between typing and not.
                            line.enter(if typing.is_empty() { "status-idle" } else { "status-typing" }, Enter::Fade, 140).into_any_element()
                        } else {
                            line.into_any_element()
                        }
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(2.))
                    .children(call_buttons)
                    .children(plugin_buttons)
                    .child(
                        icon_button("chat-search", "search", 17., false, panel == Some(Panel::Search), cx)
                            .tip("Search this chat", Side::Bottom)
                            .when(has_group, |el| el.on_click(toggle(Panel::Search, self.state.clone())))
                            .when(!has_group, |el| el.opacity(0.35)),
                    )
                    .child(
                        icon_button("chat-pins", "pin", 17., false, panel == Some(Panel::Pins), cx)
                            .tip("Pinned messages", Side::Bottom)
                            .when(has_group, |el| el.on_click(toggle(Panel::Pins, self.state.clone())))
                            .when(!has_group, |el| el.opacity(0.35)),
                    )
                    .child(icon_button("chat-details", "panel-right", 17., false, panel == Some(Panel::Info), cx).tip("Details", Side::Bottom).on_click(toggle(Panel::Info, self.state.clone()))),
            )
            .into_any_element()
    }

    /// The call above this chat while this device is in it, or the banner for one going on.
    pub(super) fn call_area(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) -> (Option<AnyElement>, bool) {
        let in_call = conversation.group_id.is_some() && crate::voice::connected_channel(cx).is_some_and(|(server_id, channel_id)| server_id == self.server_id && Some(&channel_id) == conversation.group_id.as_ref());
        if !in_call {
            self.call_stage = None;
            return (crate::ui::voice::call_banner(&self.state, &self.server_id, conversation, cx), false);
        }
        let stage = match &self.call_stage {
            Some(stage) => stage.clone(),
            None => {
                let room = crate::ui::voice_stage::StageRoom { server_id: self.server_id.clone(), id: conversation.group_id.clone().unwrap_or_default(), call: true };
                let state = self.state.clone();
                let stage = cx.new(|cx| crate::ui::voice_stage::VoiceStage::new(state, room, cx));
                cx.observe(&stage, |_, _, cx| cx.notify()).detach();
                self.call_stage = Some(stage.clone());
                stage
            }
        };
        let expanded = stage.read(cx).expanded;
        (Some(stage.into_any_element()), expanded)
    }

    /// A channel's header, as Discord's: its name and topic, then notifications, pins,
    /// the member list and a search box.
    pub(super) fn channel_header(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let panel = state.panel;
        let show_members = !state.settings.hide_member_list;
        let muted = conversation.muted;
        let muted_color = theme.channel_muted;
        let details = |id: &'static str, state: Entity<AppState>| {
            div().id(id).cursor_pointer().on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.toggle_panel(Panel::Info, cx));
            })
        };
        let action = |id: &'static str, icon_name: &'static str, active: bool| {
            div()
                .id(id)
                .size(px(32.))
                .mx(px(2.))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .group(id)
                // `.channel-head .icon-btn`: no background, only a brighter icon under the pointer.
                .child(icon(icon_name, 20., if active { theme.text1 } else { theme.text2 }).group_hover(id, move |style| style.text_color(theme.text1)))
        };
        let (mute_state, mute_key) = (self.state.clone(), conversation.key.clone());
        let pins_state = self.state.clone();
        let members_state = self.state.clone();
        let search_state = self.state.clone();
        let searching = panel == Some(Panel::Search);
        div()
            .flex_none()
            .h(px(48.))
            .flex()
            .items_center()
            .pl(px(16.))
            .pr(px(8.))
            .bg(theme.bg_chat)
            .border_b_1()
            .border_color(theme.line)
            .shadow(vec![gpui::BoxShadow { color: theme::color(theme::black_a(0.25)), offset: gpui::point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false }])
            .child(
                details("channel-name", self.state.clone())
                    .flex_shrink_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(icon(if self.beside_voice.is_some() { "volume-2" } else { "hash" }, 22., muted_color))
                    .child(div().min_w_0().one_line().text_size(px(16.)).line_height(px(20.)).font_weight(FontWeight::SEMIBOLD).child(conversation.title.clone())),
            )
            .when(!conversation.description.is_empty(), |el| {
                el.child(div().flex_none().w(px(1.)).h(px(24.)).mx(px(12.)).bg(theme.line_strong))
                    .child(details("channel-topic", self.state.clone()).flex_shrink_1().min_w_0().one_line().text_size(px(14.)).line_height(px(18.)).text_color(theme.text2).tooltip(tooltip(conversation.description.clone())).child(conversation.description.clone()))
            })
            .child(div().flex_1())
            .child(
                action("channel-mute", if muted { "bell-off" } else { "bell" }, false)
                    .tip(if muted { "Unmute channel" } else { "Notification settings" }, Side::Bottom)
                    .on_click(move |event, _, cx| {
                        if muted {
                            mute_state.update(cx, |state, cx| state.act("unmute", vec![json!(mute_key)], cx));
                        } else {
                            crate::ui::menu::open_menu(event.position(), crate::ui::conversations::mute_entries(mute_key.clone(), mute_state.clone()), true, cx);
                        }
                    }),
            )
            .child(action("channel-pins", "pin", panel == Some(Panel::Pins)).tip("Pinned messages", Side::Bottom).on_click(move |_, _, cx| pins_state.update(cx, |state, cx| state.toggle_panel(Panel::Pins, cx))))
            .when(self.beside_voice.is_none(), |el| {
                el.child(
                    action("channel-members", "users", show_members && panel.is_none())
                        .tip(if show_members { "Hide member list" } else { "Show member list" }, Side::Bottom)
                        .on_click(move |_, _, cx| {
                            members_state.update(cx, |state, cx| {
                                // It takes the place of whatever panel was open.
                                if state.panel.is_some() {
                                    state.panel = None;
                                    cx.notify();
                                    if !state.settings.hide_member_list {
                                        return;
                                    }
                                }
                                state.update_settings(|settings| settings.hide_member_list = !settings.hide_member_list, cx);
                            })
                        }),
                )
            })
            .child(
                div()
                    .id("channel-search")
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(6.))
                    .w(px(if searching { 220. } else { 144. }))
                    .h(px(26.))
                    .ml(px(8.))
                    .mr(px(4.))
                    .pl(px(8.))
                    .pr(px(7.))
                    .rounded(px(6.))
                    .bg(theme.bg2)
                    .text_size(px(14.))
                    .text_color(if searching { theme.text1 } else { muted_color })
                    .cursor_pointer()
                    .hover(move |style| style.text_color(theme.text2))
                    .on_click(move |_, _, cx| search_state.update(cx, |state, cx| state.toggle_panel(Panel::Search, cx)))
                    .child("Search")
                    .child(icon("search", 15., if searching { theme.text1 } else { muted_color })),
            )
            .when_some(self.beside_voice.clone(), |el, stage| {
                el.child(action("channel-hide-chat", "x", false).tip("Hide chat", Side::Bottom).on_click(move |_, _, cx| {
                    stage.update(cx, |stage, cx| stage.hide_chat(cx)).ok();
                }))
            })
            .into_any_element()
    }

    /// Who's typing in a channel, under the message box, with slow mode on the right. Always there, so nothing moves.
    pub(super) fn channel_typing(&self, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let server = state.servers.get(&self.server_id);
        let names: Vec<String> = conversation
            .group_id
            .as_ref()
            .and_then(|group| server.and_then(|server| server.typing.get(group)))
            .map(|typing| typing.keys().filter(|id| server.is_some_and(|server| *id != server.self_id())).map(|id| server.and_then(|server| server.users.get(id)).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into())).collect())
            .unwrap_or_default();
        let bold = |name: &str| div().font_weight(FontWeight::BOLD).child(name.to_string());
        let text: Option<gpui::Div> = match names.len() {
            0 => None,
            1 => Some(div().flex().child(bold(&names[0])).child("\u{a0}is typing…")),
            2 => Some(div().flex().child(bold(&names[0])).child("\u{a0}and\u{a0}").child(bold(&names[1])).child("\u{a0}are typing…")),
            3 => Some(div().flex().child(bold(&names[0])).child(",\u{a0}").child(bold(&names[1])).child("\u{a0}and\u{a0}").child(bold(&names[2])).child("\u{a0}are typing…")),
            _ => Some(div().child("Several people are typing…")),
        };
        div()
            .flex_none()
            .h(px(24.))
            .flex()
            .items_center()
            .gap(px(6.))
            .pl(px(18.))
            .pr(px(16.))
            .text_size(px(14.))
            .text_color(theme.text1)
            .bg(theme.bg_chat)
            .overflow_hidden()
            .when_some(text, |el, text| el.child(typing_dots(theme.text1)).child(div().min_w_0().overflow_hidden().child(text)))
            .when(conversation.slow_mode > 0., |el| {
                el.child(
                    div()
                        .id("slow-mode")
                        .ml_auto()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(13.))
                        .text_color(theme.text2)
                        .tip(format!("One message every {} for each person, except admins", crate::format::timer_text(conversation.slow_mode)), Side::Top)
                        .child(icon("timer", 14., theme.text2))
                        .child("Slow mode is on"),
                )
            })
            .into_any_element()
    }
}
