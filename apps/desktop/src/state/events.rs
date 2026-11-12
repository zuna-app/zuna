//! The core's events, and refreshing what they say has changed.

use super::*;

impl AppState {
    pub fn refresh_conversations(&mut self, server_id: &str, cx: &mut Context<Self>) {
        let id = server_id.to_string();
        self.debounced(format!("conversations:{id}"), 60, cx, move |state, cx| {
            let core = state.core.clone();
            cx.spawn(async move |this, cx| {
                let asked = now_ms();
                let conversations = core.call(Some(&id), "getConversations", vec![]).await;
                let channels = core.call(Some(&id), "getChannels", vec![]).await;
                this.update(cx, |state, cx| {
                    if let Some(server) = state.servers.get_mut(&id) {
                        if let Ok(conversations) = conversations {
                            server.conversations = from_value(conversations);
                        }
                        if let Ok(channels) = channels {
                            server.channels = from_value(channels);
                        }
                        cx.notify();
                    }
                    state.update_badge(cx);
                    state.clear_read(&id, asked, cx);
                })
                .ok();
            })
            .detach();
        });
    }

    /// Someone else reading on only moves the ticks in one conversation, so it's set
    /// there, rather than every conversation and channel fetched again for each
    /// receipt. This person's own comes with "conversations" too, for what's unread.
    pub(super) fn read_moved(&mut self, server_id: &str, event: &Value, cx: &mut Context<Self>) {
        let (Some(group), Some(user), Some(seq)) = (
            event.get("groupId").and_then(Value::as_str),
            event.get("userId").and_then(Value::as_str),
            event.get("seq").and_then(Value::as_f64),
        ) else {
            return;
        };
        let Some(server) = self.servers.get_mut(server_id) else { return };
        if server.me.as_ref().is_some_and(|me| me.user_id == user) {
            return;
        }
        let mut moved = false;
        for conversation in server.conversations.iter_mut().filter(|conversation| conversation.group_id.as_deref() == Some(group)) {
            let read = conversation.read_by.entry(user.to_string()).or_insert(0.);
            if seq > *read {
                *read = seq;
                moved = true;
            }
        }
        if moved {
            cx.notify();
        }
    }

    pub fn refresh_users(&mut self, server_id: &str, cx: &mut Context<Self>) {
        let id = server_id.to_string();
        self.debounced(format!("users:{id}"), 60, cx, move |state, cx| {
            let core = state.core.clone();
            cx.spawn(async move |this, cx| {
                let users = core.call(Some(&id), "getUsers", vec![]).await;
                let me = core.call(Some(&id), "getSelf", vec![]).await;
                this.update(cx, |state, cx| {
                    if let Some(server) = state.servers.get_mut(&id) {
                        if let Ok(users) = users {
                            server.set_users(from_value(users));
                        }
                        if let Ok(me) = me {
                            server.me = Some(from_value(me));
                        }
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        });
    }

    pub(super) fn refresh_field(&mut self, server_id: &str, method: &'static str, cx: &mut Context<Self>, apply: fn(&mut ServerState, Value)) {
        let id = server_id.to_string();
        self.call(Some(server_id), method, vec![], cx, move |state, result, cx| {
            if let (Ok(value), Some(server)) = (result, state.servers.get_mut(&id)) {
                apply(server, value);
                cx.notify();
            }
        });
    }

    pub(super) fn upsert_message(&mut self, message: MessageView) {
        let Some(list) = self.lists.get_mut(&message.group_id) else { return };
        if let Some(index) = list.items.iter().position(|item| item.id == message.id) {
            list.items[index] = message;
        } else if !(list.detached && list.has_newer) {
            // A window around an old message takes new ones once it has read on to the newest.
            list.items.push(message);
            sort_messages(&mut list.items);
        }
    }

    pub fn handle_event(&mut self, event: Value, cx: &mut Context<Self>) {
        // Plugins hear what their permissions cover, and someone typing and a notification pass
        // their filters first, when any has one.
        if let Some(plugins) = crate::plugins::get(cx) {
            plugins.update(cx, |plugins, _| plugins.core_event(&event));
            let filter = match event.get("type").and_then(Value::as_str) {
                Some("typing") => Some(crate::plugins::FilterKind::TypingShown),
                Some("notify") => Some(crate::plugins::FilterKind::Notify),
                _ => None,
            };
            if let Some(task) = filter.and_then(|kind| crate::plugins::filter(kind, event.clone(), cx)) {
                cx.spawn(async move |this, cx| {
                    if let crate::plugins::Verdict::Go(event) = task.await {
                        this.update(cx, |state, cx| state.apply_event(event, cx)).ok();
                    }
                })
                .detach();
                return;
            }
        }
        self.apply_event(event, cx);
    }

    fn apply_event(&mut self, event: Value, cx: &mut Context<Self>) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
        let server_id = event.get("serverId").and_then(Value::as_str).unwrap_or_default().to_string();
        let text = |name: &str| event.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        match kind.as_str() {
            "connection" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.connection = text("state");
                }
            }
            "conversations" => self.refresh_conversations(&server_id, cx),
            "read" => self.read_moved(&server_id, &event, cx),
            "channels" => self.refresh_conversations(&server_id, cx),
            "users" => {
                self.refresh_users(&server_id, cx);
                self.refresh_conversations(&server_id, cx);
            }
            "message" => {
                let message: MessageView = from_value(event.get("message").cloned().unwrap_or_default());
                // Deleted for everyone: what it said goes from everywhere.
                if message.deleted_at.is_some() {
                    self.clear_notifications(Some(&server_id), None, Some(&message.id), cx);
                }
                let is_new = event.get("isNew").and_then(Value::as_bool).unwrap_or(false);
                if is_new {
                    if let Some(server) = self.servers.get_mut(&server_id) {
                        if let Some(typing) = server.typing.get_mut(&message.group_id) {
                            typing.remove(&message.sender_id);
                        }
                    }
                }
                self.upsert_message(message);
            }
            "message_removed" => {
                let group = text("groupId");
                let id = text("id");
                self.clear_notifications(Some(&server_id), None, Some(&id), cx);
                if let Some(list) = self.lists.get_mut(&group) {
                    list.items.retain(|item| item.id != id);
                }
            }
            "message_moved" => {
                let from = text("fromGroupId");
                let message: MessageView = from_value(event.get("message").cloned().unwrap_or_default());
                let mut has_more = true;
                if let Some(list) = self.lists.get_mut(&from) {
                    list.items.retain(|item| item.id != message.id);
                    has_more = list.has_more;
                }
                let target = self.lists.entry(message.group_id.clone()).or_insert_with(|| MessageList { has_more, ..Default::default() });
                target.items.retain(|item| item.id != message.id);
                target.items.push(message.clone());
                sort_messages(&mut target.items);
                let key = from.trim_start_matches("pending:").to_string();
                if let Some(server) = self.servers.get_mut(&server_id) {
                    for conversation in server.conversations.iter_mut().filter(|item| item.key == key) {
                        conversation.group_id = Some(message.group_id.clone());
                    }
                }
            }
            "presence" => {
                if let Some(user) = self.servers.get_mut(&server_id).and_then(|server| server.users.get_mut(&text("userId"))) {
                    user.online = event.get("online").and_then(Value::as_bool).unwrap_or(false);
                    user.last_seen_at = event.get("lastSeenAt").and_then(Value::as_f64);
                }
            }
            "typing" => {
                let group = text("groupId");
                let user = text("userId");
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.typing.entry(group.clone()).or_default().insert(user.clone(), now_ms() + 5000.0);
                }
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(5100)).await;
                    this.update(cx, |state, cx| {
                        if let Some(typing) = state.servers.get_mut(&server_id).and_then(|server| server.typing.get_mut(&group)) {
                            if typing.get(&user).is_some_and(|until| *until <= now_ms()) {
                                typing.remove(&user);
                                cx.notify();
                            }
                        }
                    })
                    .ok();
                })
                .detach();
            }
            "settings" => {
                let info: ServerInfo = from_value(event.get("info").cloned().unwrap_or_default());
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.name = info.name.clone();
                    server.entry.has_icon = info.has_icon;
                    server.info = Some(info);
                    // The icon may be a new one, which the rail fetches again once it's let go.
                    let icon = format!("{}/api/icon", server.entry.url);
                    self.pictures.remove(&icon);
                }
            }
            "emotes" => self.refresh_field(&server_id, "getEmotes", cx, |server, value| server.emotes = from_value(value)),
            "sounds" => self.refresh_field(&server_id, "getSounds", cx, |server, value| server.sounds = from_value(value)),
            "calls" => {
                let server = server_id.clone();
                self.refresh_field(&server_id, "getCalls", cx, |state_server, value| {
                    state_server.calls = from_value::<Vec<CallView>>(value).into_iter().map(|call| (call.group_id.clone(), call)).collect();
                });
                self.refresh_field(&server, "getVoiceMembers", cx, |state_server, value| {
                    state_server.voice = from_value::<Vec<VoiceMember>>(value).into_iter().map(|member| (member.device_id.clone(), member)).collect();
                });
            }
            "preferences" => self.refresh_field(&server_id, "getPreferences", cx, |server, value| server.prefs = from_value(value)),
            "voice" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    let device = text("deviceId");
                    match event.get("member").filter(|member| !member.is_null()) {
                        Some(member) => {
                            server.voice.insert(device, from_value(member.clone()));
                        }
                        None => {
                            server.voice.remove(&device);
                        }
                    }
                }
            }
            "call" => {
                let group = text("groupId");
                let call: Option<CallView> = event.get("call").filter(|call| !call.is_null()).map(|call| from_value(call.clone()));
                let before = self.servers.get(&server_id).and_then(|server| server.calls.get(&group).cloned());
                if let Some(server) = self.servers.get_mut(&server_id) {
                    match &call {
                        Some(call) => {
                            server.calls.insert(group.clone(), call.clone());
                        }
                        None => {
                            server.calls.remove(&group);
                        }
                    }
                }
                self.notice_call(&server_id, &group, before, call, cx);
            }
            "signed_out" => {
                let reason = text("reason");
                self.notified.remove(&server_id);
                self.clear_notifications(Some(&server_id), None, None, cx);
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.signed_out = Some(reason.clone());
                }
                let message = match reason.as_str() {
                    "banned" => "You were removed from a server by its admins.",
                    "account_deleted" => "Your account on a server was deleted from another device.",
                    _ => "You've been signed out of a server.",
                };
                self.toast(message, ToastKind::Info, cx);
            }
            "signed_in" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.entry.signed_out = None;
                }
            }
            "security" => self.toast(text("message"), ToastKind::Security, cx),
            "new_devices" => {
                if let Some(server) = self.servers.get_mut(&server_id) {
                    server.new_devices = from_value(event.get("devices").cloned().unwrap_or_default());
                }
            }
            "notify" => self.notify(&event, cx),
            _ => {}
        }
        // Voice reads this state, so it hears of its events once this update is over.
        if matches!(kind.as_str(), "voice" | "voice_key" | "voice_ended" | "screen_ended" | "call" | "calls" | "sound" | "watch" | "signed_out") {
            cx.defer(move |cx| crate::voice::on_event(&event, cx));
        }
        cx.notify();
    }

    // --- Messages ---
}
