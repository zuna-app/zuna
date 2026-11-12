//! Message lists: loading them, jumping around in them, and what's picked, answered or edited
//! in each.

use super::*;

impl AppState {
    /// The newest page, and with unread messages, the pages back to the first of them.
    pub fn load_list(&mut self, list_id: &str, group_id: Option<String>, cx: &mut Context<Self>) {
        if let Some(existing) = self.lists.get(list_id) {
            if existing.loaded || existing.loading {
                return;
            }
        }
        let list = self.lists.entry(list_id.to_string()).or_insert_with(|| MessageList { has_more: true, ..Default::default() });
        list.loading = true;
        let Some(group_id) = group_id else {
            list.loading = false;
            list.loaded = true;
            list.has_more = false;
            return;
        };
        let Some(server) = self.active() else { return };
        let server_id = server.entry.id.clone();
        let self_id = server.self_id().to_string();
        let blocked = server.prefs.blocked().to_vec();
        let (own_read, unread) = server
            .conversations
            .iter()
            .find(|item| item.group_id.as_deref() == Some(group_id.as_str()))
            .or_else(|| server.channels.iter().find(|channel| channel.id == group_id).and_then(|channel| channel.conversation.as_ref()))
            .map(|conversation| (conversation.own_read, conversation.unread))
            .unwrap_or((0.0, 0.0));
        let core = self.core.clone();
        let list_id = list_id.to_string();
        cx.spawn(async move |this, cx| {
            let mut page: MessagePage = match core.call(Some(&server_id), "loadMessages", vec![json!(group_id)]).await {
                Ok(value) => from_value(value),
                Err(error) => {
                    this.update(cx, |state, cx| {
                        if let Some(list) = state.lists.get_mut(&list_id) {
                            list.loading = false;
                        }
                        state.toast(error.message, ToastKind::Error, cx);
                    })
                    .ok();
                    return;
                }
            };
            let unread_in = |messages: &[MessageView]| messages.iter().filter(|m| is_unread(m, own_read, &self_id, &blocked)).count() as f64;
            let mut pages = 1;
            while page.has_more && pages < UNREAD_PAGES && unread_in(&page.messages) < unread {
                let Some(oldest) = page.messages.iter().find_map(|message| message.seq) else { break };
                if oldest <= own_read + 1.0 {
                    break;
                }
                let Ok(value) = core.call(Some(&server_id), "loadMessages", vec![json!(group_id), json!(oldest)]).await else { break };
                let older: MessagePage = from_value(value);
                let mut messages = older.messages;
                messages.append(&mut page.messages);
                page.messages = messages;
                page.has_more = older.has_more;
                pages += 1;
            }
            this.update(cx, |state, cx| {
                let list = state.lists.entry(list_id.clone()).or_default();
                let mut by_id: HashMap<String, MessageView> = page.messages.into_iter().map(|m| (m.id.clone(), m)).collect();
                for item in list.items.drain(..) {
                    by_id.entry(item.id.clone()).or_insert(item);
                }
                let mut items: Vec<MessageView> = by_id.into_values().collect();
                sort_messages(&mut items);
                list.items = items;
                list.has_more = page.has_more;
                list.loading = false;
                list.loaded = true;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn load_older(&mut self, list_id: &str, cx: &mut Context<Self>) {
        let Some(server_id) = self.active_server.clone() else { return };
        let Some(list) = self.lists.get_mut(list_id) else { return };
        // In a window around a message jumped to too, which reads on both ways.
        if list.loading || !list.has_more {
            return;
        }
        let Some(oldest) = list.items.iter().find_map(|item| item.seq) else { return };
        list.loading = true;
        let list_id = list_id.to_string();
        self.call(Some(&server_id), "loadMessages", vec![json!(list_id), json!(oldest)], cx, move |state, result, cx| {
            let Some(list) = state.lists.get_mut(&list_id) else { return };
            list.loading = false;
            if let Ok(value) = result {
                let page: MessagePage = from_value(value);
                let known: HashSet<String> = list.items.iter().map(|item| item.id.clone()).collect();
                let mut older: Vec<MessageView> = page.messages.into_iter().filter(|m| !known.contains(&m.id)).collect();
                older.append(&mut list.items);
                list.items = older;
                list.has_more = page.has_more;
            }
            cx.notify();
        });
    }

    /// Reads on from a window around a message jumped to, a page at a time, until it reaches the
    /// newest, where it takes new messages again.
    pub fn load_newer(&mut self, list_id: &str, cx: &mut Context<Self>) {
        let Some(server_id) = self.active_server.clone() else { return };
        let Some(list) = self.lists.get_mut(list_id) else { return };
        if list.loading || !list.detached || !list.has_newer {
            return;
        }
        let Some(newest) = list.items.iter().rev().find_map(|item| item.seq) else { return };
        list.loading = true;
        let list_id = list_id.to_string();
        let core = self.core.clone();
        cx.spawn(async move |this, cx| {
            let page: Option<MessagePage> = core.call(Some(&server_id), "loadNewer", vec![json!(list_id), json!(newest)]).await.ok().map(from_value);
            let caught_up = page.as_ref().is_some_and(|page| !page.has_more);
            let mut end = newest;
            this.update(cx, |state, cx| {
                let Some(list) = state.lists.get_mut(&list_id).filter(|list| list.detached && list.has_newer) else { return };
                list.loading = false;
                if let Some(page) = page {
                    let known: HashSet<String> = list.items.iter().map(|item| item.id.clone()).collect();
                    list.items.extend(page.messages.into_iter().filter(|m| !known.contains(&m.id)));
                    sort_messages(&mut list.items);
                    list.has_newer = page.has_more;
                    end = list.items.iter().rev().find_map(|item| item.seq).unwrap_or(newest);
                }
                cx.notify();
            })
            .ok();
            if !caught_up {
                return;
            }
            // What came while the window wasn't taking new messages, between that page and now.
            let Ok(value) = core.call(Some(&server_id), "loadMessages", vec![json!(list_id)]).await else { return };
            let latest: MessagePage = from_value(value);
            this.update(cx, |state, cx| {
                let Some(list) = state.lists.get_mut(&list_id).filter(|list| list.detached && !list.has_newer) else { return };
                for message in latest.messages {
                    if let Some(index) = list.items.iter().position(|item| item.id == message.id) {
                        list.items[index] = message;
                    } else if message.seq.is_none_or(|seq| seq > end) {
                        list.items.push(message);
                    }
                }
                sort_messages(&mut list.items);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn jump_to_message(&mut self, group_id: &str, message_id: &str, cx: &mut Context<Self>) {
        let present = self.lists.get(group_id).is_some_and(|list| list.items.iter().any(|item| item.id == message_id));
        let nonce = now_ms() as u64;
        if present {
            self.jump_target = Some((group_id.to_string(), message_id.to_string(), nonce));
            cx.notify();
            return;
        }
        let Some(server_id) = self.active_server.clone() else { return };
        let core = self.core.clone();
        let group = group_id.to_string();
        let id = message_id.to_string();
        cx.spawn(async move |this, cx| {
            let found = core.call(Some(&server_id), "messageById", vec![json!(group), json!(id)]).await.ok();
            let seq = found.and_then(|value| value.get("seq").and_then(Value::as_f64));
            let Some(seq) = seq else {
                this.update(cx, |state, cx| state.toast("That message isn't available.", ToastKind::Info, cx)).ok();
                return;
            };
            let Ok(window) = core.call(Some(&server_id), "loadAround", vec![json!(group), json!(seq)]).await else { return };
            let mut items: Vec<MessageView> = from_value(window);
            sort_messages(&mut items);
            this.update(cx, |state, cx| {
                state.lists.insert(group.clone(), MessageList { items, has_more: true, loading: false, loaded: true, detached: true, has_newer: true });
                state.jump_target = Some((group, id, nonce));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn return_to_latest(&mut self, list_id: &str, cx: &mut Context<Self>) {
        self.lists.remove(list_id);
        self.load_list(list_id, Some(list_id.to_string()), cx);
        cx.notify();
    }

    /// Tells the server how far this person has read, one position at a time.
    pub fn mark_read(&mut self, group_id: &str, seq: f64, cx: &mut Context<Self>) {
        if self.reading.get(group_id).is_some_and(|sent| *sent >= seq) {
            return;
        }
        self.reading.insert(group_id.to_string(), seq);
        let Some(server) = self.active_server.clone() else { return };
        let payload = json!({ "serverId": server, "groupId": group_id, "conversationKey": null });
        self.act_filtered(&server, crate::plugins::FilterKind::Read, payload, "markRead", vec![json!(group_id), json!(seq)], cx);
    }

    /// Picks or unpicks a message, or with none stops picking (toggleSelected).
    pub fn toggle_selected(&mut self, list_id: &str, id: Option<&str>, cx: &mut Context<Self>) {
        let Some(id) = id else {
            self.selection = None;
            cx.notify();
            return;
        };
        let mut ids = match &self.selection {
            Some((list, ids)) if list == list_id => ids.clone(),
            _ => Vec::new(),
        };
        if let Some(index) = ids.iter().position(|item| item == id) {
            ids.remove(index);
        } else {
            ids.push(id.to_string());
        }
        self.selection = (!ids.is_empty()).then(|| (list_id.to_string(), ids));
        cx.notify();
    }

    pub fn set_reply(&mut self, list_id: &str, message: Option<MessageView>, cx: &mut Context<Self>) {
        match message {
            Some(message) => {
                self.editing.remove(list_id);
                self.reply_to.insert(list_id.to_string(), message);
            }
            None => {
                self.reply_to.remove(list_id);
            }
        }
        cx.notify();
    }

    pub fn set_editing(&mut self, list_id: &str, message: Option<MessageView>, cx: &mut Context<Self>) {
        match message {
            Some(message) => {
                self.reply_to.remove(list_id);
                self.editing.insert(list_id.to_string(), message);
            }
            None => {
                self.editing.remove(list_id);
            }
        }
        cx.notify();
    }

    // --- Overlays, panels, toasts and settings ---
}
