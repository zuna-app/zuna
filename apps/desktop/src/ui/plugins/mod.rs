//! The places in the interface plugins fill: buttons in a chat's header and beside the message
//! box, entries in a message's and a chat's menus, actions on a message under the pointer,
//! items in the rail with pages of their own, side panels, dialogs, and what they add to a
//! message. Each is drawn by the app, in its own components, and what an unverified plugin adds
//! wears its mark. The broker (plugins/broker.rs) decides what a plugin may register; this only
//! draws what's registered by a plugin that's running.

pub mod dialog;
pub mod install;
#[cfg(test)]
mod tests;
pub mod view;

use gpui::{AnyElement, App, Div, FontWeight, IntoElement, ParentElement, Styled, div, prelude::*, px};
use serde_json::{Value, json};

use crate::models::{ConversationView, MessageView};
use crate::plugins::{Decoration, Plugins};
use crate::theme::RADIUS_S;
use crate::ui::components::*;
use crate::ui::menu::MenuEntry;

/// The mark an unverified plugin wears wherever its name shows: "Unverified", in the danger color.
pub fn unverified_mark(cx: &App) -> Div {
    let theme = theme(cx);
    div()
        .flex_none()
        .flex()
        .items_center()
        .h(px(16.))
        .px(px(6.))
        .rounded(px(4.))
        .text_size(px(10.))
        .line_height(px(16.))
        .font_weight(FontWeight::SEMIBOLD)
        .bg(theme.red_soft)
        .text_color(theme.red)
        .child("Unverified")
}

/// A plugin's name as its frames show it, with its mark when it isn't verified.
pub fn plugin_name(uid: &str, cx: &App) -> Div {
    let theme = theme(cx);
    let (name, verified) = crate::plugins::get(cx).map(|plugins| {
        let plugins = plugins.read(cx);
        (plugins.name(uid), plugins.verified(uid))
    }).unwrap_or_else(|| ("A plugin".into(), false));
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .min_w_0()
        .child(icon("puzzle", 13., theme.text3))
        .child(div().text_size(px(12.)).text_color(theme.text3).one_line().child(name))
        .when(!verified, |el| el.child(unverified_mark(cx)))
}

fn with_plugins<T>(cx: &App, read: impl FnOnce(&Plugins) -> T) -> Option<T> {
    crate::plugins::get(cx).map(|plugins| read(plugins.read(cx)))
}

fn press(uid: String, kind: &'static str, id: String, target: Value, cx: &mut App) {
    if let Some(plugins) = crate::plugins::get(cx) {
        plugins.update(cx, |plugins, cx| {
            let target = if matches!(kind, "headerButton" | "composerButton") { plugins.context_for(&uid, "", cx) } else { target };
            plugins.action(&uid, kind, &id, target, cx)
        });
    }
}

/// What the person is told a button does: its title, and whose it is.
pub fn title_of(uid: &str, title: &str, cx: &App) -> String {
    let (name, verified) = with_plugins(cx, |plugins| (plugins.name(uid), plugins.verified(uid))).unwrap_or_default();
    if verified { format!("{title} ({name})") } else { format!("{title} ({name}, unverified)") }
}

/// The buttons plugins put in a chat's header.
pub fn header_buttons(cx: &mut App) -> Vec<AnyElement> {
    let slots = with_plugins(cx, |plugins| plugins.each_slot(|slots| &slots.header_buttons)).unwrap_or_default();
    slots
        .into_iter()
        .map(|(uid, slot)| {
            let tip = title_of(&uid, &slot.title, cx);
            let (owner, id) = (uid.clone(), slot.id.clone());
            icon_button(gpui::ElementId::Name(format!("plugin-header-{uid}-{}", slot.id).into()), &slot.icon, 17., false, false, cx)
                .tip(tip, Side::Bottom)
                .on_click(move |_, _, cx| press(owner.clone(), "headerButton", id.clone(), Value::Null, cx))
                .into_any_element()
        })
        .collect()
}

/// The buttons plugins put beside the message box.
pub fn composer_buttons(cx: &mut App) -> Vec<AnyElement> {
    let slots = with_plugins(cx, |plugins| plugins.each_slot(|slots| &slots.composer_buttons)).unwrap_or_default();
    slots
        .into_iter()
        .map(|(uid, slot)| {
            let tip = title_of(&uid, &slot.title, cx);
            let (owner, id) = (uid.clone(), slot.id.clone());
            icon_button(gpui::ElementId::Name(format!("plugin-composer-{uid}-{}", slot.id).into()), &slot.icon, 18., false, false, cx)
                .tip(tip, Side::Top)
                .on_click(move |_, _, cx| press(owner.clone(), "composerButton", id.clone(), Value::Null, cx))
                .into_any_element()
        })
        .collect()
}

/// What a plugin is told of a message it acts on: the message with `messages.read`, its ids without.
fn message_target(uid: &str, server_id: &str, message: &MessageView, cx: &App) -> Value {
    let reads = with_plugins(cx, |plugins| plugins.granted(uid, crate::plugins::manifest::Permission::MessagesRead)).unwrap_or(false);
    if reads {
        crate::plugins::broker::plugin_message(server_id, &serde_json::to_value(message).unwrap_or_default())
    } else {
        json!({ "serverId": server_id, "groupId": message.group_id, "id": message.id })
    }
}

/// The entries plugins put in a message's menu, after a line.
pub fn message_entries(server_id: &str, message: &MessageView, cx: &App) -> Vec<MenuEntry> {
    let slots = with_plugins(cx, |plugins| plugins.each_slot(|slots| &slots.message_actions)).unwrap_or_default();
    if slots.is_empty() || message.system.is_some() {
        return Vec::new();
    }
    let mut entries = vec![MenuEntry::separator()];
    for (uid, slot) in slots {
        let verified = with_plugins(cx, |plugins| plugins.verified(&uid)).unwrap_or(false);
        let label = if verified { slot.title.clone() } else { format!("{} · Unverified", slot.title) };
        let target = message_target(&uid, server_id, message, cx);
        let icon = crate::assets::static_icon(&slot.icon).unwrap_or("puzzle");
        entries.push(MenuEntry::new(label, icon, move |_, cx| press(uid.clone(), "messageAction", slot.id.clone(), target.clone(), cx)));
    }
    entries
}

/// The actions plugins put on a message under the pointer.
pub fn hover_actions(server_id: &str, message: &MessageView, cx: &mut App) -> Vec<AnyElement> {
    let slots = with_plugins(cx, |plugins| plugins.each_slot(|slots| &slots.message_actions)).unwrap_or_default();
    if message.system.is_some() {
        return Vec::new();
    }
    let theme = theme(cx);
    slots
        .into_iter()
        .filter(|(_, slot)| slot.hover)
        .map(|(uid, slot)| {
            let tip = title_of(&uid, &slot.title, cx);
            let target = message_target(&uid, server_id, message, cx);
            let (owner, id) = (uid.clone(), slot.id.clone());
            icon_button_in(gpui::ElementId::Name(format!("plugin-hover-{uid}-{}-{}", slot.id, message.id).into()), &slot.icon, 16., true, false, theme.text3, cx)
                .tip(tip, Side::Top)
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    press(owner.clone(), "messageAction", id.clone(), target.clone(), cx)
                })
                .into_any_element()
        })
        .collect()
}

/// The entries plugins put in a chat's menu in the conversation list.
pub fn conversation_entries(server_id: &str, conversation: &ConversationView, cx: &App) -> Vec<MenuEntry> {
    let slots = with_plugins(cx, |plugins| plugins.each_slot(|slots| &slots.conversation_actions)).unwrap_or_default();
    if slots.is_empty() {
        return Vec::new();
    }
    let mut entries = vec![MenuEntry::separator()];
    for (uid, slot) in slots {
        let (verified, reads) = with_plugins(cx, |plugins| (plugins.verified(&uid), plugins.granted(&uid, crate::plugins::manifest::Permission::ConversationsRead))).unwrap_or_default();
        let label = if verified { slot.title.clone() } else { format!("{} · Unverified", slot.title) };
        let target = if reads {
            json!({ "serverId": server_id, "key": conversation.key, "groupId": conversation.group_id, "name": conversation.title })
        } else {
            json!({ "serverId": server_id, "key": conversation.key, "groupId": conversation.group_id, "name": "" })
        };
        let icon = crate::assets::static_icon(&slot.icon).unwrap_or("puzzle");
        entries.push(MenuEntry::new(label, icon, move |_, cx| press(uid.clone(), "conversationAction", slot.id.clone(), target.clone(), cx)));
    }
    entries
}

/// The items plugins put in the rail: the plugin, its page's id, its title and icon.
pub fn rail_items(cx: &App) -> Vec<(String, crate::plugins::Slot)> {
    with_plugins(cx, |plugins| plugins.each_slot(|slots| &slots.pages)).unwrap_or_default()
}

/// Opens a plugin's page from its item in the rail, or its panel from wherever offers it.
pub fn open(uid: &str, kind: &str, id: &str, cx: &mut App) {
    let Some(plugins) = crate::plugins::get(cx) else { return };
    let handle = plugins.update(cx, |plugins, _| plugins.handle(uid, kind, id));
    let state = crate::state::store(cx);
    let kind = kind.to_string();
    state.update(cx, |state, cx| state.open_plugin_view(&kind, handle, cx));
}

/// A plugin's view in one of its frames: nothing while a security question is up, and a line
/// saying it's still starting until it has drawn.
pub fn body(handle: u32, cx: &mut App) -> AnyElement {
    let theme = theme(cx);
    let Some(plugins) = crate::plugins::get(cx) else { return div().into_any_element() };
    let Some((uid, kind, id)) = plugins.read(cx).of_handle(handle) else { return div().into_any_element() };
    if crate::plugins::security_question_up(cx) {
        return div().into_any_element();
    }
    let view_id = format!("{kind}:{id}");
    let node = plugins.read(cx).view(&uid, &view_id).cloned();
    match node {
        Some(node) => view::render(&uid, &node, cx),
        None => div().flex().items_center().gap(px(8.)).text_color(theme.text3).child(spinner(14., theme.text3)).child("Starting…").into_any_element(),
    }
}

/// A plugin's panel or page's title, and whose it is.
pub fn title(handle: u32, cx: &App) -> Option<(String, String)> {
    with_plugins(cx, |plugins| {
        let (uid, kind, id) = plugins.of_handle(handle)?;
        let slots = plugins.slots.get(&uid)?;
        let slot = match kind.as_str() {
            "panel" => slots.panels.get(&id),
            "page" => slots.pages.get(&id),
            _ => slots.dialog.as_ref(),
        }?;
        Some((slot.title.clone(), uid))
    })
    .flatten()
}

/// What plugins added to a message, for the message to draw.
pub fn decorations(server_id: &str, message: &MessageView, cx: &App) -> Vec<Decoration> {
    with_plugins(cx, |plugins| plugins.decorations_for(server_id, message)).unwrap_or_default()
}

/// Whether the person asked to see a message's own text instead of a plugin's.
pub fn showing_original(server_id: &str, message: &MessageView, cx: &App) -> bool {
    with_plugins(cx, |plugins| plugins.shown_original.contains(&crate::plugins::decoration_key(server_id, message))).unwrap_or(false)
}

/// The line under a message a plugin changed or hid, which the plugin doesn't draw: which plugin
/// did it, and one click to show the original, or its version again.
pub fn changed_line(server_id: &str, message: &MessageView, decoration: &Decoration, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let key = crate::plugins::decoration_key(server_id, message);
    let showing = showing_original(server_id, message, cx);
    let what = if decoration.hidden { "Hidden" } else { "Changed" };
    div()
        .flex()
        .items_center()
        .gap(px(6.))
        .mt(px(2.))
        .text_size(px(11.5))
        .text_color(theme.text3)
        .child(icon("puzzle", 11., theme.text3))
        .child(format!("{what} by {}", decoration.name))
        .when(!decoration.verified, |el| el.child(unverified_mark(cx)))
        .child(
            div()
                .id(gpui::ElementId::Name(format!("show-original-{key}").into()))
                .text_color(theme.link)
                .cursor_pointer()
                .child(if showing { "Show the plugin's version" } else { "Show the original" })
                .on_click(move |_, _, cx| {
                    cx.stop_propagation();
                    if let Some(plugins) = crate::plugins::get(cx) {
                        let key = key.clone();
                        plugins.update(cx, |plugins, cx| plugins.toggle_original(key, cx));
                    }
                }),
        )
        .into_any_element()
}

/// The marks and views plugins put beside and under a message.
pub fn extras(decorations: &[Decoration], cx: &mut App) -> Option<AnyElement> {
    let theme = theme(cx);
    let marks: Vec<AnyElement> = decorations
        .iter()
        .filter_map(|decoration| decoration.mark.as_ref().map(|mark| (decoration, mark)))
        .map(|(decoration, (icon_name, label))| {
            div()
                .flex()
                .items_center()
                .gap(px(4.))
                .px(px(6.))
                .h(px(18.))
                .rounded(RADIUS_S)
                .bg(theme.bg3)
                .text_size(px(11.))
                .text_color(theme.text2)
                .when_some(icon_name.as_deref(), |el, name| el.child(icon(name, 11., theme.text2)))
                .child(label.clone())
                .when(!decoration.verified, |el| el.child(unverified_mark(cx)))
                .into_any_element()
        })
        .collect();
    let views: Vec<AnyElement> = decorations
        .iter()
        .filter_map(|decoration| decoration.view.as_ref().map(|(_, node)| (decoration, node)))
        .map(|(decoration, node)| {
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .mt(px(4.))
                .pl(px(8.))
                .border_l_2()
                .border_color(theme.line_strong)
                .child(view::render(&decoration.uid, node, cx))
                .child(div().flex().items_center().gap(px(5.)).text_size(px(10.5)).text_color(theme.text3).child(decoration.name.clone()).when(!decoration.verified, |el| el.child(unverified_mark(cx))))
                .into_any_element()
        })
        .collect();
    if marks.is_empty() && views.is_empty() {
        return None;
    }
    Some(div().flex().flex_col().gap(px(2.)).when(!marks.is_empty(), |el| el.child(div().flex().flex_wrap().gap(px(4.)).mt(px(3.)).children(marks))).children(views).into_any_element())
}
