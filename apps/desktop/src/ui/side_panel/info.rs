//! A direct message's details: the person, the chat's preferences, its disappearing messages
//! timer, and reporting them.

use super::*;

impl SidePanel {
    pub(super) fn preferences(&self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.clone();
        let key = conversation.key.clone();
        let muted = conversation.muted;
        let mut section = Self::section(cx).child(
            div()
                .flex()
                .items_center()
                .gap(px(11.))
                .px(px(8.))
                .py(px(7.))
                .min_h(px(36.))
                .text_size(px(13.5))
                .child(icon(if muted { "bell-off" } else { "bell" }, 17., theme.text2))
                .child(div().flex_1().min_w_0().child("Notifications"))
                .child(switch("notifications", !muted, cx).on_click(move |event, _, cx| {
                    if muted {
                        state.update(cx, |state, cx| state.act("unmute", vec![json!(key)], cx));
                    } else {
                        open_menu(event.position(), mute_entries(key.clone(), state.clone()), true, cx);
                    }
                })),
        );
        if conversation.kind == "group" {
            let state = self.state.clone();
            let key = conversation.key.clone();
            let on = conversation.mentions_only;
            section = section.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(11.))
                    .px(px(8.))
                    .py(px(7.))
                    .text_size(px(13.5))
                    .child(icon("at-sign", 17., theme.text2))
                    .child(div().flex_1().min_w_0().flex().flex_col().child("Only mentions").child(div().text_size(px(12.)).text_color(theme.text3).child("Notify only when someone mentions you or replies to you")))
                    .child(switch("mentions-only", on, cx).on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("setMentionsOnly", vec![json!(key), json!(!on)], cx)))),
            );
        }
        let toggle = |list: &'static str, current: Vec<String>, key: String, state: Entity<AppState>| {
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut gpui::App| {
                let next: Vec<String> = if current.contains(&key) { current.iter().filter(|item| **item != key).cloned().collect() } else { [current.clone(), vec![key.clone()]].concat() };
                state.update(cx, |state, cx| state.act("updatePreferences", vec![json!({ list: next })], cx));
            }
        };
        section = section
            .child(
                Self::row("pin-row", if conversation.pinned { "pin-off" } else { "pin" }, if conversation.pinned { "Unpin from top" } else { "Pin to top" }.into(), None, false, cx)
                    .on_click(toggle("pinned", server.prefs.pinned.clone(), conversation.key.clone(), self.state.clone())),
            )
            .child(
                Self::row("hide-row", if conversation.hidden { "eye" } else { "eye-off" }, if conversation.hidden { "Show in list" } else { "Hide from list" }.into(), None, false, cx)
                    .on_click(toggle("hidden", server.prefs.hidden.clone(), conversation.key.clone(), self.state.clone())),
            );
        section.into_any_element()
    }

    pub(super) fn info(&mut self, server: &ServerState, conversation: &ConversationView, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if conversation.kind == "channel" {
            return self.channel_info(server, conversation, cx);
        }
        if conversation.kind == "group" {
            return self.group_info(server, conversation, cx);
        }
        let theme = theme(cx);
        let mut parts = Vec::new();
        let peer = conversation.peer_id.as_ref().and_then(|id| server.users.get(id)).cloned();
        let is_self = conversation.peer_id.as_deref() == Some(server.self_id());
        let image = conversation.avatar.as_ref().and_then(|avatar| {
            let server_id = self.server_id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
        });
        let mut card = div()
            .flex()
            .flex_col()
            .items_center()
            .text_center()
            .gap(px(2.))
            .pt(px(10.))
            .px(px(4.))
            .pb(px(6.))
            .child(avatar(
                AvatarProps {
                    name: conversation.title.clone(),
                    seed: conversation.peer_id.clone().or(conversation.group_id.clone()).unwrap_or_default(),
                    image,
                    size: 80.,
                    online: peer.as_ref().is_some_and(|p| p.online),
                    rounded: false,
                    dot_border: theme.bg1,
                },
                cx,
            ))
            .child(div().mt(px(8.)).text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(if is_self { peer.as_ref().map(|p| p.display_name.clone()).unwrap_or_default() } else { conversation.title.clone() }));
        if conversation.kind == "group" {
            if !conversation.description.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(conversation.description.clone()));
            }
        } else if let Some(peer) = &peer {
            if !peer.deleted {
                card = card.child(div().text_color(theme.text2).child(format!("@{}", peer.username)));
            }
            if let (Some(bot), false) = (&peer.bot, peer.deleted) {
                // Nobody is using a bot, so it's never online and was never last seen. Whose it is
                // and what it reads stand there instead.
                let whose = if bot.owner_id == server.self_id() { "Your bot".to_string() } else { format!("{}'s bot", server.users.get(&bot.owner_id).map(|owner| owner.display_name.clone()).unwrap_or_else(|| "Someone".into())) };
                card = card
                    .child(div().mt(px(2.)).child(bot_badge(cx)))
                    .child(div().mt(px(4.)).text_size(px(12.5)).text_color(theme.text3).child(format!("{whose}. A program runs it, and reads everything said in the chats it's in.")));
            } else if !is_self {
                let showing = !peer.deleted && !peer.online;
                crate::ui::components::redraw_last_seen(&mut self.last_seen_tick, peer.last_seen_at.filter(|_| showing), peer.hides_last_seen, cx);
                card = card.child(
                    div()
                        .text_size(px(12.5))
                        .text_color(if peer.online { theme.green } else { theme.text3 })
                        .child(if peer.deleted {
                            "Deleted their account".to_string()
                        } else if peer.online {
                            "online".to_string()
                        } else {
                            format_last_seen(peer.last_seen_at, peer.hides_last_seen, true)
                        }),
                );
            }
            if !peer.bio.is_empty() {
                card = card.child(div().mt(px(8.)).text_size(px(13.5)).text_color(theme.text2).child(peer.bio.clone()));
            }
        }
        parts.push(card.into_any_element());

        // Nothing about keys, blocking or reports for an account that's gone.
        let peer = peer.filter(|peer| !peer.deleted || is_self);
        if let (Some(peer), false) = (&peer, is_self) {
            let state = self.state.clone();
            let user_id = peer.id.clone();
            let (icon_name, color, title, text, bg) = match peer.trust.as_str() {
                "verified" => ("shield-check", theme.green, "Verified", "You've confirmed this is really them.", None),
                "changed" => ("shield-alert", theme.amber, "Security key changed", "Compare emoji to make sure nobody is in between.", Some(theme.amber_soft)),
                _ => ("shield", theme.text2, "Not verified yet", "Compare emoji to make sure nobody is in between.", None),
            };
            parts.push(
                Self::section(cx)
                    .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).px(px(8.)).py(px(5.)).child("Encryption"))
                    .child(
                        div()
                            .id("trust-card")
                            .w_full()
                            .flex()
                            .items_center()
                            .gap(px(11.))
                            .p(px(8.))
                            .rounded(RADIUS_M)
                            .when_some(bg, |el, bg| el.bg(bg))
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.hover))
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user_id.clone() }), cx)))
                            .child(icon(icon_name, 20., color))
                            .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(title)).child(div().text_size(px(12.5)).text_color(theme.text2).child(text))),
                    )
                    .into_any_element(),
            );
        }

        if conversation.kind == "group" {
            let mut members = Self::section(cx).child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text3)
                    .px(px(8.))
                    .py(px(5.))
                    .child(format!("{} {}", conversation.members.len(), if conversation.members.len() == 1 { "member" } else { "members" })),
            );
            let mut sorted = conversation.members.clone();
            sorted.sort_by_cached_key(|member| (member.role != "admin", server.users.get(&member.user_id).map(|u| u.display_name.to_lowercase()).unwrap_or_default()));
            for member in sorted {
                let user = server.users.get(&member.user_id).cloned();
                let name = user.as_ref().map(|u| u.display_name.clone()).unwrap_or_else(|| "Unknown".into());
                let image = user.as_ref().and_then(|u| u.avatar.clone()).and_then(|avatar| {
                    let server_id = self.server_id.clone();
                    self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
                });
                let is_me = member.user_id == server.self_id();
                let state = self.state.clone();
                let user_id = member.user_id.clone();
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
                        .cursor_pointer()
                        .hover(move |style| style.bg(theme.hover))
                        .on_click(move |_, _, cx| {
                            if !is_me {
                                state.update(cx, |state, cx| state.select_conversation(Some(format!("user:{user_id}")), cx));
                            }
                        })
                        .child(avatar(AvatarProps { name: name.clone(), seed: member.user_id.clone(), image, size: 36., online: user.as_ref().is_some_and(|u| u.online), rounded: false, dot_border: theme.bg2 }, cx))
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
                                        .gap(px(6.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .child(div().min_w_0().one_line().child(if is_me { format!("{name} (you)") } else { name }))
                                        .when(user.as_ref().is_some_and(|u| u.bot.is_some()), |el| el.child(bot_badge(cx))),
                                )
                                .child(div().one_line().text_size(px(12.)).text_color(theme.text3).child(if member.no_keys == Some(true) {
                                    "No device in this chat yet".to_string()
                                } else {
                                    format!("@{}", user.as_ref().map(|u| u.username.clone()).unwrap_or_default())
                                })),
                        )
                        .when(member.role == "admin", |el| el.child(icon("crown", 13., theme.text3)))
                        .when(user.as_ref().is_some_and(|u| u.trust == "verified"), |el| el.child(icon("badge-check", 14., theme.text2))),
                );
            }
            parts.push(members.into_any_element());
        }

        if let Some(rows) = self.media_rows(server, conversation, cx) {
            parts.push(rows);
        }
        parts.push(self.disappearing_row(conversation, true, cx));

        parts.push(self.preferences(server, conversation, cx));

        if let (Some(peer), false) = (&peer, is_self) {
            let blocked = server.prefs.blocked().contains(&peer.id);
            let reported = server.prefs.reported().contains(&peer.id);
            let state = self.state.clone();
            let id = peer.id.clone();
            parts.push(
                Self::section(cx)
                    .child(
                        Self::row(
                            "block",
                            "ban",
                            if blocked { format!("Unblock {}", peer.display_name) } else { format!("Block {}", peer.display_name) },
                            if blocked { None } else { Some("You won't see their messages or hear about them. They aren't told.".into()) },
                            !blocked,
                            cx,
                        )
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(!blocked)], cx))),
                    )
                    .when(!peer.banned, |el| el.child(self.report_row(peer, reported, cx)))
                    .into_any_element(),
            );
        }
        if conversation.kind == "group" {
            if let Some(group) = conversation.group_id.clone() {
                let state = self.state.clone();
                let is_admin = conversation.is_admin(&server.self_id());
                let delete_state = self.state.clone();
                let delete_group = group.clone();
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
            }
        }
        parts
    }

    /// Reporting someone to the server's admins, last in their profile (ReportRow). The admins
    /// learn whom and why, never what was said nor who reported them.
    pub(super) fn report_row(&self, peer: &UserView, reported: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if reported {
            return div()
                .w_full()
                .flex()
                .items_center()
                .gap(px(11.))
                .px(px(8.))
                .py(px(7.))
                .min_h(px(36.))
                .text_size(px(13.5))
                .text_color(theme.text3)
                .child(icon("flag", 17., theme.text2))
                .child("Reported to the server's admins")
                .into_any_element();
        }
        let (state, id) = (self.state.clone(), peer.id.clone());
        Self::row("report", "flag", format!("Report {}", peer.display_name), Some("The server's admins see whom and why, never what was said or who reported.".into()), true, cx)
            .on_click(move |event, _, cx| {
                let entries = REPORT_REASONS
                    .iter()
                    .map(|&(reason, label)| {
                        let (state, id) = (state.clone(), id.clone());
                        MenuEntry::plain(
                            label,
                            std::rc::Rc::new(move |_, cx| {
                                state.update(cx, |state, cx| {
                                    let Some(server) = state.active_server.clone() else { return };
                                    state.call(Some(&server), "reportUser", vec![json!(id), json!(reason)], cx, |state, result, cx| match result {
                                        Ok(_) => state.toast("Reported to the server's admins", ToastKind::Info, cx),
                                        Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                    })
                                })
                            }),
                        )
                    })
                    .collect();
                open_menu(event.position(), entries, true, cx);
            })
            .into_any_element()
    }

    // --- Shared media ---

    /// The disappearing messages timer, which only those who may change it can open (DisappearingRow).
    pub(super) fn disappearing_row(&self, conversation: &ConversationView, can_change: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if conversation.group_id.is_none() || !conversation.ready {
            return div().into_any_element();
        }
        let after = conversation.disappear_after;
        let hint = if after > 0. { format!("New messages disappear {} after they're sent.", timer_text(after)) } else { "New messages stay until they're deleted.".to_string() };
        let state = self.state.clone();
        let group = conversation.group_id.clone().unwrap_or_default();
        let mut row = div()
            .id("disappearing")
            .w_full()
            .flex()
            .items_center()
            .gap(px(11.))
            .px(px(8.))
            .py(px(7.))
            .min_h(px(36.))
            .rounded(RADIUS_M)
            .text_size(px(13.5))
            .child(icon("timer", 17., theme.text2))
            .child(div().flex_1().min_w_0().flex().flex_col().child("Disappearing messages").child(div().mt(px(1.)).text_size(px(12.)).text_color(theme.text3).child(hint)))
            .child(div().text_color(theme.text3).child(timer_text(after)));
        if can_change {
            row = row.cursor_pointer().hover(move |style| style.bg(theme.hover)).on_click(move |event, _, cx| {
                let choices = [0., 3600., 86400., 7. * 86400., 30. * 86400.];
                let entries = choices
                    .iter()
                    .map(|seconds| {
                        let (state, group, seconds) = (state.clone(), group.clone(), *seconds);
                        let label = format!("{}{}", if seconds == after { "✓ " } else { "" }, timer_text(seconds));
                        MenuEntry::plain(label, std::rc::Rc::new(move |_, cx| state.update(cx, |state, cx| state.act("setDisappearing", vec![json!(group), json!(seconds)], cx))))
                    })
                    .collect();
                open_menu(event.position(), entries, true, cx);
            });
        }
        Self::section(cx).child(row).into_any_element()
    }
}
