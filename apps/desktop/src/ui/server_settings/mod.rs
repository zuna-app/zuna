//! A server's settings, for its admins, and signing out of it
//! (packages/ui/src/features/overlays/ServerSettings.tsx).

mod general;
mod members;
mod account;
mod bots;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, img, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::invites::InvitePanel;
use super::menu::{MenuEntry, open_menu};
use super::text_input::{InputEvent, TabScope, TextInput};
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
    bots: Option<Entity<bots::ServerBots>>,
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
            bots: None,
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

    /// Escape says no to a ban, or to deleting a bot or the account, being asked about, and otherwise closes the settings.
    fn escape(&mut self, cx: &mut Context<Self>) {
        if self.bots.as_ref().is_some_and(|bots| bots.update(cx, |bots, cx| bots.cancel_delete(cx))) {
            return;
        }
        if self.banning.is_some() || self.deleting {
            self.banning = None;
            self.deleting = false;
            cx.notify();
        } else {
            self.close(cx);
        }
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
        // Bots are there for admins, for members where the server lets them make bots, and for whoever has one.
        let has_bots = is_admin || server.info.as_ref().is_some_and(|info| info.allow_member_bots) || server.users.values().any(|user| !user.deleted && user.bot.as_ref().is_some_and(|bot| bot.owner_id == server.self_id()));
        if has_bots {
            sections.push(("bots", "Bots", "bot"));
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
            "bots" if has_bots => {
                let state = self.state.clone();
                let page = match &self.bots {
                    Some(page) => page.clone(),
                    None => {
                        let page = cx.new(|cx| bots::ServerBots::new(state, cx));
                        // Its question before a bot is deleted is drawn here, over everything.
                        self._subscriptions.push(cx.observe(&page, |_, _, cx| cx.notify()));
                        self.bots = Some(page.clone());
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
        let confirm = self.ban_confirm(cx).or_else(|| self.delete_confirm(&server.entry.name, cx)).or_else(|| self.bots.clone().and_then(|bots| bots.update(cx, |bots, cx| bots.delete_confirm(cx))));
        div()
            .id("server-settings-layer")
            .relative()
            .size_full()
            .flex()
            .bg(theme.bg_chat)
            .occlude()
            .track_focus(&self.focus)
            .tab_scope(&self.focus)
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
