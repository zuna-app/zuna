//! Notifications, and whether the person is here to see them.

use super::*;

#[cfg(test)]
mod tests;

impl AppState {
    /// Chats an earlier run notified about, which the system still shows, to be taken back as
    /// this run's are once they're read.
    #[cfg(target_os = "macos")]
    pub fn notified_earlier(&mut self, chats: Vec<(String, String)>, cx: &mut Context<Self>) {
        let mut servers = HashSet::new();
        for (server_id, key) in chats {
            self.notified.entry(server_id.clone()).or_default().entry(key).or_insert(0.);
            servers.insert(server_id);
        }
        servers.retain(|id| self.servers.contains_key(id));
        for server_id in servers {
            self.refresh_conversations(&server_id, cx);
        }
    }

    /// A chat with nothing unread has nothing to notify about any more, however it came to be read.
    pub(super) fn clear_read(&mut self, server_id: &str, asked: f64, cx: &mut Context<Self>) {
        let Some(server) = self.servers.get(server_id) else { return };
        let Some(in_server) = self.notified.get_mut(server_id) else { return };
        if in_server.is_empty() {
            return;
        }
        let conversations = server.conversations.iter().chain(server.channels.iter().filter_map(|channel| channel.conversation.as_ref()));
        // What was just notified about may be newer than this list of what's unread.
        let keys: Vec<String> = conversations
            .filter(|item| item.unread == 0. && in_server.get(&item.key).copied().unwrap_or(asked) < asked)
            .map(|item| item.key.clone())
            .collect();
        if keys.is_empty() {
            return;
        }
        for key in &keys {
            in_server.remove(key);
        }
        self.clear_notifications(Some(server_id), Some(&keys), None, cx);
    }

    /// A message the core says to notify about, unless its chat is open in front of the person (notify in store.ts).
    pub(super) fn notify(&mut self, event: &Value, cx: &mut Context<Self>) {
        let text = |name: &str| event.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        let server_id = text("serverId");
        let key = text("conversationKey");
        let open_here = self.window_in_front()
            && self.active_server.as_deref() == Some(server_id.as_str())
            && self.active().is_some_and(|server| server.active_key.as_deref() == Some(key.as_str()));
        if open_here || !self.settings.notifications {
            return;
        }
        self.notified.entry(server_id.clone()).or_default().insert(key.clone(), now_ms());
        let system = crate::platform::notification_state();
        if self.settings.notification_sound && system.sound {
            crate::platform::play_notification_sound();
        }
        ask_to_look(cx);
        if !system.show {
            return;
        }
        let preview = self.settings.notification_preview.clone();
        let conversation = self.servers.get(&server_id).and_then(|server| server.find_conversation(&key)).cloned();
        let title = if preview == "none" { "Zuna".to_string() } else { text("title") };
        let body = if preview == "full" { text("body") } else { "New message".to_string() };
        // The same picture as beside the chat in the list.
        let picture = if preview == "none" {
            None
        } else {
            let image = conversation.as_ref().and_then(|conversation| conversation.avatar.as_ref()).and_then(|avatar| match self.pictures.get(&format!("file:{}", avatar.cache_id())) {
                Some(Picture::Ready(image)) => Some(image.clone()),
                _ => None,
            });
            let title = conversation.as_ref().map(|c| c.title.clone()).unwrap_or_else(|| text("title"));
            let seed = conversation.as_ref().and_then(|c| c.peer_id.clone().or(c.group_id.clone())).unwrap_or_else(|| key.clone());
            Some(crate::ui::notifications::Picture { image, initials: crate::format::initials_of(&title), seed })
        };
        let payload = crate::ui::notifications::Payload {
            title,
            body,
            server_id: server_id.clone(),
            key,
            message_id: text("messageId"),
            kind: conversation.as_ref().map(|c| c.kind.clone()).unwrap_or_else(|| "dm".into()),
            picture,
            // Writing back needs to show what's being answered, and somewhere to write it.
            can_reply: preview == "full" && !conversation.as_ref().is_some_and(|c| c.removed),
            wait_for_input: system.wait_for_input,
        };
        let avatar = conversation.as_ref().and_then(|c| c.avatar.clone());
        self.show_notification(payload, &server_id, avatar.as_ref(), cx);
    }

    /// A call starting to ring this person, or one they missed: a card while the app isn't in front,
    /// and for a missed one a toast while it is (noticeCall in store.ts).
    pub(super) fn notice_call(&mut self, server_id: &str, group_id: &str, before: Option<CallView>, call: Option<CallView>, cx: &mut Context<Self>) {
        let Some(self_id) = self.servers.get(server_id).map(|server| server.self_id().to_string()) else { return };
        if self_id.is_empty() {
            return;
        }
        let was_ringing = before.as_ref().is_some_and(|call| call.ringing.contains(&self_id));
        let ringing = call.as_ref().is_some_and(|call| call.ringing.contains(&self_id));
        if was_ringing == ringing {
            return;
        }
        let message_id = format!("call:{group_id}");
        if was_ringing {
            self.clear_notifications(Some(server_id), None, Some(&message_id), cx);
        }
        let Some(server) = self.servers.get(server_id) else { return };
        let Some(conversation) = crate::voice::conversation_of_group(server, group_id).cloned() else { return };
        let caller = call.as_ref().or(before.as_ref()).map(|call| call.started_by.clone()).unwrap_or_default();
        if conversation.muted || conversation.blocked || server.prefs.blocked().contains(&caller) {
            return;
        }
        // Answered on another device, or declined, isn't missed.
        let answered = server.voice.values().any(|member| member.channel_id == group_id && member.user_id == self_id);
        let missed = was_ringing && !answered && !call.as_ref().is_some_and(|call| call.declined.contains(&self_id));
        if !ringing && !missed {
            return;
        }
        let name = server.users.get(&caller).map(|user| user.display_name.clone()).unwrap_or_else(|| "Someone".into());
        let dm = conversation.kind == "dm";
        let body = match (ringing, dm) {
            (true, true) => "Calling you".to_string(),
            (true, false) => format!("{name} started a call"),
            (false, true) => "Missed call".to_string(),
            (false, false) => format!("Missed call from {name}"),
        };
        if self.window_in_front() {
            if missed {
                let message = if dm { format!("Missed call from {name}.") } else { format!("Missed call from {name} in {}.", conversation.title) };
                self.toast(message, ToastKind::Info, cx);
            }
            return;
        }
        if !self.settings.notifications {
            return;
        }
        ask_to_look(cx);
        let system = crate::platform::notification_state();
        if !system.show {
            return;
        }
        // A call's ringing has its own sound, so the notification makes none.
        let preview = self.settings.notification_preview.clone();
        let picture = (preview != "none").then(|| {
            let image = conversation.avatar.as_ref().and_then(|avatar| match self.pictures.get(&format!("file:{}", avatar.cache_id())) {
                Some(Picture::Ready(image)) => Some(image.clone()),
                _ => None,
            });
            crate::ui::notifications::Picture { image, initials: crate::format::initials_of(&conversation.title), seed: conversation.peer_id.clone().or(conversation.group_id.clone()).unwrap_or_default() }
        });
        let payload = crate::ui::notifications::Payload {
            title: if preview == "none" { "Zuna".to_string() } else { conversation.title.clone() },
            body: if preview == "none" { (if ringing { "Incoming call" } else { "Missed call" }).to_string() } else { body },
            server_id: server_id.to_string(),
            key: conversation.key.clone(),
            message_id,
            kind: conversation.kind.clone(),
            picture,
            can_reply: false,
            wait_for_input: system.wait_for_input,
        };
        self.show_notification(payload, server_id, conversation.avatar.as_ref(), cx);
    }

    /// Shows a notification with its chat's photo, which, when it isn't decrypted yet, as for a chat
    /// on a server not in front, is waited for up to 400 ms before showing its initials. One at a
    /// time, so a photo that takes a moment can't reorder them (showNotification in store.ts).
    pub(super) fn show_notification(&mut self, payload: crate::ui::notifications::Payload, server_id: &str, avatar: Option<&AvatarRef>, cx: &mut Context<Self>) {
        let id = self.next_notification;
        self.next_notification += 1;
        let mut photo = None;
        let without_photo = payload.picture.as_ref().is_some_and(|picture| picture.image.is_none());
        if let Some(avatar) = avatar.filter(|_| without_photo) {
            let key = format!("file:{}", avatar.cache_id());
            if !matches!(self.pictures.get(&key), Some(Picture::Failed(_))) {
                self.decrypted_picture(server_id, avatar, cx);
                photo = Some(key);
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(400)).await;
                    this.update(cx, |state, cx| {
                        if let Some(waiting) = state.waiting_notifications.iter_mut().find(|waiting| waiting.id == id) {
                            waiting.photo = None;
                        }
                        state.show_waiting(cx);
                    })
                    .ok();
                })
                .detach();
            }
        }
        self.waiting_notifications.push_back(WaitingNotification { id, payload, photo });
        self.show_waiting(cx);
    }

    /// Shows the notifications in order, up to one still waiting for its photo.
    pub(super) fn show_waiting(&mut self, cx: &mut Context<Self>) {
        let reduce_motion = self.settings.reduce_motion;
        while let Some(waiting) = self.waiting_notifications.front() {
            let image = match waiting.photo.as_ref().map(|key| self.pictures.get(key)) {
                Some(Some(Picture::Ready(image))) => Some(image.clone()),
                Some(Some(Picture::Loading) | None) => return,
                _ => None,
            };
            let Some(WaitingNotification { mut payload, .. }) = self.waiting_notifications.pop_front() else { return };
            if let (Some(picture), Some(image)) = (payload.picture.as_mut(), image) {
                picture.image = Some(image);
            }
            #[cfg(test)]
            tests::SHOWN.with(|shown| shown.borrow_mut().push(payload.clone()));
            if let Some(center) = crate::ui::notifications::center(cx) {
                center.update(cx, |center, cx| center.show(payload, reduce_motion, cx));
            }
        }
    }

    /// Takes back notifications matching everything given, shown or waiting for a photo.
    pub(super) fn clear_notifications(&mut self, server_id: Option<&str>, keys: Option<&[String]>, message_id: Option<&str>, cx: &mut Context<Self>) {
        self.waiting_notifications.retain(|waiting| {
            let payload = &waiting.payload;
            !(server_id.is_none_or(|id| payload.server_id == id) && keys.is_none_or(|keys| keys.contains(&payload.key)) && message_id.is_none_or(|id| payload.message_id == id))
        });
        self.show_waiting(cx);
        if let Some(center) = crate::ui::notifications::center(cx) {
            center.update(cx, |center, cx| center.clear(server_id, keys, message_id, cx));
        }
    }

    /// A reply typed into a notification: it reads the chat, and answers the message in a group (sendNotificationReply).
    pub fn send_notification_reply(&mut self, server_id: &str, key: &str, message_id: &str, text: &str, cx: &mut Context<Self>) {
        let Some(server) = self.servers.get(server_id) else { return };
        let Some(conversation) = server.find_conversation(key).cloned() else { return };
        let value = text.trim().to_string();
        if value.is_empty() {
            return;
        }
        if let (Some(group), Some(newest)) = (&conversation.group_id, conversation.last_message.as_ref().and_then(|m| m.seq)) {
            let payload = json!({ "serverId": server_id, "groupId": group, "conversationKey": key });
            self.act_filtered(server_id, crate::plugins::FilterKind::Read, payload, "markRead", vec![json!(group), json!(newest)], cx);
        }
        let reply_to = (conversation.kind != "dm").then(|| message_id.to_string());
        let server = server_id.to_string();
        let draft = json!({ "serverId": server_id, "groupId": conversation.group_id, "conversationKey": key, "kind": "send", "text": value });
        let key = key.to_string();
        let send = move |state: &mut Self, value: String, cx: &mut Context<Self>| {
            let Some(known) = state.servers.get(&server) else { return };
            let mentions = crate::markup::mentions_in(&value, &known.mentionable);
            let emotes = known.emotes.refs_in(&value);
            let mut body = json!({ "text": value, "emotes": emotes, "mentions": mentions });
            if let Some(reply_to) = &reply_to {
                body["replyTo"] = json!(reply_to);
            }
            state.call(Some(&server), "sendMessage", vec![json!(key), body], cx, |state, result, cx| {
                if let Err(error) = result {
                    state.toast(error.message, ToastKind::Error, cx);
                }
            });
        };
        // What goes out passes plugins' filters, as what's sent from the message box does.
        match crate::plugins::filter(crate::plugins::FilterKind::Outgoing, draft, cx) {
            None => send(self, value, cx),
            Some(task) => cx
                .spawn(async move |this, cx| {
                    let verdict = task.await;
                    this.update(cx, |state, cx| match verdict {
                        crate::plugins::Verdict::Go(draft) => send(state, draft.get("text").and_then(Value::as_str).unwrap_or_default().to_string(), cx),
                        crate::plugins::Verdict::Stopped(name) => state.toast(format!("{name} kept your reply from going."), ToastKind::Info, cx),
                        crate::plugins::Verdict::Held(name) => state.toast(format!("{name} didn't answer, so your reply wasn't sent."), ToastKind::Error, cx),
                    })
                    .ok();
                })
                .detach(),
        }
    }

    /// Whether the window is in front: focused, and on screen, as GPUI can still think a minimized
    /// window focused. On Windows, Windows' own foreground window says so, as GPUI's can name the
    /// window while another app is in front (`main_in_front`). Only then does a chat open in it hold
    /// its notifications back.
    pub fn window_in_front(&self) -> bool {
        #[cfg(windows)]
        return crate::platform::main_in_front();
        #[cfg(not(windows))]
        return self.window_focused && crate::platform::main_visible();
    }

    /// Whether the person is here, as Telegram's desktop app counts it: the window in front and
    /// input in the last 30 s (`AWAY_AFTER_MS`), the window coming in front counting as input. Only
    /// then does a chat open in it count as seen, so one left in front with nobody at it doesn't go
    /// on taking back the notifications their phone is waiting to show.
    pub fn person_here(&self) -> bool {
        self.window_in_front() && self.quiet_ms() < crate::platform::AWAY_AFTER_MS as u64
    }

    /// How long since the person last touched the computer, or brought the window in front. Where
    /// the system can't say, as under a Wayland compositor without its idle protocol, only input to
    /// the app counts (`last_input`): never the window being in front alone.
    fn quiet_ms(&self) -> u64 {
        let since = |at: Option<std::time::Instant>| at.map_or(u64::MAX, |at| at.elapsed().as_millis() as u64);
        let system = if crate::platform::idle_known() { crate::platform::idle_ms() as u64 } else { u64::MAX };
        system.min(since(self.last_input)).min(since(self.in_front_since))
    }

    /// Tells the core whether the person is here (`person_here`), and which server they're looking
    /// at, if either changed. While they're here they show as online on that server alone, as
    /// Telegram is only in the account shown (`Application::hasActiveWindow`), and as soon as they
    /// aren't, offline, as Telegram's desktop app tells its server (`Updates::updateOnline`); their
    /// other devices hold notifications back meanwhile (activity.ts). Once they're back, the open
    /// chat reads what came while they were away.
    pub fn report_activity(&mut self, cx: &mut Context<Self>) {
        // Nothing to tell before the core is up, which `watch_activity` waits for.
        if self._activity.is_none() {
            return;
        }
        let now = (self.person_here(), self.active_server.clone());
        if self.reported_active.as_ref() != Some(&now) {
            self.call(None, "setActive", vec![json!(now.0), json!(now.1)], cx, |_, _, _| {});
            self.reported_active = Some(now);
            cx.notify();
        }
    }

    /// Keeps the core told (`report_activity`), looking again when that can next change without the
    /// window being brought in front or left, which tells it at once (`ui/mod.rs`): as 30 s without
    /// input run out, or, with the window in front and nobody at it, every 900 ms for them coming
    /// back, as Telegram's does (`Updates::checkIdleFinish`). Otherwise every 5 s, in case.
    pub(super) fn watch_activity(&mut self, cx: &mut Context<Self>) {
        if self._activity.is_some() {
            return;
        }
        self._activity = Some(cx.spawn(async move |this, cx| {
            loop {
                let wait = this.update(cx, |state, cx| {
                    state.report_activity(cx);
                    let away = crate::platform::AWAY_AFTER_MS as u64;
                    if state.person_here() {
                        Duration::from_millis((away - state.quiet_ms().min(away) + 20).min(5_000))
                    } else if state.window_in_front() {
                        Duration::from_millis(900)
                    } else {
                        Duration::from_secs(5)
                    }
                });
                let Ok(wait) = wait else { break };
                cx.background_executor().timer(wait).await;
            }
        }));
    }

    // --- Pictures ---
}

/// Asks the person to look at the main window, as for a new message, unless one of the app's
/// windows is already in front of them, as the picture viewer can be, over the whole screen.
/// KWin lets an app in front bring up another of its windows, so asking for the main one
/// then would put it over the viewer.
fn ask_to_look(cx: &App) {
    if cx.active_window().is_none() {
        crate::platform::later(cx, crate::platform::flash_main);
    }
}
