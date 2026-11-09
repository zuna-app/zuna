//! One conversation's row: its picture, name, last message, ticks and badges, and its menu.

use super::*;

impl ConversationList {
    pub(super) fn row(&self, item: &ConversationView, server: &ServerState, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let active = server.active_key.as_deref() == Some(item.key.as_str());
        let self_id = server.self_id().to_string();
        let peer = item.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_saved = item.peer_id.as_deref() == Some(self_id.as_str());
        let typing = item.group_id.as_ref().is_some_and(|group| server.typing.get(group).is_some_and(|typing| !typing.is_empty()));
        let call = item.group_id.as_ref().is_some_and(|group| server.calls.contains_key(group));
        let preview = preview_for(item.last_message.as_ref(), &server.users, &self_id, &item.kind);
        let fallback = if item.kind == "dm" && !is_saved {
            peer.as_ref().map(|peer| format!("@{}", peer.username)).unwrap_or_default()
        } else if is_saved {
            "Notes to yourself".into()
        } else {
            String::new()
        };
        let row_bg = if active { theme.bg3 } else { theme.bg1 };
        let avatar_el: AnyElement = if is_saved {
            div().size(px(46.)).flex_none().rounded_full().bg(theme.bg4).flex().items_center().justify_center().child(icon("bookmark", 19., theme.text1)).into_any_element()
        } else {
            let image = item.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            avatar(
                AvatarProps {
                    name: item.title.clone(),
                    seed: item.peer_id.clone().or(item.group_id.clone()).unwrap_or(item.key.clone()),
                    image,
                    size: 46.,
                    online: peer.as_ref().is_some_and(|peer| peer.online),
                    rounded: false,
                    dot_border: row_bg,
                },
                cx,
            )
            .into_any_element()
        };
        let mut title = div().flex_1().min_w_0().flex().items_center().gap(px(5.)).text_size(px(14.)).font_weight(FontWeight::MEDIUM);
        if item.kind == "group" {
            title = title.child(icon("users-round", 13., theme.text3));
        }
        title = title.child(div().min_w_0().one_line().child(item.title.clone()));
        if item.bot {
            title = title.child(bot_badge(cx));
        }
        if let Some(peer) = &peer {
            if peer.trust == "verified" {
                title = title.child(icon("badge-check", 14., theme.text2));
            } else if peer.trust == "changed" {
                title = title.child(icon("shield-alert", 14., theme.amber));
            }
        }
        if item.muted {
            title = title.child(icon("bell-off", 12., theme.text3));
        }
        if item.blocked {
            title = title.child(icon("ban", 12., theme.text3));
        }
        let preview_el: AnyElement = if typing {
            div().flex().items_center().gap(px(4.)).text_color(theme.text1).child("typing").child(typing_dots(theme.text1)).into_any_element()
        } else if call {
            div().flex().items_center().gap(px(4.)).text_color(theme.green).child(icon("phone", 12., theme.green)).child("In a call").into_any_element()
        } else if preview.is_empty() {
            div().text_color(theme.text3).one_line().child(fallback).into_any_element()
        } else {
            div().one_line().child(preview).into_any_element()
        };
        let badge = |text: String, muted: bool| {
            div()
                .flex_none()
                .min_w(px(18.))
                .h(px(18.))
                .px(px(5.))
                .rounded(px(9.))
                .bg(if muted { theme.bg5 } else { theme.accent })
                .text_color(if muted { theme.text2 } else { theme.on_accent })
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(px(18.))
                .flex()
                .justify_center()
                .child(text)
        };
        let mut second = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .min_h(px(20.))
            .child(div().flex_1().min_w_0().text_size(px(13.)).text_color(theme.text2).child(preview_el));
        if item.pinned && item.unread == 0. && !item.marked_unread {
            second = second.child(icon("pin", 13., theme.text3).with_transformation(gpui::Transformation::rotate(gpui::radians(35f32.to_radians()))));
        }
        if item.unread_mentions > 0. {
            second = second.child(
                div().flex_none().size(px(18.)).rounded(px(9.)).bg(if item.muted { theme.bg5 } else { theme.accent }).flex().items_center().justify_center().child(icon(
                    "at-sign",
                    12.,
                    if item.muted { theme.text2 } else { theme.on_accent },
                )),
            );
        }
        if item.unread > 0. {
            let count = item.unread as u32;
            second = second.child(badge(if count > 99 { "99+".into() } else { count.to_string() }, item.muted));
        } else if item.marked_unread {
            second = second.child(badge(String::new(), item.muted));
        }
        let mut first = div().flex().items_center().gap(px(6.)).min_h(px(20.)).child(title);
        if let Some(ticks) = ticks_element(item, &self_id, &theme, window) {
            first = first.child(div().flex_none().w(px(18.)).h(px(14.)).mr(px(-3.)).flex().items_center().justify_center().child(ticks));
        }
        first = first.child(div().flex_none().text_size(px(11.5)).text_color(theme.text3).child(format_list_time(item.last_message.as_ref().map(|m| m.created_at).unwrap_or(0.))));
        let key = item.key.clone();
        let state = self.state.clone();
        // The menu is made from the state when it opens, rather than each row carrying a copy of
        // its conversation and the server's preferences on every draw.
        let (menu_key, menu_server) = (item.key.clone(), server.entry.id.clone());
        let menu_state = self.state.clone();
        div()
            .id(SharedString::from(format!("conv-{}", item.key)))
            .w_full()
            .flex()
            .items_center()
            .gap(px(11.))
            .px(px(12.))
            .py(px(7.))
            .bg(row_bg)
            .when(!active, |el| el.hover(move |style| style.bg(theme.hover)))
            .cursor_pointer()
            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx)))
            .on_mouse_down(MouseButton::Right, move |event, _, cx| {
                let entries = {
                    let state = menu_state.read(cx);
                    let Some(server) = state.servers.get(&menu_server) else { return };
                    let Some(item) = server.find_conversation(&menu_key) else { return };
                    row_entries(item, &server.prefs, menu_state.clone())
                };
                open_menu(event.position, entries, false, cx);
            })
            .child(avatar_el)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .child(first)
                    .child(second),
            )
            .into_any_element()
    }
}

/// The last message's ticks beside its time, as in Telegram, when it's one you sent to someone who
/// can read it: as `meta_element` draws them in its bubble. Notes to yourself never get read.
pub(super) fn ticks_element(item: &ConversationView, self_id: &str, theme: &Theme, window: &mut Window) -> Option<AnyElement> {
    let message = item.last_message.as_ref()?;
    if message.sender_id != self_id || message.system.is_some() || message.deleted_at.is_some() || item.peer_id.as_deref() == Some(self_id) {
        return None;
    }
    let read_up_to = item.read_up_to(self_id);
    let ticks = |read: bool| {
        gpui::svg()
            .path(if read { "icons/ticks-read.svg" } else { "icons/ticks-sent.svg" })
            .w(px(18.))
            .h(px(10.))
            .text_color(if read { theme.accent_text } else { theme.text3 })
            .into_any_element()
    };
    match message.status.as_str() {
        "sending" if read_up_to >= 0. && crate::format::now_ms() - message.created_at < crate::ui::message::SLOW_SEND_MS => {
            // Drawn again to show the clock if it's still sending by then.
            window.request_animation_frame();
            Some(ticks(false))
        }
        "sending" => Some(icon("clock", 11., theme.text3).enter(SharedString::from(format!("conv-tick-sending-{}", message.id)), Enter::Fade, 120).into_any_element()),
        "failed" => Some(icon("circle-alert", 12., theme.red).into_any_element()),
        _ => match message.seq {
            Some(seq) if read_up_to >= 0. => Some(ticks(read_up_to >= seq)),
            _ => None,
        },
    }
}

pub(super) fn row_entries(item: &ConversationView, prefs: &crate::models::Preferences, state: Entity<AppState>) -> Vec<MenuEntry> {
    let key = item.key.clone();
    let toggle = |list: &'static str, current: Vec<String>, key: String, state: Entity<AppState>| {
        move |_: &mut Window, cx: &mut gpui::App| {
            let next: Vec<String> = if current.contains(&key) { current.iter().filter(|item| **item != key).cloned().collect() } else { [current.clone(), vec![key.clone()]].concat() };
            state.update(cx, |state, cx| state.act("updatePreferences", vec![json!({ list: next })], cx));
        }
    };
    let mut entries = vec![if item.pinned {
        MenuEntry::new("Unpin", "pin-off", toggle("pinned", prefs.pinned.clone(), key.clone(), state.clone()))
    } else {
        MenuEntry::new("Pin to top", "pin", toggle("pinned", prefs.pinned.clone(), key.clone(), state.clone()))
    }];
    if item.unread > 0. || item.marked_unread {
        let (state, key) = (state.clone(), key.clone());
        entries.push(MenuEntry::new("Mark as read", "check-check", move |_, cx| state.update(cx, |state, cx| state.act("markChatRead", vec![json!(key)], cx))));
    } else if item.group_id.is_some() {
        let (state, key) = (state.clone(), key.clone());
        entries.push(MenuEntry::new("Mark as unread", "message-square-dot", move |_, cx| {
            state.update(cx, |state, cx| state.act("setMarkedUnread", vec![json!(key), json!(true)], cx))
        }));
    }
    if item.muted {
        let (state, key) = (state.clone(), key.clone());
        entries.push(MenuEntry::new("Unmute", "volume-2", move |_, cx| state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx))));
    } else {
        entries.push(MenuEntry::submenu("Mute", "volume-x", mute_entries(key.clone(), state.clone())));
    }
    entries.push(if item.hidden {
        MenuEntry::new("Show in list", "eye", toggle("hidden", prefs.hidden.clone(), key.clone(), state.clone()))
    } else {
        MenuEntry::new("Hide from list", "eye-off", toggle("hidden", prefs.hidden.clone(), key.clone(), state.clone()))
    });
    entries
}
