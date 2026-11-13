//! Making a group, adding people to one, and forwarding messages, with the list of people
//! they pick from.

use super::*;

/// What someone is told before they add a bot to a group (`BOT_READS`).
const BOT_READS: &str = "A bot is a program. It reads everything said here from now on, on whichever machine runs it, and gets nothing from before.";

impl Dialog {
    /// The bots among the people picked.
    fn picked_bots(&self, cx: &App) -> Vec<crate::models::UserView> {
        let Some(server) = self.state.read(cx).active() else { return Vec::new() };
        let mut bots: Vec<_> = self.selected.iter().filter_map(|id| server.users.get(id)).filter(|user| user.bot.is_some()).cloned().collect();
        bots.sort_by_cached_key(|bot| bot.display_name.to_lowercase());
        bots
    }

    /// What adding a bot means, asked before it's added, each time one is (`AddBotConfirm`).
    pub(super) fn bot_question(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.asking {
            return None;
        }
        let bots = self.picked_bots(cx);
        let names = bots.iter().map(|bot| bot.display_name.clone()).collect::<Vec<_>>().join(", ");
        let one = bots.len() == 1;
        let (cancel, add) = (cx.entity().downgrade(), cx.entity().downgrade());
        Some(confirm(
            if one { format!("Add the bot {names}?") } else { format!("Add the bots {names}?") },
            if one { "Add the bot" } else { "Add the bots" },
            BOT_READS.into(),
            move |_, cx| {
                cancel
                    .update(cx, |dialog, cx| {
                        dialog.asking = false;
                        cx.notify();
                    })
                    .ok();
            },
            move |_, cx| {
                add.update(cx, |dialog, cx| {
                    dialog.asking = false;
                    match dialog.kind {
                        DialogKind::NewGroup => dialog.create_group(cx),
                        DialogKind::AddMembers(ref group_id) => {
                            let group_id = group_id.clone();
                            dialog.add_picked(group_id, cx);
                        }
                        _ => {}
                    }
                    cx.notify();
                })
                .ok();
            },
            cx,
        ))
    }

    /// Makes the group, or asks first when a bot is among the people picked.
    fn create_group_or_ask(&mut self, cx: &mut Context<Self>) {
        if self.picked_bots(cx).is_empty() {
            self.create_group(cx);
        } else {
            self.asking = true;
        }
        cx.notify();
    }

    fn create_group(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        let members: Vec<String> = self.selected.iter().cloned().collect();
        let name = self.name.read(cx).text().trim().to_string();
        let history = self.history;
        self.state.update(cx, |state, cx| {
            let server = state.active_server.clone();
            state.call(server.as_deref(), "createGroup", vec![json!(name), json!(members), json!(history)], cx, |state, result, cx| match result {
                Ok(value) => {
                    let group = value.as_str().unwrap_or_default().to_string();
                    state.overlay = None;
                    state.select_conversation(Some(format!("group:{group}")), cx);
                    if let Some(server) = state.active_server.clone() {
                        state.refresh_conversations(&server, cx);
                    }
                }
                Err(error) => state.toast(error.message, ToastKind::Error, cx),
            });
        });
    }

    fn add_picked(&mut self, group_id: String, cx: &mut Context<Self>) {
        self.busy = true;
        let ids: Vec<String> = self.selected.iter().cloned().collect();
        self.state.update(cx, |state, cx| {
            let server = state.active_server.clone();
            state.call(server.as_deref(), "addMembers", vec![json!(group_id), json!(ids)], cx, |state, result, cx| match result {
                Ok(_) => state.set_overlay(None, cx),
                Err(error) => state.toast(error.message, ToastKind::Error, cx),
            });
        });
    }

    pub(super) fn new_group(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        // Of the bots, only the ones this person may add.
        // On Telegram, people only: a chat speaking as itself in a group is no one to add.
        let mut users: Vec<_> = server.users.values().filter(|user| user.id != server.self_id() && !user.banned && !user.deleted && server.may_add(user) && !user.id.starts_with("chat:")).cloned().collect();
        users.sort_by_cached_key(|user| user.display_name.to_lowercase());
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let people_scroll = scroll_handle("new-group-people");
        let mut people = div().id("people-list").max_h(px(260.)).overflow_y_scroll().track_scroll(&people_scroll).pr(gutter(&people_scroll)).flex().flex_col().gap(px(1.)).mx(px(-4.));
        if filtered.is_empty() {
            people = people.child(div().p(px(16.)).text_center().text_color(theme.text2).child("Nobody matches that search."));
        }
        for user in filtered {
            let selected = self.selected.contains(&user.id);
            let id = user.id.clone();
            let image = user.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            let row_bg = if selected { theme.bg3 } else { theme.bg1 };
            people = people.child(
                named_div(SharedString::from(format!("person-{}", user.id)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_M)
                    .text_size(px(13.5))
                    .bg(row_bg)
                    .cursor_pointer()
                    .hover(move |style| if selected { style } else { style.bg(theme.hover) })
                    .on_click(cx.listener(move |dialog, _, _, cx| {
                        if !dialog.selected.remove(&id) {
                            dialog.selected.insert(id.clone());
                        }
                        cx.notify();
                    }))
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 36., online: user.online, rounded: false, dot_border: row_bg }, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().flex().items_center().gap(px(6.)).child(div().min_w_0().one_line().font_weight(FontWeight::SEMIBOLD).child(user.display_name.clone())).when(user.bot.is_some(), |el| el.child(bot_badge(cx))))
                            .when(!user.username.is_empty(), |el| el.child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username)))),
                    )
                    .child(
                        div()
                            .size(px(18.))
                            .rounded(px(4.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_color(if selected { theme.accent } else { theme.line_strong })
                            .when(selected, |el| el.bg(theme.accent).child(icon("check", 13., theme.on_accent))),
                    ),
            );
        }
        let name = self.name.read(cx).text().trim().to_string();
        let count = self.selected.len();
        let history = self.history;
        let busy = self.busy;
        let body = vec![
            field(Some("Group name"), self.name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Invite people"))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .bg(theme.bg3)
                        .rounded(RADIUS_M)
                        .border_1()
                        .border_color(if self.focused == Some(1) { theme.line_strong } else { gpui::transparent_black() })
                        .px(px(11.))
                        .h(px(34.))
                        .text_size(px(13.5))
                        .child(icon("search", 14., theme.text3))
                        .child(div().flex_1().min_w_0().child(self.people_search.clone())),
                )
                .child(people.child(scrollbar("new-group-people", Scrolls::Div(people_scroll.clone()))))
                .into_any_element(),
            div()
                .flex()
                .items_center()
                .gap(px(16.))
                .py(px(10.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().font_weight(FontWeight::MEDIUM).child("New members can read earlier messages"))
                        .child(div().text_size(px(12.5)).text_color(theme.text2).child("If off, people only see what's sent after they join.")),
                )
                .child(switch("history", history, cx).on_click(cx.listener(|dialog, _, _, cx| {
                    dialog.history = !dialog.history;
                    cx.notify();
                })))
                .into_any_element(),
        ];
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(
                button("create", ButtonKind::Primary, ButtonSize::Normal, name.is_empty() || busy, cx)
                    .child(if count > 0 { format!("Create with {} people", count + 1) } else { "Create".to_string() })
                    .when(!name.is_empty() && !busy, |el| el.on_click(cx.listener(|dialog, _, _, cx| dialog.create_group_or_ask(cx)))),
            )
            .into_any_element();
        self.modal(Some("New group".into()), 440., body, Some(footer), cx)
    }

    /// Where to forward messages: any chat on any server, this one first. Picking one sends
    /// them there and opens it, as Telegram's desktop app does.
    pub(super) fn forward(&mut self, from_server: String, group_id: String, ids: Vec<String>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let state = self.state.read(cx);
        // Nothing goes between Zuna's chats and the Telegram account's: from Telegram, only its own
        // chats are offered, and from a server, never Telegram's.
        let from_telegram = from_server == crate::telegram::SERVER_ID;
        let order: Vec<String> = std::iter::once(from_server.clone())
            .chain(state.order.iter().filter(|id| **id != from_server && !from_telegram && id.as_str() != crate::telegram::SERVER_ID).cloned())
            .collect();
        let mut sections = Vec::new();
        for server_id in order {
            let Some(server) = state.servers.get(&server_id) else { continue };
            let chats: Vec<crate::models::ConversationView> = server
                .conversations
                .iter()
                .cloned()
                .chain(server.channels.iter().filter_map(|channel| channel.conversation.clone()))
                .filter(|chat| !server.prefs.hidden.contains(&chat.key) && (query.is_empty() || chat.title.to_lowercase().contains(&query)))
                .collect();
            if !chats.is_empty() {
                sections.push((server_id.clone(), server.entry.name.clone(), chats));
            }
        }
        let show_names = sections.len() > 1 || sections.first().is_some_and(|(id, _, _)| *id != from_server);
        let forward_scroll = scroll_handle("forward-list");
        let mut list = div().id("forward-list").max_h(px(380.)).mt(px(10.)).overflow_y_scroll().track_scroll(&forward_scroll).pr(gutter(&forward_scroll)).flex().flex_col().mx(px(-4.));
        if sections.is_empty() {
            list = list.child(div().p(px(16.)).text_center().text_color(theme.text2).child("No chats match that search."));
        }
        let busy = self.busy;
        for (index, (server_id, server_name, chats)) in sections.into_iter().enumerate() {
            let mut section = div().flex().flex_col().gap(px(1.)).when(index > 0, |el| el.mt(px(8.)));
            if show_names {
                section = section.child(div().px(px(8.)).py(px(4.)).text_size(px(11.5)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text3).child(server_name.to_uppercase()));
            }
            for chat in chats {
                let image = chat.avatar.as_ref().and_then(|avatar| {
                    let server_id = server_id.clone();
                    self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
                });
                let seed = chat.peer_id.clone().or(chat.group_id.clone()).unwrap_or(chat.key.clone());
                let (to_server, key) = (server_id.clone(), chat.key.clone());
                let (from_server, group_id, ids) = (from_server.clone(), group_id.clone(), ids.clone());
                section = section.child(
                    named_div(SharedString::from(format!("forward-{server_id}-{}", chat.key)))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(8.))
                        .py(px(5.))
                        .rounded(RADIUS_M)
                        .text_size(px(13.5))
                        .when(!busy, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover)))
                        .on_click(cx.listener(move |dialog, _, _, cx| {
                            if dialog.busy {
                                return;
                            }
                            dialog.busy = true;
                            cx.notify();
                            let args = vec![json!(from_server), json!(group_id), json!(ids), json!(to_server), json!(key)];
                            let call = dialog.state.read(cx).core.call(None, "forwardMessages", args);
                            let (to_server, key) = (to_server.clone(), key.clone());
                            cx.spawn(async move |dialog, cx| {
                                let result = call.await;
                                dialog
                                    .update(cx, |dialog, cx| match result {
                                        Ok(_) => dialog.state.update(cx, |state, cx| {
                                            state.selection = None;
                                            if state.active_server.as_deref() != Some(to_server.as_str()) {
                                                state.select_server(&to_server, cx);
                                            }
                                            state.select_conversation(Some(key.clone()), cx);
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
                        }))
                        .child(avatar(AvatarProps { name: chat.title.clone(), seed, image, size: 36., online: false, rounded: false, dot_border: theme.bg1 }, cx))
                        .child(div().flex_1().min_w_0().one_line().font_weight(FontWeight::SEMIBOLD).child(chat.title.clone())),
                );
            }
            list = list.child(section);
        }
        let search = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .bg(theme.bg3)
            .rounded(RADIUS_M)
            .border_1()
            .border_color(if self.focused == Some(1) { theme.line_strong } else { gpui::transparent_black() })
            .px(px(11.))
            .h(px(34.))
            .text_size(px(13.5))
            .child(icon("search", 14., theme.text3))
            .child(div().flex_1().min_w_0().child(self.people_search.clone()));
        self.modal(Some("Forward to".into()), 440., vec![div().flex().flex_col().child(search).child(list.child(scrollbar("forward-list", Scrolls::Div(forward_scroll.clone())))).into_any_element()], None, cx)
    }

    /// People to pick from, with a search above them, as `PeoplePicker` lists them.
    pub(super) fn people_picker(&mut self, server: &crate::state::ServerState, users: Vec<crate::models::UserView>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let people_scroll = scroll_handle("add-people");
        let mut people = div().id("add-people").max_h(px(260.)).overflow_y_scroll().track_scroll(&people_scroll).pr(gutter(&people_scroll)).flex().flex_col().gap(px(1.)).mx(px(-4.));
        if filtered.is_empty() {
            people = people.child(div().p(px(16.)).text_center().text_color(theme.text2).child("Nobody matches that search."));
        }
        for user in filtered {
            let selected = self.selected.contains(&user.id);
            let id = user.id.clone();
            let image = user.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            let row_bg = if selected { theme.bg3 } else { theme.bg1 };
            people = people.child(
                named_div(SharedString::from(format!("person-{}", user.id)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_M)
                    .text_size(px(13.5))
                    .bg(row_bg)
                    .cursor_pointer()
                    .hover(move |style| if selected { style } else { style.bg(theme.hover) })
                    .on_click(cx.listener(move |dialog, _, _, cx| {
                        if !dialog.selected.remove(&id) {
                            dialog.selected.insert(id.clone());
                        }
                        cx.notify();
                    }))
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 36., online: user.online, rounded: false, dot_border: row_bg }, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().flex().items_center().gap(px(6.)).child(div().min_w_0().one_line().font_weight(FontWeight::SEMIBOLD).child(user.display_name.clone())).when(user.bot.is_some(), |el| el.child(bot_badge(cx))))
                            .when(!user.username.is_empty(), |el| el.child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username)))),
                    )
                    .child(
                        div()
                            .size(px(18.))
                            .rounded(px(4.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .border_1()
                            .border_color(if selected { theme.accent } else { theme.line_strong })
                            .when(selected, |el| el.bg(theme.accent).child(icon("check", 13., theme.on_accent))),
                    ),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .bg(theme.bg3)
                    .rounded(RADIUS_M)
                    .border_1()
                    .border_color(if self.focused == Some(1) { theme.line_strong } else { gpui::transparent_black() })
                    .px(px(11.))
                    .h(px(34.))
                    .text_size(px(13.5))
                    .child(icon("search", 14., theme.text3))
                    .child(div().flex_1().min_w_0().child(self.people_search.clone())),
            )
            .child(people.child(scrollbar("add-people", Scrolls::Div(people_scroll.clone()))))
            .into_any_element()
    }

    /// People to add to a group: everyone on the server who isn't in it yet.
    pub(super) fn add_members(&mut self, group_id: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let conversation = server.conversations.iter().find(|item| item.group_id.as_deref() == Some(group_id.as_str())).cloned();
        let members: std::collections::HashSet<String> = conversation.as_ref().map(|c| c.members.iter().map(|member| member.user_id.clone()).collect()).unwrap_or_default();
        // Of the bots, only the ones this person may add.
        let mut users: Vec<_> = server.users.values().filter(|user| !members.contains(&user.id) && !user.banned && !user.deleted && server.may_add(user)).cloned().collect();
        users.sort_by_cached_key(|user| user.display_name.to_lowercase());
        let mut body = Vec::new();
        if conversation.as_ref().is_some_and(|c| c.history_visible) {
            body.push(notice("users-round", "This group shares its history, so they'll be able to read earlier messages.", cx).into_any_element());
        }
        if users.is_empty() {
            body.push(div().p(px(16.)).text_center().text_color(theme.text2).child("Everyone on this server is already here.").into_any_element());
        } else {
            body.push(self.people_picker(&server, users, cx));
        }
        let count = self.selected.len();
        let busy = self.busy;
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("add", ButtonKind::Primary, ButtonSize::Normal, count == 0 || busy, cx).child(if busy { "Adding…" } else { "Add" }).when(count > 0 && !busy, |el| {
                el.on_click(cx.listener(move |dialog, _, _, cx| {
                    // A bot among them is asked about first, each time.
                    if dialog.picked_bots(cx).is_empty() {
                        dialog.add_picked(group_id.clone(), cx);
                    } else {
                        dialog.asking = true;
                    }
                    cx.notify();
                }))
            }));
        self.modal(Some("Add people".into()), 440., body, Some(footer.into_any_element()), cx)
    }
}
