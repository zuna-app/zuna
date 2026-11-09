//! A message's reactions, and its menu.

use super::*;

pub(super) fn reaction_chip(reaction: &ReactionView, message: &MessageView, own: bool, jumbo: bool, show_people: bool, context: &ChatContext, theme: &Theme, cx: &mut App) -> AnyElement {
    let mine = reaction.user_ids.contains(&context.self_id);
    let names = reaction.user_ids.iter().map(|id| name_of(context, id)).collect::<Vec<_>>().join(", ");
    let (bg, fg, hover) = if mine {
        if !theme.neutral && own { (gpui::white(), theme::color(theme::hex(0x111113)), gpui::white()) } else { (theme.text1, theme.bg1, gpui::white()) }
    } else if jumbo {
        (theme.bg3, theme.text1, theme.bg4)
    } else {
        (theme::color(theme::white_a(0.08)), if own { theme.bubble_own_text } else { theme.text1 }, theme::color(theme::white_a(0.13)))
    };
    let state = context.state.clone();
    let (group, id, key) = (message.group_id.clone(), message.id.clone(), reaction.key.clone());
    let emote = reaction.emote.clone();
    // `.reaction`: its background comes up over 100 ms under the pointer.
    let hover_key = format!("reaction-{}-{}", message.id, reaction.key);
    let mut chip = crate::ui::motion::track_hover(div().id(SharedString::from(hover_key.clone())), hover_key.clone())
        .relative()
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(24.))
        .pl(px(6.))
        .pr(px(7.))
        .rounded(px(12.))
        .bg(bg)
        .text_color(fg)
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .child(crate::ui::motion::hover_layer(&hover_key, hover, px(12.), 100))
        // An emote's card says who reacted, in place of the tooltip.
        .when(reaction.emote.is_none(), |el| el.tip(names.clone(), Side::Top))
        .on_click(move |_, _, cx| {
            let mut args = vec![json!(group), json!(id), json!(key)];
            if let Some(emote) = &emote {
                args.push(serde_json::to_value(emote).unwrap_or_default());
            }
            state.update(cx, |state, cx| state.act("toggleReaction", args, cx))
        });
    chip = match &reaction.emote {
        Some(emote) => {
            let url = crate::models::emote_url(&context.server_url, &emote.id);
            match context.state.update(cx, |state, cx| state.remote_picture(&url, cx)) {
                Some(image) => {
                    let picture = img(image).h(px(18.)).when_some(emote_width(context, &emote.id, 18., 40.), |el, width| el.w(px(width))).max_w(px(40.)).object_fit(gpui::ObjectFit::Contain).id(SharedString::from(format!("reaction-emote-{}-{}", message.id, reaction.key)));
                    chip.child(with_emote_card(picture, SharedString::from(format!("reaction-card-{}-{}", message.id, reaction.key)), &reaction.key, emote, Some(format!("Reacted by {names}")), context, cx))
                }
                None => chip.child(emote_placeholder(context, &url, &reaction.key, emote_width(context, &emote.id, 18., 40.), 18., cx)),
            }
        }
        None => chip.child(div().text_size(px(14.)).line_height(px(14.)).child(reaction.key.clone())),
    };
    if show_people {
        let mut people = div().flex().ml(px(1.));
        for (index, user_id) in reaction.user_ids.iter().enumerate() {
            let name = context.users.get(user_id).map(|u| u.display_name.clone()).unwrap_or("?".into());
            let image = context.avatars.get(user_id).cloned();
            let mut face = avatar(AvatarProps { name, seed: user_id.clone(), image, size: 16., online: false, rounded: false, dot_border: bg }, cx).text_size(px(7.)).line_height(px(9.));
            if index > 0 {
                face = face.ml(px(-5.));
            }
            people = people.child(face);
        }
        chip = chip.child(people);
    } else {
        chip = chip.child(reaction.user_ids.len().to_string());
    }
    // `.reaction`: pop-in 0.1s, when it's first there.
    chip.enter_once(format!("reaction-in-{}-{}", message.id, reaction.key), Enter::Pop, 100)
}

pub(in crate::ui) fn menu_entries(message: &MessageView, own: bool, can_act: bool, context: &ChatContext) -> Vec<MenuEntry> {
    let mut entries = Vec::new();
    let state = context.state.clone();
    let list_id = context.list_id.clone();
    let group = message.group_id.clone();
    let id = message.id.clone();
    let is_deleted = message.deleted_at.is_some();
    if can_act {
        let (state, list_id, message) = (state.clone(), list_id.clone(), message.clone());
        entries.push(MenuEntry::new("Reply", "corner-up-left", move |_, cx| state.update(cx, |state, cx| state.set_reply(&list_id, Some(message.clone()), cx))));
        let (forward_state, server_id, forward_group, forward_id) = (context.state.clone(), context.server_id.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Forward", "forward", move |_, cx| {
            let overlay = Overlay::Forward { server_id: server_id.clone(), group_id: forward_group.clone(), ids: vec![forward_id.clone()] };
            forward_state.update(cx, |state, cx| state.set_overlay(Some(overlay), cx))
        }));
        let (select_state, select_list, select_id) = (context.state.clone(), context.list_id.clone(), id.clone());
        entries.push(MenuEntry::new("Select", "circle-check", move |_, cx| select_state.update(cx, |state, cx| state.toggle_selected(&select_list, Some(&select_id), cx))));
    }
    if !message.text.is_empty() && !is_deleted {
        // What's selected in it, if anything, as the web's "Copy selection".
        let selected = selection::text_in(&message.id);
        let label = if selected.is_some() { "Copy selection" } else { "Copy text" };
        let (state, text) = (state.clone(), selected.unwrap_or_else(|| message.text.clone()));
        entries.push(MenuEntry::new(label, "copy", move |_, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text.clone()));
            state.update(cx, |state, cx| state.toast("Copied", ToastKind::Info, cx));
        }));
    }
    if can_act && own && !message.text.is_empty() && message.forwarded.is_none() {
        let (state, list_id, message) = (state.clone(), list_id.clone(), message.clone());
        entries.push(MenuEntry::new("Edit", "pencil", move |_, cx| state.update(cx, |state, cx| state.set_editing(&list_id, Some(message.clone()), cx))));
    }
    if can_act {
        let pinned = message.pinned_at.is_some();
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new(if pinned { "Unpin" } else { "Pin" }, if pinned { "pin-off" } else { "pin" }, move |_, cx| {
            state.update(cx, |state, cx| state.act("setPinned", vec![json!(group), json!(id), json!(!pinned)], cx))
        }));
    }
    // Who in a group has read your message, as far as their read receipts say.
    if let (true, true, true, Some(seq)) = (own, context.is_group, can_act, message.seq) {
        let mut readers: Vec<&UserView> = context
            .members
            .iter()
            .filter(|member| **member != context.self_id && context.read_by.get(*member).copied().unwrap_or(0.) >= seq)
            .filter_map(|member| context.users.get(member))
            .collect();
        readers.sort_by_cached_key(|user| user.display_name.to_lowercase());
        if !readers.is_empty() {
            let people = readers
                .iter()
                .map(|user| {
                    let (state, key) = (state.clone(), format!("user:{}", user.id));
                    MenuEntry::new(user.display_name.clone(), "user", move |_, cx| state.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx)))
                        .with_avatar(user.display_name.clone(), user.id.clone(), context.avatars.get(&user.id).cloned())
                })
                .collect();
            entries.push(MenuEntry::submenu(format!("Read by {}", readers.len()), "check-check", people));
        }
    }
    if message.status == "failed" {
        let (retry_state, group_a, id_a) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Try again", "refresh-cw", move |_, cx| retry_state.update(cx, |state, cx| state.act("retryMessage", vec![json!(group_a), json!(id_a)], cx))));
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Discard", "trash", move |_, cx| state.update(cx, |state, cx| state.act("discardMessage", vec![json!(group), json!(id)], cx))).danger());
    }
    if can_act && (own || (context.is_group && context.is_group_admin)) {
        entries.push(MenuEntry::separator());
        let (state, group, id) = (state.clone(), group.clone(), id.clone());
        entries.push(MenuEntry::new("Delete for everyone", "trash", move |_, cx| state.update(cx, |state, cx| state.act("deleteMessage", vec![json!(group), json!(id)], cx))).danger());
    }
    entries
}
