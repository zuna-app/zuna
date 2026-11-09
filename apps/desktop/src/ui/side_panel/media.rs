//! What's been shared in a chat, counted by kind, and each kind's pages.

use super::*;

impl SidePanel {
    /// Counts what's been shared, again whenever the chat's messages may have changed.
    pub(super) fn ensure_counts(&mut self, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else {
            self.counts = None;
            return;
        };
        let loaded = self.state.read(cx).lists.get(&group).map(|list| list.items.len()).unwrap_or(0);
        let key = (group.clone(), conversation.last_activity_at.to_bits(), loaded);
        if self.counts_for.as_ref() == Some(&key) {
            return;
        }
        self.counts_for = Some(key.clone());
        let call = self.state.read(cx).core.call(Some(&self.server_id), "mediaCounts", vec![json!(group)]);
        cx.spawn(async move |panel, cx| {
            let Ok(found) = call.await else { return };
            let counts: HashMap<String, f64> = found.as_object().map(|map| map.iter().filter_map(|(kind, count)| Some((kind.clone(), count.as_f64()?))).collect()).unwrap_or_default();
            panel
                .update(cx, |panel, cx| {
                    if panel.counts_for.as_ref() == Some(&key) {
                        panel.counts = Some(counts);
                        cx.notify();
                    }
                })
                .ok();
        })
        .detach();
    }

    /// How many photos, files, links and so on are in the chat, one row each.
    pub(super) fn media_rows(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.ensure_counts(conversation, cx);
        let groups = if conversation.kind == "group" { 0 } else { shared_media::groups_in_common(server, conversation.peer_id.as_deref()).len() };
        // All the rows at once, rather than the groups in common before the counts.
        if conversation.group_id.is_some() && self.counts.is_none() {
            return None;
        }
        let mut section = Self::section(cx);
        let mut any = false;
        for (kind, icon_name, one, many, _) in shared_media::KINDS {
            let count = if kind == SharedKind::Groups { groups as f64 } else { self.counts.as_ref().and_then(|counts| counts.get(shared_media::core_name(kind))).copied().unwrap_or(0.) };
            if count <= 0. {
                continue;
            }
            any = true;
            let state = self.state.clone();
            section = section.child(Self::row(format!("media-{}", shared_media::core_name(kind)), icon_name, format!("{} {}", count as u64, if count == 1. { one } else { many }), None, false, cx).on_click(move |_, _, cx| {
                state.update(cx, |state, cx| {
                    state.panel = Some(Panel::Media(kind));
                    cx.notify();
                })
            }));
        }
        any.then(|| section.into_any_element())
    }

    /// Loads one kind, newest first, again whenever the chat changes so deletions and edits show.
    pub(super) fn ensure_media(&mut self, kind: SharedKind, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else { return };
        let loaded = self.state.read(cx).lists.get(&group).map(|list| list.items.len()).unwrap_or(0);
        let key = (kind, group.clone(), conversation.last_activity_at.to_bits(), loaded);
        if self.media_for.as_ref() == Some(&key) {
            return;
        }
        if self.media_for.as_ref().is_some_and(|(shown, ..)| *shown != kind) {
            self.media = None;
        }
        self.media_for = Some(key.clone());
        let count = self.media.as_ref().map(|(messages, _)| messages.len()).unwrap_or(0).max(50);
        let call = self.state.read(cx).core.call(Some(&self.server_id), "loadMedia", vec![json!(group), json!(shared_media::core_name(kind)), serde_json::Value::Null, json!(count)]);
        cx.spawn(async move |panel, cx| {
            let result = call.await;
            panel
                .update(cx, |panel, cx| {
                    if panel.media_for.as_ref() != Some(&key) {
                        return;
                    }
                    let page = result.unwrap_or_default();
                    let messages: Vec<MessageView> = crate::models::from_value(page.get("messages").cloned().unwrap_or_default());
                    let has_more = page.get("hasMore").and_then(|more| more.as_bool()).unwrap_or(false);
                    panel.media = Some((messages, has_more));
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    /// The next page, once the list is scrolled near its end.
    pub(super) fn load_more_media(&mut self, kind: SharedKind, conversation: &ConversationView, cx: &mut Context<Self>) {
        let Some(group) = conversation.group_id.clone() else { return };
        let Some((messages, true)) = &self.media else { return };
        let Some(oldest) = messages.last().and_then(|message| message.seq) else { return };
        if self.media_loading {
            return;
        }
        self.media_loading = true;
        let call = self.state.read(cx).core.call(Some(&self.server_id), "loadMedia", vec![json!(group), json!(shared_media::core_name(kind)), json!(oldest)]);
        cx.spawn(async move |panel, cx| {
            let result = call.await;
            panel
                .update(cx, |panel, cx| {
                    panel.media_loading = false;
                    let Ok(page) = result else { return };
                    let more: Vec<MessageView> = crate::models::from_value(page.get("messages").cloned().unwrap_or_default());
                    let has_more = page.get("hasMore").and_then(|more| more.as_bool()).unwrap_or(false);
                    if let Some((messages, flag)) = &mut panel.media {
                        let have: std::collections::HashSet<String> = messages.iter().map(|message| message.id.clone()).collect();
                        messages.extend(more.into_iter().filter(|message| !have.contains(&message.id)));
                        *flag = has_more;
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    // --- Groups and channels ---
}
