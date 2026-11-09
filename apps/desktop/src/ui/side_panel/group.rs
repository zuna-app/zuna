//! A group's or a channel's details: its picture and name, its members, and what can be done
//! to each.

use super::*;

impl SidePanel {
    /// A channel's details: what it's for, and what's been shared there. Who's in it is everyone.
    pub(super) fn channel_info(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let mut parts = Vec::new();
        let mut section = Self::section(cx).child(div().px(px(8.)).py(px(4.)).text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child(format!("#{}", conversation.title)));
        if !conversation.description.is_empty() {
            section = section.child(div().px(px(8.)).pb(px(6.)).text_size(px(12.)).text_color(theme.text3).child(conversation.description.clone()));
        }
        if server.is_admin() {
            let state = self.state.clone();
            let channel_id = conversation.group_id.clone().unwrap_or_default();
            section = section.child(Self::row("edit-channel", "pencil", "Edit channel".into(), None, false, cx).on_click(move |_, _, cx| {
                state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Channel { channel_id: Some(channel_id.clone()), category: None }), cx))
            }));
        }
        let (state, key, muted) = (self.state.clone(), conversation.key.clone(), conversation.muted);
        section = section.child(
            Self::row(
                "channel-mute",
                if muted { "bell-off" } else { "bell" },
                if muted { "Unmute" } else { "Mute" }.into(),
                Some(if muted { "You won't hear about anything here." } else { "You hear about what's said to you." }.into()),
                false,
                cx,
            )
            .on_click(move |event, _, cx| {
                if muted {
                    state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx));
                } else {
                    open_menu(event.position(), mute_entries(key.clone(), state.clone()), true, cx);
                }
            }),
        );
        parts.push(section.into_any_element());
        if let Some(rows) = self.media_rows(server, conversation, cx) {
            parts.push(rows);
        }
        parts.push(
            Self::section(cx)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(11.))
                        .px(px(8.))
                        .py(px(7.))
                        .text_size(px(13.5))
                        .child(icon("lock", 17., theme.text2))
                        .child(div().flex_1().min_w_0().flex().flex_col().child("End-to-end encrypted").child(div().text_size(px(12.)).text_color(theme.text3).child("Everyone on this server can read it, and the server itself can't."))),
                )
                .into_any_element(),
        );
        parts
    }

    /// The group's picture and name, which its admins can change.
    pub(super) fn group_card(&mut self, conversation: &ConversationView, is_admin: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let group = conversation.group_id.clone().unwrap_or_default();
        let image = conversation.avatar.as_ref().and_then(|avatar| {
            let server_id = self.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
        });
        let picture = div()
            .relative()
            .child(avatar(AvatarProps { name: conversation.title.clone(), seed: group.clone(), image, size: 80., online: false, rounded: false, dot_border: theme.bg1 }, cx))
            .when(is_admin, |el| {
                let (state, server_id, group) = (self.state.clone(), self.server_id.clone(), group.clone());
                el.child(
                    div()
                        .id("group-picture")
                        .absolute()
                        .right(px(-4.))
                        .bottom(px(-4.))
                        .size(px(32.))
                        .rounded_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(theme.bg4)
                        .border_2()
                        .border_color(theme.bg1)
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.bg5))
                        
                        .on_click(move |_, _, cx| {
                            let picked = crate::media::pick_avatar(cx);
                            let (state, server_id, group) = (state.clone(), server_id.clone(), group.clone());
                            cx.spawn(async move |cx| {
                                let Some(prepared) = picked.await else { return };
                                state
                                    .update(cx, |state, cx| match prepared {
                                        Ok(file) => state.call(
                                            Some(&server_id),
                                            "updateGroupMeta",
                                            vec![json!(group), json!({}), crate::host::file(&file.to_string_lossy(), "image/jpeg")],
                                            cx,
                                            |state, result, cx| {
                                                if let Err(error) = result {
                                                    state.toast(error.message, crate::state::ToastKind::Error, cx);
                                                }
                                            },
                                        ),
                                        Err(()) => state.toast("That image couldn't be processed.", crate::state::ToastKind::Error, cx),
                                    });
                            })
                            .detach();
                        })
                        .child(icon("camera", 18., theme.text1)),
                )
            });
        let mut card = div().flex().flex_col().items_center().text_center().gap(px(2.)).pt(px(10.)).px(px(4.)).pb(px(6.)).child(picture);
        if self.editing {
            let (save_state, server_id, save_group) = (self.state.clone(), self.server_id.clone(), group.clone());
            let (name_input, description_input) = (self.edit_name.clone(), self.edit_description.clone());
            let title = conversation.title.clone();
            card = card.child(
                div()
                    .w_full()
                    .mt(px(10.))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .text_left()
                    .child(field(Some("Name"), self.edit_name.clone(), None, None, false, None, cx))
                    .child(field(Some("Description"), self.edit_description.clone(), None, None, false, None, cx))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(button("cancel-edit", ButtonKind::Default, ButtonSize::Small, false, cx).flex_1().justify_center().child("Cancel").on_click(cx.listener(|panel, _, _, cx| {
                                panel.editing = false;
                                cx.notify();
                            })))
                            .child(button("save-edit", ButtonKind::Primary, ButtonSize::Small, false, cx).flex_1().justify_center().child("Save").on_click(cx.listener(move |panel, _, _, cx| {
                                let name = name_input.read(cx).text().trim().to_string();
                                let description = description_input.read(cx).text().to_string();
                                let name = if name.is_empty() { title.clone() } else { name };
                                save_state.update(cx, |state, cx| {
                                    state.call(Some(&server_id), "updateGroupMeta", vec![json!(save_group), json!({ "name": name, "description": description })], cx, |state, result, cx| {
                                        if let Err(error) = result {
                                            state.toast(error.message, crate::state::ToastKind::Error, cx);
                                        }
                                    })
                                });
                                panel.editing = false;
                                cx.notify();
                            }))),
                    ),
            );
        } else {
            let (title, description) = (conversation.title.clone(), conversation.description.clone());
            card = card.child(
                div()
                    .mt(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(conversation.title.clone()))
                    .when(is_admin, |el| {
                        el.child(icon_button("edit-group", "pencil", 14., true, false, cx).on_click(cx.listener(move |panel, _, window, cx| {
                            panel.edit_name.update(cx, |input, cx| input.set_text(title.clone(), cx));
                            panel.edit_description.update(cx, |input, cx| input.set_text(description.clone(), cx));
                            panel.editing = true;
                            panel.edit_name.focus_handle(cx).focus(window, cx);
                            cx.notify();
                        })))
                    }),
            );
            if !conversation.description.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(conversation.description.clone()));
            }
        }
        card.into_any_element()
    }

    pub(super) fn group_info(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let self_id = server.self_id().to_string();
        let is_admin = conversation.is_admin(&self_id);
        let group = conversation.group_id.clone().unwrap_or_default();
        let mut parts = vec![self.group_card(conversation, is_admin, cx)];
        parts.push(notice("lock", "The server can see who is in this group, but not its name, picture or messages.", cx).into_any_element());
        if let Some(rows) = self.media_rows(server, conversation, cx) {
            parts.push(rows);
        }
        let count = conversation.members.len();
        let mut members = Self::section(cx).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .px(px(8.))
                .py(px(5.))
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text3)
                .child(format!("{count} {}", if count == 1 { "member" } else { "members" }))
                .when(is_admin, |el| {
                    let (state, group) = (self.state.clone(), group.clone());
                    el.child(icon_button("add-people", "user-plus", 15., true, false, cx).tip("Add people", Side::Bottom).on_click(move |_, _, cx| {
                        state.update(cx, |state, cx| state.set_overlay(Some(Overlay::AddMembers { group_id: group.clone() }), cx))
                    }))
                }),
        );
        let mut sorted = conversation.members.clone();
        sorted.sort_by_cached_key(|member| (member.role != "admin", server.users.get(&member.user_id).map(|user| user.display_name.to_lowercase()).unwrap_or_default()));
        for member in sorted {
            let user = server.users.get(&member.user_id).cloned();
            let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into());
            let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
                let server_id = self.server_id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
            });
            let is_me = member.user_id == self_id;
            let detail = if member.not_on_roster == Some(true) {
                "Has this chat's keys, but isn't listed as a member".to_string()
            } else if member.no_keys == Some(true) {
                "No device in this chat yet".to_string()
            } else {
                format!("@{}", user.as_ref().map(|user| user.username.clone()).unwrap_or_default())
            };
            let menu = self.member_menu(server, conversation, &member.user_id, is_admin);
            members = members.child(
                div()
                    .id(SharedString::from(format!("member-{}", member.user_id)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(8.))
                    .py(px(5.))
                    .rounded(RADIUS_M)
                    .text_size(px(13.5))
                    .when(!is_me, |el| el.cursor_pointer().hover(move |style| style.bg(theme.hover)))
                    .on_click(move |event, _, cx| {
                        if !is_me {
                            open_menu(event.position(), menu.clone(), false, cx);
                        }
                    })
                    .child(avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 36., online: user.as_ref().is_some_and(|user| user.online), rounded: false, dot_border: theme.bg2 }, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .min_w_0()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(div().min_w_0().one_line().child(name))
                                    .when(user.as_ref().is_some_and(|user| user.bot.is_some()), |el| el.child(div().flex_none().ml(px(6.)).child(bot_badge(cx))))
                                    .when(is_me, |el| el.child(div().flex_none().text_color(theme.text3).child("\u{a0}(you)"))),
                            )
                            .child(div().one_line().text_size(px(12.)).text_color(theme.text3).child(detail)),
                    )
                    .when(member.not_on_roster == Some(true), |el| el.child(icon("shield-alert", 14., theme.amber)))
                    .when(member.role == "admin", |el| el.child(icon("crown", 13., theme.text3)))
                    .when(user.as_ref().is_some_and(|user| user.trust == "verified"), |el| el.child(icon("badge-check", 14., theme.text2))),
            );
        }
        parts.push(members.into_any_element());
        parts.push(self.disappearing_row(conversation, is_admin, cx));
        if is_admin {
            let (state, server_id, group) = (self.state.clone(), self.server_id.clone(), group.clone());
            let on = conversation.history_visible;
            parts.push(
                Self::section(cx)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(11.))
                            .px(px(8.))
                            .py(px(7.))
                            .text_size(px(13.5))
                            .child(icon("eye", 17., theme.text2))
                            .child(div().flex_1().min_w_0().flex().flex_col().child("New members can read earlier messages").child(div().text_size(px(12.)).text_color(theme.text3).child("Applies to people added after this is turned on.")))
                            .child(switch("history-visible", on, cx).on_click(move |_, _, cx| {
                                state.update(cx, |state, cx| {
                                    state.call(Some(&server_id), "updateGroupMeta", vec![json!(group), json!({}), serde_json::Value::Null, json!(!on)], cx, |state, result, cx| {
                                        if let Err(error) = result {
                                            state.toast(error.message, crate::state::ToastKind::Error, cx);
                                        }
                                    })
                                })
                            })),
                    )
                    .into_any_element(),
            );
        }
        parts.push(self.preferences(server, conversation, cx));
        let (state, delete_state, delete_group) = (self.state.clone(), self.state.clone(), group.clone());
        parts.push(
            Self::section(cx)
                .child(Self::row("leave-group", "log-out", "Leave group".into(), None, true, cx).on_click(move |_, _, cx| {
                    state.update(cx, |state, cx| {
                        state.act("leaveGroup", vec![json!(group)], cx);
                        state.select_conversation(None, cx);
                    })
                }))
                .when(is_admin, |el| {
                    el.child(Self::row("delete-group", "trash", "Delete group for everyone".into(), None, true, cx).on_click(move |_, _, cx| {
                        delete_state.update(cx, |state, cx| {
                            state.act("deleteGroup", vec![json!(delete_group)], cx);
                            state.select_conversation(None, cx);
                        })
                    }))
                })
                .into_any_element(),
        );
        parts
    }

    /// What can be done to someone in a group, from their row.
    pub(super) fn member_menu(&self, server: &ServerState, conversation: &ConversationView, user_id: &str, is_admin: bool) -> Vec<MenuEntry> {
        let state = self.state.clone();
        let group = conversation.group_id.clone().unwrap_or_default();
        let user_id = user_id.to_string();
        let mut entries = Vec::new();
        let (s, key) = (state.clone(), format!("user:{user_id}"));
        entries.push(MenuEntry::new("Message", "check", move |_, cx| s.update(cx, |state, cx| state.select_conversation(Some(key.clone()), cx))));
        let (s, id) = (state.clone(), user_id.clone());
        entries.push(MenuEntry::new("Verify security key", "shield", move |_, cx| s.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: id.clone() }), cx))));
        if user_id != server.self_id() {
            let blocked = server.prefs.blocked().contains(&user_id);
            let (s, id) = (state.clone(), user_id.clone());
            entries.push(MenuEntry::new(if blocked { "Unblock" } else { "Block" }, "ban", move |_, cx| s.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(!blocked)], cx))));
        }
        if is_admin {
            let admin = conversation.is_admin(&user_id);
            let (s, g, id) = (state.clone(), group.clone(), user_id.clone());
            entries.push(MenuEntry::new(if admin { "Remove admin" } else { "Make admin" }, "crown", move |_, cx| {
                s.update(cx, |state, cx| state.act("setGroupRole", vec![json!(g), json!(id), json!(if admin { "member" } else { "admin" })], cx))
            }));
            entries.push(MenuEntry::separator());
            let (s, g, id) = (state.clone(), group.clone(), user_id.clone());
            entries.push(MenuEntry::new("Remove from group", "user-minus", move |_, cx| s.update(cx, |state, cx| state.act("removeMember", vec![json!(g), json!(id)], cx))).danger());
        }
        entries
    }
}
