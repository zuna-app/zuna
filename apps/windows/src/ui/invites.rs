//! Making invite links, and the ones still open (InvitePanel in Overlays.tsx).

use std::rc::Rc;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Window, div, prelude::*, px};
use serde::Deserialize;
use serde_json::json;

use super::components::*;
use crate::state::{AppState, ToastKind};
use crate::theme::{FONT_MONO, RADIUS_M};

const EXPIRY: [(&str, f64); 4] = [("1 day", 86_400.), ("7 days", 604_800.), ("30 days", 2_592_000.), ("Never", 0.)];
const USES: [(&str, f64); 4] = [("1 use", 1.), ("5 uses", 5.), ("25 uses", 25.), ("No limit", 0.)];

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(default)]
struct Invite {
    code: String,
    max_uses: f64,
    uses: f64,
    expires_at: Option<f64>,
}

pub struct InvitePanel {
    state: Entity<AppState>,
    expiry: f64,
    uses: f64,
    link: Option<String>,
    invites: Option<Vec<Invite>>,
    busy: bool,
}

impl InvitePanel {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        let mut panel = InvitePanel { state, expiry: EXPIRY[1].1, uses: USES[3].1, link: None, invites: None, busy: false };
        panel.refresh(cx);
        panel
    }

    fn can_manage(&self, cx: &gpui::App) -> bool {
        self.state.read(cx).active().is_some_and(|server| server.me.as_ref().is_some_and(|me| me.role != "member") || server.info.as_ref().is_some_and(|info| info.allow_member_invites))
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.can_manage(cx) {
            return;
        }
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "invites", vec![]);
        cx.spawn(async move |panel, cx| {
            let found: Vec<Invite> = call.await.ok().and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
            panel
                .update(cx, |panel, cx| {
                    panel.invites = Some(found);
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    fn copy(&self, link: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
        self.state.update(cx, |state, cx| state.toast("Invite link copied", ToastKind::Info, cx));
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "createInvite", vec![json!(self.uses), json!(self.expiry)]);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |panel, cx| {
            let result = call.await;
            panel
                .update(cx, |panel, cx| {
                    panel.busy = false;
                    match result {
                        Ok(value) => {
                            let link = value.as_str().unwrap_or_default().to_string();
                            panel.copy(link.clone(), cx);
                            panel.link = Some(link);
                            panel.refresh(cx);
                        }
                        Err(error) => panel.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                    }
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }

    fn act(&mut self, method: &'static str, code: String, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), method, vec![json!(code)]);
        cx.spawn(async move |panel, cx| {
            let result = call.await;
            panel
                .update(cx, |panel, cx| match result {
                    Ok(value) if method == "linkForInvite" => panel.copy(value.as_str().unwrap_or_default().to_string(), cx),
                    Ok(_) => panel.refresh(cx),
                    Err(error) => panel.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                })
                .ok();
        })
        .detach();
    }
}

impl Render for InvitePanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        if !self.can_manage(cx) {
            return notice("link", "On this server, only admins can create invite links. Ask one of them for a link.", cx).into_any_element();
        }
        let weak = cx.entity().downgrade();
        let choice = |label: &str, value: f64, uses: bool| -> (String, Rc<dyn Fn(&mut Window, &mut gpui::App)>) {
            let weak = weak.clone();
            (
                label.to_string(),
                Rc::new(move |_, cx| {
                    weak.update(cx, |panel, cx| {
                        if uses {
                            panel.uses = value;
                        } else {
                            panel.expiry = value;
                        }
                        cx.notify();
                    })
                    .ok();
                }),
            )
        };
        let expiry_label = EXPIRY.iter().find(|(_, seconds)| *seconds == self.expiry).map(|(label, _)| *label).unwrap_or("");
        let uses_label = USES.iter().find(|(_, value)| *value == self.uses).map(|(label, _)| *label).unwrap_or("");
        let labeled = |label: &str, control: AnyElement| {
            div().flex_1().flex().flex_col().gap(px(5.)).child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(label.to_string())).child(control)
        };
        let mut column = div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(labeled("Expires after", select_box("invite-expiry", expiry_label, EXPIRY.iter().map(|(label, seconds)| choice(label, *seconds, false)).collect(), cx).into_any_element()))
                    .child(labeled("Can be used", select_box("invite-uses", uses_label, USES.iter().map(|(label, value)| choice(label, *value, true)).collect(), cx).into_any_element())),
            )
            .child(
                button("create-invite", ButtonKind::Primary, ButtonSize::Normal, self.busy, cx)
                    .justify_center()
                    .child(icon("link", 15., theme.on_accent))
                    .child(if self.busy { "Creating…" } else { "Create invite link" })
                    .when(!self.busy, |el| el.on_click(cx.listener(|panel, _, _, cx| panel.create(cx)))),
            );
        if let Some(link) = self.link.clone() {
            let copied = link.clone();
            column = column.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .pl(px(11.))
                    .pr(px(6.))
                    .py(px(6.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg2)
                    .border_1()
                    .border_color(theme.line)
                    .text_size(px(12.))
                    .child(div().flex_1().min_w_0().one_line().font_family(FONT_MONO).child(link))
                    .child(icon_button("copy-invite", "copy", 14., true, false, cx).on_click(cx.listener(move |panel, _, _, cx| panel.copy(copied.clone(), cx)))),
            );
        }
        if let Some(invites) = self.invites.clone().filter(|invites| !invites.is_empty()) {
            let mut list = div().flex().flex_col().gap(px(3.));
            for invite in invites {
                let mut detail = format!("{} used", invite.uses as u64);
                if invite.max_uses > 0. {
                    detail.push_str(&format!(" of {}", invite.max_uses as u64));
                }
                if let Some(expires) = invite.expires_at {
                    let at = if expires < 1e12 { expires * 1000. } else { expires };
                    let when = if crate::format::same_day(at, crate::format::now_ms()) {
                        crate::format::format_time(at)
                    } else {
                        format!("{}, {}", chrono::DateTime::from_timestamp_millis(at as i64).map(|t| t.with_timezone(&chrono::Local).format("%b %-d").to_string()).unwrap_or_default(), crate::format::format_time(at))
                    };
                    detail.push_str(&format!(" · expires {when}"));
                }
                let (copy_code, revoke_code) = (invite.code.clone(), invite.code.clone());
                list = list.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .pl(px(11.))
                        .pr(px(6.))
                        .py(px(6.))
                        .rounded(RADIUS_M)
                        .bg(theme.bg2)
                        .child(div().flex_1().min_w_0().flex().flex_col().child(div().font_family(FONT_MONO).text_size(px(12.5)).child(invite.code.clone())).child(div().text_size(px(11.5)).text_color(theme.text3).child(detail)))
                        .child(icon_button(SharedString::from(format!("copy-{}", invite.code)), "copy", 14., true, false, cx).on_click(cx.listener(move |panel, _, _, cx| panel.act("linkForInvite", copy_code.clone(), cx))))
                        .child(icon_button(SharedString::from(format!("revoke-{}", invite.code)), "trash", 14., true, false, cx).on_click(cx.listener(move |panel, _, _, cx| panel.act("revokeInvite", revoke_code.clone(), cx)))),
                );
            }
            column = column.child(div().flex().flex_col().gap(px(5.)).child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Active links")).child(list));
        }
        column.into_any_element()
    }
}
