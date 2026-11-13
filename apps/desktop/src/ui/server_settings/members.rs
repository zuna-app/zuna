//! The server's members, reports and bans, and the actions on them.

use super::*;

impl ServerSettings {
    /// Asks before banning someone, wherever it's done from (BanConfirm).
    pub(super) fn ask_ban(&mut self, user_id: String, name: String, window: &mut Window, cx: &mut Context<Self>) {
        self.banning = Some((user_id, name));
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub(super) fn ban_confirm(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (user_id, name) = self.banning.clone()?;
        let (cancel, ban) = (cx.entity().downgrade(), cx.entity().downgrade());
        Some(crate::ui::overlays::confirm(
            format!("Ban {name}?"),
            "Ban from server",
            "They're signed out everywhere and removed from every group and channel. An admin can unban them later, in Bans.".into(),
            move |_, cx| {
                cancel
                    .update(cx, |view, cx| {
                        view.banning = None;
                        cx.notify();
                    })
                    .ok();
            },
            move |_, cx| {
                ban.update(cx, |view, cx| {
                    view.banning = None;
                    view.moderate("banUser", user_id.clone(), cx);
                })
                .ok();
            },
            cx,
        ))
    }

    /// Reads who was reported, as `ReportsSection` does each time it's opened and after each change.
    pub(super) fn load_reports(&mut self, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "getReports", vec![]);
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.reports = Some(result.map(from_value).unwrap_or_default());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Whom the server's users say are banned, in order.
    pub(super) fn banned_ids(&self, cx: &gpui::App) -> Vec<String> {
        let mut ids: Vec<_> = self.state.read(cx).active().map(|server| server.users.values().filter(|user| user.banned && !user.deleted).map(|user| user.id.clone()).collect()).unwrap_or_default();
        ids.sort();
        ids
    }

    /// Reads who is banned, as `BansSection` does each time it's opened and whenever who is changes.
    pub(super) fn load_bans(&mut self, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        self.banned_seen = self.banned_ids(cx);
        let call = self.state.read(cx).core.call(Some(&server), "getBans", vec![]);
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.bans = Some(result.map(from_value).unwrap_or_default());
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Bans or unbans someone or dismisses their reports, then reads the list shown again.
    pub(super) fn moderate(&mut self, method: &'static str, user_id: String, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), method, vec![json!(user_id)]);
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| match result {
                Ok(_) if view.section == "reports" => view.load_reports(cx),
                Ok(_) if view.section == "bans" => view.load_bans(cx),
                Ok(_) => {}
                Err(error) => view.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn members(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let needle = self.member_search.read(cx).text().trim().to_lowercase();
        let self_role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        // Nothing can be done about an account that's gone, and someone banned is in Bans.
        let mut users: Vec<_> = server.users.values().filter(|user| !user.deleted && !user.banned).filter(|user| needle.is_empty() || user.display_name.to_lowercase().contains(&needle) || user.username.to_lowercase().contains(&needle)).cloned().collect();
        users.sort_by_cached_key(|user| user.display_name.to_lowercase());
        let mut list = div().flex().flex_col().gap(px(3.));
        for user in users {
            let can_act = user.id != server.self_id() && user.role != "owner" && (self_role == "owner" || user.role == "member");
            let image = user.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            let mut entries = Vec::new();
            // A bot is never one of the server's admins.
            if self_role == "owner" && user.bot.is_none() {
                let (state, id, admin) = (self.state.clone(), user.id.clone(), user.role == "admin");
                entries.push(MenuEntry::new(if admin { "Remove admin" } else { "Make admin" }, "crown", move |_, cx| {
                    state.update(cx, |state, cx| state.act("setServerRole", vec![json!(id), json!(if admin { "member" } else { "admin" })], cx))
                }));
            }
            let (view, id, name) = (cx.entity().downgrade(), user.id.clone(), user.display_name.clone());
            entries.push(MenuEntry::new("Ban from server", "ban", move |window, cx| {
                view.update(cx, |view, cx| view.ask_ban(id.clone(), name.clone(), window, cx)).ok();
            }).danger());
            let chip = |text: String| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .px(px(7.))
                    .py(px(2.))
                    .rounded(px(10.))
                    .text_size(px(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .bg(theme.bg3)
                    .text_color(theme.text2)
                    .child(icon("crown", 12., theme.text2))
                    .child(text)
            };
            list = list.child(
                named_div(SharedString::from(format!("server-member-{}", user.id)))
                    .w_full()
                    .flex()
                    .items_center()
                    .gap(px(11.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg2)
                    .text_size(px(13.5))
                    .when(can_act, |el| el.cursor_pointer().hover(move |style| style.bg(theme.bg3)))
                    .on_click(move |event, _, cx| {
                        if can_act {
                            open_menu(event.position(), entries.clone(), false, cx);
                        }
                    })
                    .child(avatar(AvatarProps { name: user.display_name.clone(), seed: user.id.clone(), image, size: 36., online: user.online, rounded: false, dot_border: theme.bg2 }, cx))
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().flex().items_center().gap(px(6.)).child(div().min_w_0().one_line().font_weight(FontWeight::MEDIUM).child(user.display_name.clone())).when(user.bot.is_some(), |el| el.child(bot_badge(cx)))).child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username))))
                    .when(user.role != "member", |el| el.child(chip(if user.role == "owner" { "Owner".into() } else { "Admin".into() }))),
            );
        }
        vec![
            Self::heading("Members"),
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .bg(theme.bg2)
                .rounded(RADIUS_M)
                .border_1()
                .border_color(theme.line)
                .px(px(11.))
                .h(px(36.))
                .text_size(px(13.5))
                .child(icon("search", 15., theme.text3))
                .child(div().flex_1().min_w_0().child(self.member_search.clone()))
                .into_any_element(),
            list.into_any_element(),
        ]
    }

    /// Who was reported, how often and why: never what was said, which nobody here can read,
    /// nor who reported them (ReportsSection).
    pub(super) fn reports_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let self_role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        let list = match self.reports.clone() {
            None => div().flex().child(spinner(18., theme.text2)).into_any_element(),
            Some(reports) if reports.is_empty() => div().text_size(px(13.5)).text_color(theme.text2).child("Nobody has been reported.").into_any_element(),
            Some(reports) => {
                let mut list = div().flex().flex_col().gap(px(3.));
                for report in reports {
                    let user = server.users.get(&report.user_id).cloned();
                    let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into());
                    let can_ban = user.as_ref().is_some_and(|user| !user.banned && !user.deleted && user.role != "owner" && (self_role == "owner" || user.role == "member"));
                    let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
                        let server_id = server.entry.id.clone();
                        self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
                    });
                    let count = if report.count == 1. { "1 report".to_string() } else { format!("{} reports", report.count) };
                    let reasons = report.reasons.iter().map(|reason| report_reason_label(reason)).collect::<Vec<_>>().join(", ");
                    let (dismiss, ban) = (report.user_id.clone(), report.user_id.clone());
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("report-{}", report.user_id)))
                            .w_full()
                            .flex()
                            .items_center()
                            .gap(px(11.))
                            .px(px(10.))
                            .py(px(8.))
                            .rounded(RADIUS_M)
                            .bg(theme.bg2)
                            .text_size(px(13.5))
                            .child(avatar(AvatarProps { name: name.clone(), seed: report.user_id.clone(), image, size: 36., online: false, rounded: false, dot_border: theme.bg2 }, cx))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(div().one_line().font_weight(FontWeight::MEDIUM).child(name.clone()))
                                    .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("{count} · {reasons} · {}", format_full(report.last_at)))),
                            )
                            .child(button(SharedString::from(format!("dismiss-{}", report.user_id)), ButtonKind::Default, ButtonSize::Small, false, cx).child("Dismiss").on_click(cx.listener(move |view, _, _, cx| view.moderate("dismissReports", dismiss.clone(), cx))))
                            .when(can_ban, |el| {
                                el.child(button(SharedString::from(format!("ban-{}", report.user_id)), ButtonKind::Danger, ButtonSize::Small, false, cx).child(icon("ban", 13., theme.red)).child("Ban").on_click(cx.listener(move |view, _, window, cx| view.ask_ban(ban.clone(), name.clone(), window, cx))))
                            }),
                    );
                }
                list.into_any_element()
            }
        };
        vec![
            Self::heading("Reports"),
            Self::lead(&format!("People others on {} reported, and why. Messages are encrypted, so nobody here sees what was said, and who reported them isn't kept.", server.entry.name), cx),
            list,
        ]
    }

    /// Who is banned, when and by whom, to let them back in (BansSection).
    pub(super) fn bans_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let self_role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        // Someone unbanned anywhere else is off it at once, before it's read again.
        let shown = self.bans.clone().map(|bans| bans.into_iter().filter(|ban| server.users.get(&ban.user_id).is_none_or(|user| user.banned)).collect::<Vec<_>>());
        let list = match shown {
            None => div().flex().child(spinner(18., theme.text2)).into_any_element(),
            Some(bans) if bans.is_empty() => div().text_size(px(13.5)).text_color(theme.text2).child("Nobody is banned.").into_any_element(),
            Some(bans) => {
                let mut list = div().flex().flex_col().gap(px(3.));
                for ban in bans {
                    let user = server.users.get(&ban.user_id).cloned();
                    let name = user.as_ref().map(|user| user.display_name.clone()).unwrap_or_else(|| "Unknown".into());
                    let by = if ban.banned_by == server.self_id() { Some("you".to_string()) } else { server.users.get(&ban.banned_by).map(|user| user.display_name.clone()) };
                    // The owner can unban anyone, and admins only members, as with banning.
                    let can_unban = user.as_ref().is_some_and(|user| self_role == "owner" || user.role == "member");
                    let image = user.as_ref().and_then(|user| user.avatar.clone()).and_then(|avatar| {
                        let server_id = server.entry.id.clone();
                        self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, &avatar, cx))
                    });
                    let username = user.as_ref().map(|user| format!("@{} · ", user.username)).unwrap_or_default();
                    let by = by.map(|by| format!("by {by} ")).unwrap_or_default();
                    let id = ban.user_id.clone();
                    let unban = button(SharedString::from(format!("unban-{}", ban.user_id)), ButtonKind::Default, ButtonSize::Small, !can_unban, cx).child(icon("user-round", 13., theme.text1)).child("Unban");
                    list = list.child(
                        div()
                            .id(SharedString::from(format!("ban-row-{}", ban.user_id)))
                            .w_full()
                            .flex()
                            .items_center()
                            .gap(px(11.))
                            .px(px(10.))
                            .py(px(8.))
                            .rounded(RADIUS_M)
                            .bg(theme.bg2)
                            .text_size(px(13.5))
                            .child(avatar(AvatarProps { name: name.clone(), seed: ban.user_id.clone(), image, size: 36., online: false, rounded: false, dot_border: theme.bg2 }, cx))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .child(div().one_line().font_weight(FontWeight::MEDIUM).child(name))
                                    .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("{username}Banned {by}on {}", format_full(ban.banned_at)))),
                            )
                            .child(if can_unban {
                                unban.on_click(cx.listener(move |view, _, _, cx| view.moderate("unbanUser", id.clone(), cx))).into_any_element()
                            } else {
                                unban.tooltip(tooltip("Only the server's owner can unban an admin.")).into_any_element()
                            }),
                    );
                }
                list.into_any_element()
            }
        };
        vec![
            Self::heading("Bans"),
            Self::lead(&format!("People banned from {}. Unbanned, they can sign in again, and they're back in their direct messages and channels. Groups have to add them again.", server.entry.name), cx),
            list,
        ]
    }
}

#[cfg(test)]
mod tests {
    //! A server's members, reports and bans in its settings, as its owner uses them: someone
    //! made an admin and banned after the question, found by a search; a report dismissed or
    //! its person banned; and someone banned let back in.

    use gpui::TestAppContext;
    use serde_json::{Value, json};

    use super::*;
    use crate::state::Overlay;
    use crate::testing::fixtures::*;
    use crate::testing::{App as Running, World};

    fn open(cx: &mut TestAppContext, name: &str, section: &str, change: impl FnOnce(&mut World)) -> Running {
        let mut world = World::new(name);
        world.server["getCalls"] = json!([]);
        change(&mut world);
        let app = Running::open(cx, &world);
        for method in ["setServerRole", "banUser", "unbanUser", "dismissReports"] {
            app.answer(method, |_| Ok(Value::Null));
        }
        app.update(cx, |state, cx| {
            state.settings.reduce_motion = true;
            state.select_server(SERVER, cx);
            state.set_overlay(Some(Overlay::ServerSettings { section: Some(section.into()) }), cx);
        });
        app
    }

    fn settings(app: &Running, cx: &mut TestAppContext) -> Entity<ServerSettings> {
        app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<ServerSettings>().ok())).unwrap().expect("the server's settings are open")
    }

    fn choose(app: &Running, cx: &mut TestAppContext, label: &str) {
        assert!(app.window.update(cx, |_, window, cx| crate::ui::menu::choose(label, window, cx)).unwrap(), "{label} is in the menu");
        app.run(cx);
    }

    #[gpui::test]
    fn a_member_is_made_an_admin_found_and_banned(cx: &mut TestAppContext) {
        let app = open(cx, "server-members", "members", |_| {});
        app.click(cx, &format!("server-member-{BOB}"));
        assert_eq!(cx.read(|cx| crate::ui::menu::open_labels(cx)), vec!["Make admin".to_string(), "Ban from server".to_string()]);
        choose(&app, cx, "Make admin");
        assert_eq!(app.calls_of("setServerRole"), vec![vec![json!(BOB), json!("admin")]]);
        // Carol is an admin already, and a bot never is one.
        app.click(cx, &format!("server-member-{CAROL}"));
        choose(&app, cx, "Remove admin");
        assert_eq!(app.calls_of("setServerRole")[1], vec![json!(CAROL), json!("member")]);
        app.click(cx, &format!("server-member-{BOT}"));
        assert_eq!(cx.read(|cx| crate::ui::menu::open_labels(cx)), vec!["Ban from server".to_string()]);
        // Banned only once the question is answered.
        choose(&app, cx, "Ban from server");
        app.click(cx, "confirm-cancel");
        assert!(app.calls_of("banUser").is_empty());
        app.click(cx, &format!("server-member-{BOB}"));
        choose(&app, cx, "Ban from server");
        app.click(cx, "confirm-action");
        assert_eq!(app.calls_of("banUser"), vec![vec![json!(BOB)]]);
        // A search narrows the list.
        let view = settings(&app, cx);
        let search = cx.read(|cx| view.read(cx).member_search.clone());
        search.update(cx, |input, cx| input.set_text("car", cx));
        app.run(cx);
        assert!(app.drawn(cx, &format!("server-member-{CAROL}")) && !app.drawn(cx, &format!("server-member-{BOB}")));
    }

    #[gpui::test]
    fn reports_are_dismissed_or_acted_on_and_bans_undone(cx: &mut TestAppContext) {
        let app = open(cx, "server-reports", "reports", |world| {
            world.server["getReports"] = json!([{ "userId": BOB, "count": 2, "reasons": ["spam", "other"], "lastAt": NOW }, { "userId": CAROL, "count": 1, "reasons": ["harassment"], "lastAt": NOW }]);
            world.server["getUsers"].as_array_mut().unwrap().push(json!({ "id": "u-dan", "username": "dan", "displayName": "Dan", "role": "member", "banned": true }));
            world.server["getBans"] = json!([{ "userId": "u-dan", "bannedAt": NOW, "bannedBy": ME }, { "userId": "u-unknown", "bannedAt": NOW, "bannedBy": "" }, { "userId": BOB, "bannedAt": NOW, "bannedBy": ME }]);
        });
        app.click(cx, &format!("dismiss-{CAROL}"));
        assert_eq!(app.calls_of("dismissReports"), vec![vec![json!(CAROL)]]);
        assert!(app.calls_of("getReports").len() >= 2, "read again after");
        app.click(cx, &format!("ban-{BOB}"));
        app.click(cx, "confirm-action");
        assert_eq!(app.calls_of("banUser"), vec![vec![json!(BOB)]]);
        // In Bans, someone is let back in.
        app.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: Some("bans".into()) }), cx));
        assert!(!app.drawn(cx, &format!("unban-{BOB}")), "someone unbanned elsewhere is off the list before it's read again");
        app.click(cx, "unban-u-unknown");
        assert!(app.calls_of("unbanUser").is_empty(), "nobody the server knows of can't be unbanned from here");
        app.click(cx, "unban-u-dan");
        assert_eq!(app.calls_of("unbanUser"), vec![vec![json!("u-dan")]]);
    }
}
