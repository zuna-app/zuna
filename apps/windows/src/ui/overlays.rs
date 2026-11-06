//! Dialogs over the app: joining another server, a new group, invites, verifying
//! someone and leaving a server (packages/ui/src/features/overlays/Overlays.tsx).

use std::collections::BTreeSet;

use gpui::{AnyElement, AnyView, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::onboarding::Onboarding;
use super::text_input::{InputEvent, TextInput};
use crate::models::{SafetyCheck, from_value};
use crate::state::{AppState, Overlay, ToastKind};
use crate::theme::{self, RADIUS_L, RADIUS_M, RADIUS_XL};

pub fn open(overlay: &Overlay, state: Entity<AppState>, window: &mut Window, cx: &mut gpui::App) -> Option<AnyView> {
    Some(match overlay.clone() {
        Overlay::AddServer { link, sign_in_url } => {
            let flow = cx.new(|cx| Onboarding::embedded(state.clone(), link, sign_in_url, window, cx));
            cx.new(|cx| Dialog::new(state, DialogKind::AddServer(flow), window, cx)).into()
        }
        Overlay::NewGroup => cx.new(|cx| Dialog::new(state, DialogKind::NewGroup, window, cx)).into(),
        Overlay::Invite => cx.new(|cx| Dialog::new(state, DialogKind::Invite, window, cx)).into(),
        Overlay::Verify { user_id } => cx.new(|cx| Dialog::new(state, DialogKind::Verify(user_id), window, cx)).into(),
        Overlay::LeaveServer => cx.new(|cx| Dialog::new(state, DialogKind::LeaveServer, window, cx)).into(),
        Overlay::Settings { .. } => return None,
    })
}

enum DialogKind {
    AddServer(Entity<Onboarding>),
    NewGroup,
    Invite,
    Verify(String),
    LeaveServer,
}

pub struct Dialog {
    state: Entity<AppState>,
    kind: DialogKind,
    name: Entity<TextInput>,
    people_search: Entity<TextInput>,
    selected: BTreeSet<String>,
    history: bool,
    check: Option<SafetyCheck>,
    invite_link: Option<String>,
    busy: bool,
    focused: Option<usize>,
    _subscriptions: Vec<Subscription>,
}

impl Dialog {
    fn new(state: Entity<AppState>, kind: DialogKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| TextInput::new(cx, "Weekend trip"));
        let people_search = cx.new(|cx| TextInput::new(cx, "Search people"));
        let mut subscriptions = vec![cx.observe(&state, |_, _, cx| cx.notify())];
        for (index, input) in [&name, &people_search].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(input, window, move |view, _, event, _, cx| {
                match event {
                    InputEvent::Focused => view.focused = Some(index),
                    InputEvent::Blurred if view.focused == Some(index) => view.focused = None,
                    InputEvent::Escape => view.close(cx),
                    _ => {}
                }
                cx.notify();
            }));
        }
        if let DialogKind::AddServer(flow) = &kind {
            subscriptions.push(cx.observe(flow, |_, _, cx| cx.notify()));
        }
        if matches!(kind, DialogKind::NewGroup) {
            name.read(cx).focus(window);
        }
        let mut dialog = Dialog { state, kind, name, people_search, selected: BTreeSet::new(), history: false, check: None, invite_link: None, busy: false, focused: None, _subscriptions: subscriptions };
        if let DialogKind::Verify(user_id) = &dialog.kind {
            let user_id = user_id.clone();
            dialog.load_check(user_id, cx);
        }
        dialog
    }

    fn load_check(&mut self, user_id: String, cx: &mut Context<Self>) {
        let call = {
            let state = self.state.read(cx);
            state.active_server.clone().map(|server| state.core.call(Some(&server), "safetyCheck", vec![json!(user_id)]))
        };
        let Some(call) = call else { return };
        cx.spawn(async move |dialog, cx| {
            if let Ok(value) = call.await {
                dialog
                    .update(cx, |dialog, cx| {
                        dialog.check = if value.is_null() { None } else { Some(from_value(value)) };
                        cx.notify();
                    })
                    .ok();
            }
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }

    /// A modal card with a title and close button, as `Modal` draws it.
    fn modal(&self, title: Option<String>, width: f32, body: Vec<AnyElement>, footer: Option<AnyElement>, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let mut card = div()
            .id("modal")
            .w_full()
            .max_w(px(width))
            .max_h_full()
            .flex()
            .flex_col()
            .bg(theme.bg1)
            .border_1()
            .border_color(theme.line_strong)
            .rounded(RADIUS_XL)
            .shadow(shadow_l())
            .overflow_hidden()
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation());
        match title {
            Some(title) => {
                card = card
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .pt(px(16.))
                            .pr(px(16.))
                            .pb(px(4.))
                            .pl(px(20.))
                            .child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child(title))
                            .child(icon_button("close-modal", "x", 16., true, false, cx).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx)))),
                    )
                    .child(div().id("modal-body").overflow_y_scroll().px(px(20.)).pt(px(10.)).pb(px(20.)).flex().flex_col().gap(px(14.)).children(body));
                if let Some(footer) = footer {
                    card = card.child(div().flex().justify_end().gap(px(8.)).px(px(20.)).pb(px(16.)).child(footer));
                }
            }
            None => {
                card = card.child(
                    div()
                        .relative()
                        .id("modal-flow")
                        .p(px(24.))
                        .overflow_y_scroll()
                        .child(div().absolute().right(px(10.)).top(px(10.)).child(icon_button("close-modal", "x", 17., true, false, cx).on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx)))))
                        .children(body),
                );
            }
        }
        div()
            .id("modal-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::black_a(0.6)))
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|dialog, _, _, cx| dialog.close(cx)))
            .on_key_down(cx.listener(|dialog, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    dialog.close(cx);
                }
            }))
            .child(card)
            .into_any_element()
    }

    fn new_group(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let query = self.people_search.read(cx).text().trim().to_lowercase();
        let mut users: Vec<_> = server.users.values().filter(|user| user.id != server.self_id() && !user.banned).cloned().collect();
        users.sort_by_key(|user| user.display_name.to_lowercase());
        let filtered: Vec<_> = users.into_iter().filter(|user| query.is_empty() || user.display_name.to_lowercase().contains(&query) || user.username.to_lowercase().contains(&query)).collect();
        let mut people = div().id("people-list").max_h(px(260.)).overflow_y_scroll().flex().flex_col().gap(px(1.)).mx(px(-4.));
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
                div()
                    .id(SharedString::from(format!("person-{}", user.id)))
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
                    .child(div().flex_1().min_w_0().flex().flex_col().child(div().one_line().font_weight(FontWeight::SEMIBOLD).child(user.display_name.clone())).child(div().text_size(px(12.)).text_color(theme.text3).child(format!("@{}", user.username))))
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
                .child(people)
                .into_any_element(),
            div()
                .flex()
                .items_center()
                .gap(px(16.))
                .py(px(10.))
                .child(
                    div()
                        .flex_1()
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
                    .when(!name.is_empty() && !busy, |el| {
                        el.on_click(cx.listener(move |dialog, _, _, cx| {
                            dialog.busy = true;
                            let members: Vec<String> = dialog.selected.iter().cloned().collect();
                            let name = name.clone();
                            let history = dialog.history;
                            dialog.state.update(cx, |state, cx| {
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
                        }))
                    }),
            )
            .into_any_element();
        self.modal(Some("New group".into()), 440., body, Some(footer), cx)
    }

    fn invite(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let can_manage = server.me.as_ref().is_some_and(|me| me.role != "member") || server.info.as_ref().is_some_and(|info| info.allow_member_invites);
        let mut body = vec![div()
            .text_size(px(13.5))
            .text_color(theme.text2)
            .child("Anyone with a link can create an account here. It also holds the key that protects member profiles, so only share it with people you trust.")
            .into_any_element()];
        if !can_manage {
            body.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg2)
                    .text_size(px(13.))
                    .text_color(theme.text2)
                    .child(icon("link", 15., theme.text2))
                    .child("On this server, only admins can create invite links. Ask one of them for a link.")
                    .into_any_element(),
            );
        } else {
            let busy = self.busy;
            body.push(
                button("create-invite", ButtonKind::Primary, ButtonSize::Normal, busy, cx)
                    .child(icon("link", 15., theme.on_accent))
                    .child("Create invite link")
                    .when(!busy, |el| {
                        el.on_click(cx.listener(|dialog, _, _, cx| {
                            dialog.busy = true;
                            let call = {
                                let state = dialog.state.read(cx);
                                state.active_server.clone().map(|server| state.core.call(Some(&server), "createInvite", vec![json!(0), json!(7 * 86400)]))
                            };
                            let Some(call) = call else { return };
                            let state = dialog.state.clone();
                            cx.spawn(async move |dialog, cx| {
                                let result = call.await;
                                dialog
                                    .update(cx, |dialog, cx| {
                                        dialog.busy = false;
                                        match result {
                                            Ok(value) => {
                                                let link = value.as_str().unwrap_or_default().to_string();
                                                cx.write_to_clipboard(gpui::ClipboardItem::new_string(link.clone()));
                                                state.update(cx, |state, cx| state.toast("Invite link copied", ToastKind::Info, cx));
                                                dialog.invite_link = Some(link);
                                            }
                                            Err(error) => state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                                        }
                                        cx.notify();
                                    })
                                    .ok();
                            })
                            .detach();
                        }))
                    })
                    .into_any_element(),
            );
            if let Some(link) = self.invite_link.clone() {
                let copy = link.clone();
                let state = self.state.clone();
                body.push(
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
                        .child(div().flex_1().min_w_0().one_line().font_family(theme::FONT_MONO).child(link))
                        .child(icon_button("copy-invite", "copy", 14., true, false, cx).on_click(move |_, _, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy.clone()));
                            state.update(cx, |state, cx| state.toast("Invite link copied", ToastKind::Info, cx));
                        }))
                        .into_any_element(),
                );
            }
        }
        self.modal(Some("Invite people".into()), 440., body, None, cx)
    }

    fn verify(&mut self, user_id: String, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let Some(user) = server.users.get(&user_id).cloned() else { return div().into_any_element() };
        let is_self = user_id == server.self_id();
        let trust = self.check.as_ref().map(|check| check.trust.clone()).unwrap_or(user.trust.clone());
        let title = if is_self { "Your security key".to_string() } else { format!("Verify {} (@{})", user.display_name, user.username) };
        let notice = |icon_name: &str, color: gpui::Hsla, bg: gpui::Hsla, text_color: gpui::Hsla, text: String| {
            div().flex().gap(px(10.)).px(px(12.)).py(px(10.)).rounded(RADIUS_M).bg(bg).text_size(px(13.)).text_color(text_color).child(icon(icon_name, 16., color)).child(div().flex_1().min_w_0().child(text)).into_any_element()
        };
        let mut body = Vec::new();
        match trust.as_str() {
            "changed" => body.push(notice(
                "shield-alert",
                theme.red,
                theme.red_soft,
                theme::color(theme::hex(0xf4bcbe)),
                format!("{}'s security key changed in a way that doesn't follow from the one before, so this may mean someone is intercepting your messages. Only continue after comparing these emoji with them directly.", user.display_name),
            )),
            "verified" => body.push(notice("shield-check", theme.text2, theme.bg2, theme.text2, format!("You've verified {}. Nobody can quietly get between you.", user.display_name))),
            _ if !is_self => body.push(
                div()
                    .text_size(px(13.5))
                    .text_color(theme.text2)
                    .child(format!("Compare these emoji with {} in person or on a call. If they match exactly, nobody, including this server, is reading your conversation.", user.display_name))
                    .into_any_element(),
            ),
            _ => {}
        }
        let emoji = self.check.as_ref().map(|check| check.emoji.clone()).unwrap_or_default();
        body.push(
            div()
                .grid()
                .grid_cols(4)
                .gap(px(6.))
                .p(px(12.))
                .rounded(RADIUS_L)
                .bg(theme.bg2)
                .children(emoji.into_iter().map(|item| {
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(2.))
                        .px(px(2.))
                        .py(px(6.))
                        .child(div().text_size(px(30.)).line_height(gpui::relative(1.1)).child(item.emoji))
                        .child(div().text_size(px(11.)).text_color(theme.text2).text_center().child(item.name))
                }))
                .into_any_element(),
        );
        if !is_self {
            let state = self.state.clone();
            let id = user_id.clone();
            let name = user.display_name.clone();
            if trust == "verified" {
                body.push(
                    button("clear-verification", ButtonKind::Default, ButtonSize::Normal, false, cx)
                        .w_full()
                        .child("Remove verification")
                        .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("clearVerification", vec![json!(id)], cx)))
                        .into_any_element(),
                );
            } else {
                let covers = self.check.as_ref().map(|check| check.covers.clone());
                let dismiss_state = self.state.clone();
                body.push(
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(button("no-match", ButtonKind::Default, ButtonSize::Normal, false, cx).flex_1().child(icon("triangle-alert", 15., theme.text1)).child("They don't match").on_click(move |_, _, cx| {
                            dismiss_state.update(cx, |state, cx| {
                                state.toast("Don't share anything private with them until you know why the emoji differ.", ToastKind::Security, cx);
                                state.set_overlay(None, cx);
                            })
                        }))
                        .child(
                            button("match", ButtonKind::Primary, ButtonSize::Normal, covers.is_none(), cx)
                                .flex_1()
                                .child(icon("badge-check", 16., theme.on_accent))
                                .child("They match")
                                .when_some(covers, |el, covers| {
                                    el.on_click(move |_, _, cx| {
                                        let (id, covers, name) = (id.clone(), covers.clone(), name.clone());
                                        state.update(cx, |state, cx| {
                                            let server = state.active_server.clone();
                                            state.call(server.as_deref(), "markVerified", vec![json!(id), json!(covers)], cx, move |state, result, cx| match result {
                                                Ok(_) => {
                                                    state.toast(format!("{name} is verified"), ToastKind::Info, cx);
                                                    state.set_overlay(None, cx);
                                                }
                                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                            })
                                        })
                                    })
                                }),
                        )
                        .into_any_element(),
                );
            }
        }
        self.modal(Some(title), 460., body, None, cx)
    }

    fn leave_server(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let Some(server) = self.state.read(cx).active().cloned() else { return div().into_any_element() };
        let id = server.entry.id.clone();
        let body = vec![div()
            .text_size(px(13.5))
            .text_color(theme.text2)
            .child(format!("This signs this device out of {} and removes its messages from this device. Your account stays, and you can sign in again later.", server.entry.name))
            .into_any_element()];
        let state = self.state.clone();
        let footer = div()
            .flex()
            .gap(px(8.))
            .child(button("cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|dialog, _, _, cx| dialog.close(cx))))
            .child(button("leave", ButtonKind::Danger, ButtonSize::Normal, false, cx).child("Leave this server").on_click(move |_, _, cx| {
                let id = id.clone();
                state.update(cx, |state, cx| state.call(None, "leaveServer", vec![json!(id.clone())], cx, move |state, _, cx| state.remove_server(&id, cx)))
            }))
            .into_any_element();
        self.modal(Some(format!("Leave {}?", server.entry.name)), 440., body, Some(footer), cx)
    }
}

impl Render for Dialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match &self.kind {
            DialogKind::AddServer(flow) => {
                let flow = flow.clone();
                self.modal(None, 420., vec![flow.into_any_element()], None, cx)
            }
            DialogKind::NewGroup => self.new_group(cx),
            DialogKind::Invite => self.invite(cx),
            DialogKind::Verify(user_id) => {
                let user_id = user_id.clone();
                self.verify(user_id, cx)
            }
            DialogKind::LeaveServer => self.leave_server(cx),
        }
    }
}
