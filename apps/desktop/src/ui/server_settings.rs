//! A server's settings, for its admins, and signing out of it
//! (packages/ui/src/features/overlays/ServerSettings.tsx).

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, img, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::invites::InvitePanel;
use super::menu::{MenuEntry, open_menu};
use super::text_input::{InputEvent, TextInput};
use crate::format::format_full;
use crate::models::{BanView, ReportView, from_value, report_reason_label};
use crate::state::{AppState, ServerState, ToastKind};
use crate::theme::{FONT_MONO, RADIUS_M, RADIUS_XL};

pub struct ServerSettings {
    state: Entity<AppState>,
    section: String,
    name: Entity<TextInput>,
    member_search: Entity<TextInput>,
    emote_link: Entity<TextInput>,
    max_upload: Entity<TextInput>,
    retention: Entity<TextInput>,
    delete_password: Entity<TextInput>,
    invites: Entity<InvitePanel>,
    icon_version: u64,
    busy: bool,
    refreshing: bool,
    /// Holds focus while nothing in it does, so Escape closes it.
    focus: gpui::FocusHandle,
    soundboard: Option<Entity<super::server_voice::ServerSoundboard>>,
    screen_rules: Option<Entity<super::server_voice::ServerScreenRules>>,
    /// Who was reported, read each time Reports is opened, or nothing while it's read.
    reports: Option<Vec<ReportView>>,
    /// Who is banned, read each time Bans is opened and whenever who is changes, or nothing while it's read.
    bans: Option<Vec<BanView>>,
    /// Whom the server's users said were banned when the bans were last read.
    banned_seen: Vec<String>,
    /// Whom a ban is being asked about, by ID and name.
    banning: Option<(String, String)>,
    /// Whether deleting the account is being asked about.
    deleting: bool,
    _subscriptions: Vec<Subscription>,
}

impl ServerSettings {
    pub fn new(state: Entity<AppState>, section: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let server = state.read(cx).active().cloned();
        let is_admin = server.as_ref().is_some_and(|server| server.is_admin());
        let input = |cx: &mut Context<Self>, placeholder: &str, text: String| {
            cx.new(|cx| {
                let mut input = TextInput::new(cx, placeholder.to_string());
                input.set_text(text, cx);
                input
            })
        };
        let name = input(cx, "", server.as_ref().map(|s| s.entry.name.clone()).unwrap_or_default());
        let member_search = input(cx, &format!("Search {} members", server.as_ref().map(|s| s.users.len()).unwrap_or(0)), String::new());
        let emote_link = input(cx, "https://7tv.app/emote-sets/...", String::new());
        let info = server.as_ref().and_then(|s| s.info.clone()).unwrap_or_default();
        let max_upload = input(cx, "", format!("{}", if info.max_upload_mb > 0. { info.max_upload_mb } else { 100. }));
        let retention = input(cx, "", format!("{}", info.retention_days));
        let delete_password = cx.new(|cx| TextInput::new(cx, "").masked(true));
        let invites = cx.new(|cx| InvitePanel::new(state.clone(), cx));
        let mut subscriptions = vec![cx.observe(&state, |view: &mut Self, _, cx| {
            // Read again whenever someone is banned or unbanned, from here or anywhere else.
            if view.section == "bans" && view.banned_ids(cx) != view.banned_seen {
                view.load_bans(cx);
            }
            cx.notify()
        })];
        for input in [&name, &member_search, &emote_link, &max_upload, &retention, &delete_password] {
            subscriptions.push(cx.subscribe_in(input, window, |view, _, event, _, cx| {
                if *event == InputEvent::Escape {
                    view.escape(cx);
                }
                cx.notify();
            }));
        }
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let mut settings = ServerSettings {
            state,
            section: section.unwrap_or_else(|| if is_admin { "overview".into() } else { "leave".into() }),
            name,
            member_search,
            emote_link,
            max_upload,
            retention,
            delete_password,
            invites,
            icon_version: 0,
            busy: false,
            refreshing: false,
            focus,
            soundboard: None,
            screen_rules: None,
            reports: None,
            bans: None,
            banned_seen: Vec::new(),
            banning: None,
            deleting: false,
            _subscriptions: subscriptions,
        };
        if settings.section == "reports" {
            settings.load_reports(cx);
        }
        if settings.section == "bans" {
            settings.load_bans(cx);
        }
        settings
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }

    /// Escape says no to a ban or deleting the account being asked about, and otherwise closes the settings.
    fn escape(&mut self, cx: &mut Context<Self>) {
        if self.banning.is_some() || self.deleting {
            self.banning = None;
            self.deleting = false;
            cx.notify();
        } else {
            self.close(cx);
        }
    }

    /// Asks before banning someone, wherever it's done from (BanConfirm).
    fn ask_ban(&mut self, user_id: String, name: String, window: &mut Window, cx: &mut Context<Self>) {
        self.banning = Some((user_id, name));
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Asks before deleting the account, as `DeleteAccountSection` does.
    fn delete_confirm(&mut self, server_name: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.deleting {
            return None;
        }
        let (cancel, delete) = (cx.entity().downgrade(), cx.entity().downgrade());
        Some(super::overlays::confirm(
            format!("Delete your account on {server_name}?"),
            "Delete account",
            "It can't be undone. What you sent stays with the people you sent it to, from \"Deleted account\".".into(),
            move |_, cx| {
                cancel
                    .update(cx, |view, cx| {
                        view.deleting = false;
                        cx.notify();
                    })
                    .ok();
            },
            move |_, cx| {
                delete.update(cx, |view, cx| view.delete_account(cx)).ok();
            },
            cx,
        ))
    }

    /// Deletes the account on this server, and everything this device keeps for it.
    fn delete_account(&mut self, cx: &mut Context<Self>) {
        self.deleting = false;
        let Some(id) = self.state.read(cx).active_server.clone() else { return };
        let password = self.delete_password.read(cx).text().to_string();
        let call = self.state.read(cx).core.call(None, "deleteAccount", vec![json!(id), json!(password)]);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                view.state.update(cx, |state, cx| match result {
                    Ok(_) => {
                        state.set_overlay(None, cx);
                        state.remove_server(&id, cx);
                    }
                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn ban_confirm(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (user_id, name) = self.banning.clone()?;
        let (cancel, ban) = (cx.entity().downgrade(), cx.entity().downgrade());
        Some(super::overlays::confirm(
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
    fn load_reports(&mut self, cx: &mut Context<Self>) {
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
    fn banned_ids(&self, cx: &gpui::App) -> Vec<String> {
        let mut ids: Vec<_> = self.state.read(cx).active().map(|server| server.users.values().filter(|user| user.banned && !user.deleted).map(|user| user.id.clone()).collect()).unwrap_or_default();
        ids.sort();
        ids
    }

    /// Reads who is banned, as `BansSection` does each time it's opened and whenever who is changes.
    fn load_bans(&mut self, cx: &mut Context<Self>) {
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
    fn moderate(&mut self, method: &'static str, user_id: String, cx: &mut Context<Self>) {
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

    fn heading(text: &str) -> AnyElement {
        div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(text.to_string()).into_any_element()
    }

    fn lead(text: &str, cx: &gpui::App) -> AnyElement {
        div().w_full().mt(px(-8.)).text_size(px(13.5)).text_color(theme(cx).text2).child(text.to_string()).into_any_element()
    }

    fn row(title: &str, hint: Option<&str>, control: AnyElement, cx: &gpui::App) -> AnyElement {
        let theme = theme(cx);
        div()
            .flex()
            .items_center()
            .gap(px(16.))
            .py(px(4.))
            .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).child(title.to_string())).when_some(hint, |el, hint| el.child(div().text_size(px(12.5)).text_color(theme.text2).child(hint.to_string()))))
            .child(control)
            .into_any_element()
    }

    fn divider(cx: &gpui::App) -> AnyElement {
        div().h(px(1.)).bg(theme(cx).line).my(px(6.)).into_any_element()
    }

    /// Calls the server's session, with a toast for how it went.
    fn run(&mut self, method: &'static str, args: Vec<serde_json::Value>, done: Option<String>, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), method, args);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                view.state.update(cx, |state, cx| match &result {
                    Ok(_) => {
                        if let Some(done) = &done {
                            state.toast(done.clone(), ToastKind::Info, cx);
                        }
                    }
                    Err(error) => state.toast(error.message.clone(), ToastKind::Error, cx),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn overview(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let icon_url = server.info.as_ref().filter(|info| info.has_icon).map(|_| format!("{}/api/icon?v={}", server.entry.url, self.icon_version));
        let icon_image = icon_url.and_then(|url| self.state.update(cx, |state, cx| state.remote_picture(&url, cx)));
        let picture = div()
            .id("server-icon-edit")
            .relative()
            .size(px(72.))
            .flex_none()
            .rounded(RADIUS_XL)
            .overflow_hidden()
            .group("server-icon")
            .cursor_pointer()
            .on_click(cx.listener(|_, _, _, cx| {
                let picked = crate::media::pick_avatar(cx);
                cx.spawn(async move |view, cx| {
                    let Some(prepared) = picked.await else { return };
                    view.update(cx, |view, cx| match prepared {
                        Ok(file) => {
                            view.icon_version = crate::format::now_ms() as u64;
                            view.run("updateServerIcon", vec![crate::host::file(&file.to_string_lossy(), "image/jpeg")], None, cx);
                        }
                        Err(()) => view.state.update(cx, |state, cx| state.toast("That image couldn't be processed.", ToastKind::Error, cx)),
                    })
                    .ok();
                })
                .detach();
            }))
            .child(match icon_image {
                Some(image) => cover(image, 1., 144, cx).size_full().rounded(RADIUS_XL).into_any_element(),
                None => avatar(AvatarProps { name: server.entry.name.clone(), seed: server.entry.url.clone(), image: None, size: 72., online: false, rounded: true, dot_border: theme.bg1 }, cx).into_any_element(),
            })
            .child(div().absolute().inset_0().flex().items_center().justify_center().bg(crate::theme::color(crate::theme::black_a(0.5))).opacity(0.).group_hover("server-icon", |style| style.opacity(1.)).child(icon("image", 18., gpui::white())));
        let name = self.name.read(cx).text().trim().to_string();
        let changed = !name.is_empty() && name != server.entry.name;
        let busy = self.busy;
        let version = server.info.as_ref().map(|info| info.version.clone()).unwrap_or_default();
        vec![
            Self::heading("Server"),
            Self::lead("The name and picture are public: they appear on invite pages before anyone signs in.", cx),
            div().flex().items_center().gap(px(18.)).child(picture).child(div().flex_1().child(field(Some("Server name"), self.name.clone(), None, None, false, None, cx))).into_any_element(),
            div()
                .flex()
                .child(button("save-server", ButtonKind::Primary, ButtonSize::Normal, !changed || busy, cx).child("Save changes").when(changed && !busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "name": name })], Some("Saved".into()), cx)))
                }))
                .into_any_element(),
            Self::divider(cx),
            Self::row("Address", Some("People and apps reach your server here."), div().max_w(px(260.)).font_family(FONT_MONO).text_size(px(12.5)).child(server.entry.address.clone()).into_any_element(), cx),
            Self::row("Version", None, div().font_family(FONT_MONO).text_size(px(12.5)).child(version).into_any_element(), cx),
        ]
    }

    fn invites_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let info = server.info.clone().unwrap_or_default();
        let open = info.registration == "open";
        let members_invite = info.allow_member_invites;
        vec![
            Self::heading("Invites"),
            Self::lead("Invite links are the safest way for people to join.", cx),
            self.invites.clone().into_any_element(),
            Self::divider(cx),
            Self::row(
                "Let members create invite links",
                Some("If off, only admins can."),
                switch("member-invites", members_invite, cx).on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "allow_member_invites": !members_invite })], None, cx))).into_any_element(),
                cx,
            ),
            Self::row(
                "Open sign-ups",
                Some("Anyone who knows the address can join. This gives the server the key that protects profiles, so it can read display names and pictures. Messages stay encrypted."),
                switch("open-signups", open, cx).on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "registration": if open { "invite" } else { "open" } })], None, cx))).into_any_element(),
                cx,
            ),
        ]
    }

    fn members(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let needle = self.member_search.read(cx).text().trim().to_lowercase();
        let self_role = server.me.as_ref().map(|me| me.role.clone()).unwrap_or_default();
        // Nothing can be done about an account that's gone, and someone banned is in Bans.
        let mut users: Vec<_> = server.users.values().filter(|user| !user.deleted && !user.banned).filter(|user| needle.is_empty() || user.display_name.to_lowercase().contains(&needle) || user.username.to_lowercase().contains(&needle)).cloned().collect();
        users.sort_by_key(|user| user.display_name.to_lowercase());
        let mut list = div().flex().flex_col().gap(px(3.));
        for user in users {
            let can_act = user.id != server.self_id() && user.role != "owner" && (self_role == "owner" || user.role == "member");
            let image = user.avatar.as_ref().and_then(|avatar| {
                let server_id = server.entry.id.clone();
                self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
            });
            let mut entries = Vec::new();
            if self_role == "owner" {
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
                div()
                    .id(SharedString::from(format!("server-member-{}", user.id)))
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
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().one_line().font_weight(FontWeight::MEDIUM).child(user.display_name.clone())).child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username))))
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
    fn reports_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
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
    fn bans_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
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

    fn emotes(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let set_id = server.emotes.set_id.clone();
        let count = server.emotes.emotes.len();
        let busy = self.busy || self.refreshing;
        let link = self.emote_link.read(cx).text().trim().to_string();
        let mut grid = div().flex().flex_wrap().gap(px(4.));
        for emote in server.emotes.emotes.iter().take(80) {
            let url = crate::models::emote_url(&server.entry.url, &emote.id);
            let image = self.state.update(cx, |state, cx| state.remote_picture(&url, cx));
            grid = grid.child(div().id(SharedString::from(format!("emote-preview-{}", emote.id))).size(px(40.)).p(px(4.)).tooltip(tooltip(emote.name.clone())).when_some(image, |el, image| el.child(img(image).size_full().object_fit(gpui::ObjectFit::Contain))));
        }
        vec![
            Self::heading("Emotes"),
            Self::lead("Everyone on this server shares one 7TV emote set. Your server downloads and caches the images, so 7TV never sees your members' addresses. It checks 7TV for changes to the set every few hours.", cx),
            div()
                .flex()
                .items_center()
                .gap(px(11.))
                .px(px(12.))
                .py(px(10.))
                .rounded(RADIUS_M)
                .bg(theme.bg2)
                .child(icon("face-slightly-smiling", 18., theme.text2))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().font_weight(FontWeight::MEDIUM).child(if server.emotes.set_name.is_empty() { "No emote set".to_string() } else { server.emotes.set_name.clone() }))
                        .child(div().text_size(px(12.5)).text_color(theme.text3).child(format!("{count} emotes"))),
                )
                .when(!set_id.is_empty(), |el| {
                    el.child(button("refresh-emotes", ButtonKind::Default, ButtonSize::Small, busy, cx).child(if self.refreshing { "Refreshing…" } else { "Refresh" }).when(!busy, |el| {
                        el.on_click(cx.listener(move |view, _, _, cx| {
                            view.refreshing = true;
                            view.set_emotes(set_id.clone(), "Updated", cx);
                        }))
                    }))
                })
                .into_any_element(),
            field(Some("Use a different set"), self.emote_link.clone(), None, Some("Paste a link to any emote set on 7TV.".into()), false, None, cx).into_any_element(),
            div()
                .flex()
                .child(button("use-set", ButtonKind::Primary, ButtonSize::Normal, link.is_empty() || busy, cx).child("Use this set").when(!link.is_empty() && !busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| {
                        view.busy = true;
                        view.set_emotes(link.clone(), "Now using", cx);
                    }))
                }))
                .into_any_element(),
            grid.into_any_element(),
        ]
    }

    fn set_emotes(&mut self, set: String, verb: &'static str, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "setEmoteSet", vec![json!(set)]);
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                view.refreshing = false;
                match result {
                    Ok(value) => {
                        let name = value.get("set_name").and_then(|name| name.as_str()).unwrap_or_default().to_string();
                        let count = value.get("count").and_then(|count| count.as_f64()).unwrap_or(0.);
                        if verb == "Now using" {
                            view.emote_link.update(cx, |input, cx| input.set_text("", cx));
                        }
                        view.state.update(cx, |state, cx| state.toast(format!("{verb} {name} ({} emotes)", count as u64), ToastKind::Info, cx));
                    }
                    Err(error) => view.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn storage(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let max: f64 = self.max_upload.read(cx).text().trim().parse().unwrap_or(0.);
        let keep: f64 = self.retention.read(cx).text().trim().parse().unwrap_or(-1.);
        let valid = max >= 1. && keep >= 0.;
        let busy = self.busy;
        let theme = theme(cx);
        let suffix = |text: &str| div().text_size(px(13.)).text_color(theme.text3).child(text.to_string()).into_any_element();
        vec![
            Self::heading("Storage"),
            field(Some("Largest file members can send"), self.max_upload.clone(), None, None, false, Some(suffix("MB")), cx).into_any_element(),
            field(
                Some("Delete messages after"),
                self.retention.clone(),
                None,
                Some("0 keeps messages forever. Pinned messages are kept. This is enforced by the server, so it only removes the server's copy.".into()),
                false,
                Some(suffix("days")),
                cx,
            )
            .into_any_element(),
            div()
                .flex()
                .child(button("save-storage", ButtonKind::Primary, ButtonSize::Normal, !valid || busy, cx).child("Save changes").when(valid && !busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| view.run("updateServerSettings", vec![json!({ "max_upload_mb": max, "retention_days": keep })], Some("Saved".into()), cx)))
                }))
                .into_any_element(),
        ]
    }

    fn delete_section(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let name = &server.entry.name;
        // A server can't be without its owner, whom nobody else can become.
        if server.me.as_ref().is_some_and(|me| me.role == "owner") {
            return vec![
                Self::heading("Delete account"),
                Self::lead(&format!("You own {name}, and a server can't be without its owner, so your account there can't be deleted. Stopping the server and deleting its data removes everything on it."), cx),
            ];
        }
        let typed = !self.delete_password.read(cx).text().is_empty();
        let busy = self.busy;
        vec![
            Self::heading("Delete account"),
            Self::lead(
                &format!("This deletes your account on {name}, with your profile and keys, signs out your other devices, and erases this device's copy of your messages. What you sent stays with the people you sent it to, from \"Deleted account\". Your username becomes free for someone else. It can't be undone."),
                cx,
            ),
            field(Some("Password"), self.delete_password.clone(), None, None, false, None, cx).into_any_element(),
            div()
                .flex()
                .child(
                    button("delete-account", ButtonKind::Danger, ButtonSize::Normal, !typed || busy, cx)
                        .when(busy, |el| el.child(spinner(15., theme.red)))
                        .when(!busy, |el| el.child(icon("trash", 15., theme.red)).child("Delete my account"))
                        .when(typed && !busy, |el| {
                            el.on_click(cx.listener(|view, _, window, cx| {
                                view.deleting = true;
                                window.focus(&view.focus, cx);
                                cx.notify();
                            }))
                        }),
                )
                .into_any_element(),
        ]
    }

    fn leave(&mut self, server: &ServerState, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let busy = self.busy;
        let id = server.entry.id.clone();
        vec![
            Self::heading("Sign out"),
            div()
                .text_size(px(13.5))
                .text_color(theme.text2)
                .child(format!(
                    "This signs you out of {} on this device and erases its local copy of your messages. Your account and history stay on the server, and you can sign back in with your password.",
                    server.entry.name
                ))
                .into_any_element(),
            div()
                .flex()
                .child(button("sign-out-server", ButtonKind::Danger, ButtonSize::Normal, busy, cx).child(icon("log-out", 15., theme.red)).child("Sign out and erase local data").when(!busy, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| {
                        view.busy = true;
                        let id = id.clone();
                        let call = view.state.read(cx).core.call(None, "leaveServer", vec![json!(id)]);
                        cx.spawn(async move |view, cx| {
                            let result = call.await;
                            view.update(cx, |view, cx| {
                                view.busy = false;
                                view.state.update(cx, |state, cx| match result {
                                    Ok(_) => {
                                        state.set_overlay(None, cx);
                                        state.remove_server(&id, cx);
                                    }
                                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                });
                            })
                            .ok();
                        })
                        .detach();
                    }))
                }))
                .into_any_element(),
        ]
    }
}

impl Render for ServerSettings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let is_admin = server.is_admin();
        let mut sections: Vec<(&str, &str, &str)> = Vec::new();
        if is_admin {
            sections.extend([
                ("overview", "Overview", "server"),
                ("invites", "Invites", "link"),
                ("members", "Members", "users"),
                ("reports", "Reports", "flag"),
                ("bans", "Bans", "ban"),
                ("emotes", "Emotes", "face-slightly-smiling"),
                ("soundboard", "Soundboard", "audio-lines"),
                ("storage", "Storage", "hard-drive"),
                ("screen", "Screen sharing", "monitor-up"),
            ]);
        }
        sections.push(("leave", "Sign out", "log-out"));
        sections.push(("delete", "Delete account", "trash"));
        let page = match self.section.as_str() {
            "overview" if is_admin => self.overview(&server, cx),
            "invites" if is_admin => self.invites_section(&server, cx),
            "members" if is_admin => self.members(&server, cx),
            "reports" if is_admin => self.reports_section(&server, cx),
            "bans" if is_admin => self.bans_section(&server, cx),
            "delete" => self.delete_section(&server, cx),
            "emotes" if is_admin => self.emotes(&server, cx),
            "storage" if is_admin => self.storage(cx),
            "soundboard" if is_admin => {
                let state = self.state.clone();
                let page = match &self.soundboard {
                    Some(page) => page.clone(),
                    None => {
                        let page = cx.new(|cx| super::server_voice::ServerSoundboard::new(state, window, cx));
                        self.soundboard = Some(page.clone());
                        page
                    }
                };
                vec![page.into_any_element()]
            }
            "screen" if is_admin => {
                let state = self.state.clone();
                let page = match &self.screen_rules {
                    Some(page) => page.clone(),
                    None => {
                        let page = cx.new(|cx| super::server_voice::ServerScreenRules::new(state, window, cx));
                        self.screen_rules = Some(page.clone());
                        page
                    }
                };
                vec![page.into_any_element()]
            }
            _ => self.leave(&server, cx),
        };
        let nav = div()
            .w(px(228.))
            .flex_none()
            .pt(px(24.))
            .px(px(10.))
            .pb(px(20.))
            .bg(theme.bg1)
            .border_r_1()
            .border_color(theme.line)
            .flex()
            .flex_col()
            .gap(px(1.))
            .child(div().px(px(10.)).pb(px(8.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).one_line().child(server.entry.name.clone()))
            .children(sections.into_iter().map(|(id, label, icon_name)| {
                let active = self.section == id;
                let danger = id == "leave" || id == "delete";
                let color = if danger { theme.red } else if active { theme.text1 } else { theme.text2 };
                div()
                    .id(id)
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(10.))
                    .py(px(7.))
                    .rounded(RADIUS_M)
                    .text_size(px(14.))
                    .text_color(color)
                    .when(active, |el| el.bg(theme.bg3))
                    .when(!active, |el| el.hover(move |style| style.bg(if danger { theme.red_soft } else { theme.hover })))
                    .cursor_pointer()
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.section = id.to_string();
                        if id == "reports" {
                            view.reports = None;
                            view.load_reports(cx);
                        }
                        if id == "bans" {
                            view.bans = None;
                            view.load_bans(cx);
                        }
                        cx.notify();
                    }))
                    .child(icon(icon_name, 17., color))
                    .child(label.to_string())
            }));
        let confirm = self.ban_confirm(cx).or_else(|| self.delete_confirm(&server.entry.name, cx));
        div()
            .id("server-settings-layer")
            .relative()
            .size_full()
            .flex()
            .bg(theme.bg_chat)
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    view.escape(cx);
                }
            }))
            .child(nav)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .child({
                        let handle = scroll_handle("server-settings-content");
                        div().id("server-settings-content").size_full().overflow_y_scroll().track_scroll(&handle).pr(gutter(&handle)).child(div().w(px(580.)).max_w_full().mx_auto().pt(px(32.)).px(px(28.)).pb(px(56.)).flex().flex_col().gap(px(14.)).children(page)).child(scrollbar("server-settings-content", Scrolls::Div(handle.clone())))
                    })
                    .child(div().absolute().right(px(16.)).top(px(16.)).child(icon_button("close-server-settings", "x", 19., false, false, cx).on_click(cx.listener(|view, _, _, cx| view.close(cx))))),
            )
            .children(confirm)
            .into_any_element()
    }
}
