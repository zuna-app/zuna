//! The window's interface, laid out as the desktop's (packages/ui).

pub mod channel_message;
pub mod chat;
pub mod components;
pub mod conversations;
pub mod image_viewer;
pub mod menu;
pub mod motion;
// The cards are Windows's. On Linux the system's notifications take their place, with the same calls.
#[cfg(windows)]
pub mod notifications;
#[cfg(target_os = "linux")]
pub use crate::platform::notifications;
pub mod message;
pub mod onboarding;
pub mod overlays;
pub mod invites;
pub mod media_views;
pub mod picker;
pub mod screen_picker;
pub mod selection;
pub mod scrollbar;
pub mod server_settings;
pub mod server_voice;
pub mod settings;
pub mod shared_media;
pub mod side_panel;
pub mod soundboard;
pub mod stream_stats;
pub mod text_input;
pub mod voice;
pub mod voice_settings;
pub mod voice_stage;

use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement, Render, Styled,
    Window, WindowControlArea, div, prelude::*, px,
};

use crate::state::{AppState, Phase, ToastKind};

gpui::actions!(shell, [FocusSearch, NextConversation, PreviousConversation]);

/// Ctrl+K jumps to search, and Alt+Up and Alt+Down move through conversations, as on the desktop.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        gpui::KeyBinding::new("ctrl-k", FocusSearch, None),
        gpui::KeyBinding::new("alt-down", NextConversation, None),
        gpui::KeyBinding::new("alt-up", PreviousConversation, None),
    ]);
}
use crate::theme::{self, RAIL_WIDTH, RADIUS_L, RADIUS_M, TITLEBAR_HEIGHT};
use components::*;
use motion::{Enter, Motion};

/// Where the project lives (lib/links.ts).
pub const PROJECT_URL: &str = "https://github.com/SocketByte/zuna-chat";

/// The terms of use everyone agrees to when they create an account.
pub const TERMS_URL: &str = "https://zuna.chat/terms/";

/// How long a closed dialog takes to fade away.
const DIALOG_OUT: std::time::Duration = std::time::Duration::from_millis(150);
/// How long settings take to go once closed.
const SETTINGS_OUT: std::time::Duration = std::time::Duration::from_millis(170);
/// How long a dismissed toast takes to go.
const TOAST_OUT: std::time::Duration = std::time::Duration::from_millis(160);

pub struct Root {
    state: Entity<AppState>,
    onboarding: Entity<onboarding::Onboarding>,
    conversations: Entity<conversations::ConversationList>,
    chat: Option<(String, Entity<chat::ChatView>)>,
    /// A voice channel's stage, while this device is in the channel that's open.
    stage: Option<(String, Entity<voice_stage::VoiceStage>)>,
    voice: Entity<crate::voice::Voice>,
    /// Settings, or a server's settings, over everything below the title bar, and which.
    settings: Option<(crate::state::Overlay, gpui::AnyView)>,
    overlay: Option<(crate::state::Overlay, gpui::AnyView)>,
    /// A dialog that's closed, fading out over `DIALOG_OUT`.
    closing: Option<(gpui::AnyView, std::time::Instant)>,
    /// Settings just closed, sinking as they fade over `SETTINGS_OUT`.
    settings_closing: Option<(gpui::AnyView, std::time::Instant)>,
    /// The toasts drawn, with when each was dismissed, which goes over `TOAST_OUT`.
    toast_list: Vec<(crate::state::Toast, Option<std::time::Instant>)>,
    /// The server in the rail under the pointer, whose pill grows and icon brightens.
    rail_hovered: Option<String>,
    resizing: Option<(f32, f32)>,
    menu: Entity<menu::MenuLayer>,
    picker: Entity<picker::PickerLayer>,
    focus: gpui::FocusHandle,
    /// Whether a dialog or settings was open last frame, to give focus back when they close.
    covered: bool,
}

impl Root {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        let onboarding = cx.new(|cx| onboarding::Onboarding::new(state.clone(), None, window, cx));
        let conversations = cx.new(|cx| conversations::ConversationList::new(state.clone(), window, cx));
        let menu = menu::menu_layer(cx);
        cx.observe(&menu, |_, _, cx| cx.notify()).detach();
        // Whether the window opened in front: one that didn't, as when Windows keeps another app's
        // window there, would otherwise count as focused, and its person as online, until it was.
        let focused = window.is_window_active();
        state.update(cx, |state, _| state.window_focused = focused);
        let activation_state = state.clone();
        cx.observe_window_activation(window, move |root, window, cx| {
            let active = window.is_window_active();
            activation_state.update(cx, |state, cx| {
                state.window_focused = active;
                cx.notify();
            });
            if active {
                root.refocus_composer(window, cx);
            }
        })
        .detach();
        let picker = picker::picker_layer(window, cx);
        cx.observe(&picker, |_, _, cx| cx.notify()).detach();
        // The compositor says whether it draws the title bar as it shows the window, and may
        // change its mind.
        cx.observe_window_appearance(window, |_, _, cx| cx.notify()).detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let voice = crate::voice::get(cx).expect("voice starts with the app");
        cx.observe(&voice, |_, _, cx| cx.notify()).detach();
        // Ahead of the fields' own bindings, so Ctrl+C copies selected message text from the message box.
        let root = cx.entity().downgrade();
        cx.intercept_keystrokes(move |event, window, cx| {
            root.update(cx, |root, cx| root.key_with_selection(&event.keystroke, window, cx)).ok();
        })
        .detach();
        Root { state, onboarding, conversations, chat: None, stage: None, voice, settings: None, overlay: None, closing: None, settings_closing: None, toast_list: Vec::new(), rail_hovered: None, resizing: None, menu, picker, focus, covered: false }
    }

    fn title_bar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let status = self.state.read(cx).active().and_then(|server| connection_status(server, &theme));
        let control = |id: &'static str, icon_name: &'static str, area: WindowControlArea, close: bool| {
            let button = div()
                .id(id)
                .flex()
                .items_center()
                .justify_center()
                .w(px(46.))
                .h_full()
                .window_control_area(area)
                .text_color(theme::color(theme::hex(0xa0a0a6)))
                .hover(move |style| {
                    if close { style.bg(theme::color(theme::hex(0xc42b1c))).text_color(gpui::white()) } else { style.bg(theme::color(theme::white_a(0.09))) }
                })
                .child(gpui::svg().path(format!("icons/{icon_name}.svg")).size(px(10.)).text_color(theme::color(theme::hex(0xa0a0a6))));
            // Wayland leaves the buttons to the app.
            #[cfg(target_os = "linux")]
            let button = crate::platform::title_button(button, area);
            button
        };
        let drag = div()
            .id("titlebar-drag")
            .flex()
            .flex_1()
            .h_full()
            .items_center()
            .gap(px(8.))
            .window_control_area(WindowControlArea::Drag)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text2)
                    .child(logo(14.))
                    .child("Zuna"),
            )
            .children(status);
        // Wayland leaves dragging to the app.
        #[cfg(target_os = "linux")]
        let drag = crate::platform::title_drag(drag);
        // Covers the root, whose focus tracking would otherwise take each press here and leave
        // Windows nothing to drag, minimize, maximize or close with.
        div()
            .id("titlebar")
            .occlude()
            .flex()
            .flex_none()
            .items_center()
            .h(TITLEBAR_HEIGHT)
            .pl(px(12.))
            .gap(px(8.))
            .bg(theme.bg0)
            .border_b_1()
            .border_color(theme.line)
            .text_size(px(12.))
            .text_color(theme.text3)
            .child(drag)
            .child(
                div()
                    .flex()
                    .h_full()
                    .child(control("win-min", "win-minimize", WindowControlArea::Min, false))
                    .child(control("win-max", if window.is_maximized() { "win-restore" } else { "win-maximize" }, WindowControlArea::Max, false))
                    .child(control("win-close", "win-close", WindowControlArea::Close, true)),
            )
    }

    fn rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let state_entity = self.state.clone();
        let state = self.state.read(cx);
        let active_id = state.active_server.clone();
        let servers: Vec<_> = state.order.iter().filter_map(|id| state.servers.get(id)).cloned().collect();
        let me = state.active().and_then(|server| server.me.as_ref().and_then(|me| server.users.get(&me.user_id)).cloned());
        let mut list = div().flex().flex_col().items_center().gap(px(8.)).w_full();
        for server in servers {
            let id = server.entry.id.clone();
            let active = active_id.as_deref() == Some(id.as_str());
            let unread = server.unread();
            let has_new = server.has_new();
            let icon_image = if server.entry.has_icon {
                let url = format!("{}/api/icon", server.entry.url);
                self.state.update(cx, |state, cx| state.remote_picture(&url, cx))
            } else {
                None
            };
            let group = gpui::SharedString::from(format!("rail-{id}"));
            let hovered = self.rail_hovered.as_deref() == Some(id.as_str());
            let pill_height = if active { 28. } else if hovered { 18. } else if has_new { 8. } else { 0. };
            let hover_id = id.clone();
            let select_state = state_entity.clone();
            let select_id = id.clone();
            list = list.child(
                div()
                    .id(gpui::ElementId::Name(format!("rail-item-{id}").into()))
                    .group(group.clone())
                    .relative()
                    .w_full()
                    .flex()
                    .justify_center()
                    .on_hover(cx.listener(move |root, over: &bool, _, cx| {
                        if *over {
                            root.rail_hovered = Some(hover_id.clone());
                        } else if root.rail_hovered.as_ref() == Some(&hover_id) {
                            root.rail_hovered = None;
                        }
                        cx.notify();
                    }))
                    // `.rail-pill`: its height moves over 120 ms.
                    .child(motion::transition(
                        div().absolute().left_0().w(px(3.)).rounded_r(px(3.)).bg(theme.text1),
                        format!("rail-pill-{id}"),
                        pill_height,
                        120,
                        motion::ease_out(),
                        |el, height| el.top(px(21. - height / 2.)).h(px(height)),
                    ))
                    .child(
                        div()
                            .id(gpui::ElementId::Name(format!("rail-button-{id}").into()))
                            .rounded(RADIUS_L)
                            .cursor_pointer()
                            .tip(server.entry.name.clone(), Side::Right)
                            .on_click(move |_, _, cx| select_state.update(cx, |state, cx| state.select_server(&select_id, cx)))
                            .child(avatar(
                                AvatarProps {
                                    name: server.entry.name.clone(),
                                    seed: server.entry.url.clone(),
                                    image: icon_image,
                                    size: 42.,
                                    online: false,
                                    rounded: true,
                                    dot_border: theme.bg0,
                                },
                                cx,
                            ))
                            // Inactive, it's at 72% until the pointer is on it, over 100 ms.
                            .map(|button| motion::transition(button, format!("rail-button-{id}"), if active || hovered { 1. } else { 0.72 }, 100, motion::ease(), |el, opacity| el.opacity(opacity))),
                    )
                    .when(!active && unread > 0, |el| {
                        el.child(
                            div()
                                .absolute()
                                .right(px(8.))
                                .bottom(px(-3.))
                                .min_w(px(16.))
                                .h(px(16.))
                                .px(px(4.))
                                .rounded(px(8.))
                                .bg(theme.accent)
                                .text_color(theme.on_accent)
                                .text_size(px(10.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .line_height(px(16.))
                                .flex()
                                .justify_center()
                                .border_2()
                                .border_color(theme.bg0)
                                .child(if unread > 99 { "99+".to_string() } else { unread.to_string() }),
                        )
                    }),
            );
        }
        let add_state = state_entity.clone();
        list = list.child(
            // `.rail-add`: background 0.1s.
            motion::track_hover(div().id("rail-add"), "rail-add".into())
                .relative()
                .size(px(42.))
                .rounded(RADIUS_L)
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.text3)
                .cursor_pointer()
                .child(motion::hover_layer("rail-add", theme.hover_strong, RADIUS_L, 100))
                .group("rail-add")
                .tip("Join a server", Side::Right)
                .on_click(move |_, _, cx| {
                    add_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::AddServer { link: None, sign_in_url: None }), cx))
                })
                .child(gpui::svg().path("icons/plus.svg").size(px(20.)).text_color(theme.text3).group_hover("rail-add", move |style| style.text_color(theme.text1))),
        );
        let settings_state = state_entity.clone();
        let profile_state = state_entity.clone();
        let mut footer = div().flex().flex_col().items_center().gap(px(8.)).pt(px(8.)).child(
            icon_button("rail-settings", "settings", 19., false, false, cx)
                .tip("Settings", Side::Right)
                .on_click(move |_, _, cx| settings_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section: None }), cx))),
        );
        if let Some(me) = me {
            let server_id = active_id.clone().unwrap_or_default();
            let image = me.avatar.as_ref().and_then(|avatar| self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx)));
            footer = footer.child(
                div()
                    .id("rail-self")
                    .rounded_full()
                    .cursor_pointer()
                    .tip(me.display_name.clone(), Side::Right)
                    .on_click(move |_, _, cx| {
                        profile_state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::Settings { section: Some("profile".into()) }), cx))
                    })
                    .child(avatar(
                        AvatarProps { name: me.display_name.clone(), seed: me.id.clone(), image, size: 32., online: false, rounded: false, dot_border: theme.bg0 },
                        cx,
                    )),
            );
        }
        div()
            .flex()
            .flex_col()
            .flex_none()
            .items_center()
            .w(RAIL_WIDTH)
            .py(px(10.))
            .gap(px(8.))
            .bg(theme.bg0)
            .border_r_1()
            .border_color(theme.line)
            .child(div().id("rail-list").flex_1().min_h_0().w_full().overflow_y_scroll().child(list))
            .child(footer)
    }

    fn main_area(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.read(cx);
        let Some(server) = state.active().cloned() else { return div().into_any_element() };
        if let Some(reason) = server.entry.signed_out.clone() {
            return self.signed_out(&server, &reason, cx).into_any_element();
        }
        let conversation = server.active_conversation().cloned();
        let channel = server.active_channel().cloned();
        // A voice channel this device is in shows its stage, as in Discord.
        let in_this_voice = channel.as_ref().is_some_and(|channel| channel.kind == "voice" && crate::voice::connected_channel(cx).is_some_and(|(server_id, channel_id)| server_id == server.entry.id && channel_id == channel.id));
        if let (true, Some(channel)) = (in_this_voice, &channel) {
            let key = format!("{}:{}", server.entry.id, channel.id);
            if self.stage.as_ref().map(|(current, _)| current != &key).unwrap_or(true) {
                let state = self.state.clone();
                let room = voice_stage::StageRoom { server_id: server.entry.id.clone(), id: channel.id.clone(), call: false };
                self.stage = Some((key, cx.new(|cx| voice_stage::VoiceStage::new(state, room, cx))));
            }
            return self.stage.as_ref().unwrap().1.clone().into_any_element();
        }
        self.stage = None;
        match conversation {
            Some(conversation) => {
                let key = format!("{}:{}", server.entry.id, conversation.key);
                if self.chat.as_ref().map(|(current, _)| current != &key).unwrap_or(true) {
                    let state = self.state.clone();
                    let view = cx.new(|cx| chat::ChatView::new(state, server.entry.id.clone(), conversation.key.clone(), window, cx));
                    self.chat = Some((key, view));
                }
                // Not cached: GPUI draws every cached view inside a cached view that has to be
                // drawn again, and this one is on every keystroke, so its message list is cached
                // instead.
                self.chat.as_ref().unwrap().1.clone().into_any_element()
            }
            None => {
                self.chat = None;
                if channel.is_some() {
                    return div()
                        .flex_1()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(div().flex().flex_col().items_center().gap(px(6.)).text_color(theme.text2).child(spinner(22., theme.text2)).child("Getting the keys to this channel…"))
                        .into_any_element();
                }
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(6.))
                            .p(px(30.))
                            .text_color(theme.text2)
                            .child(div().mb(px(8.)).child(icon("message-circle", 28., theme.text3)))
                            .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(server.entry.name.clone()))
                            .child("Pick someone from the list to start talking.")
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .mt(px(4.))
                                    .text_size(px(12.5))
                                    .text_color(theme.text3)
                                    .child(icon("lock", 12., theme.text3))
                                    .child("Everything here is end-to-end encrypted"),
                            ),
                    )
                    .into_any_element()
            }
        }
    }

    fn signed_out(&self, server: &crate::state::ServerState, reason: &str, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let name = server.entry.name.clone();
        let title = match reason {
            "banned" => format!("You were removed from {name}"),
            "account_deleted" => format!("Your account on {name} was deleted"),
            _ => format!("You're signed out of {name}"),
        };
        let why = match reason {
            "device_revoked" => "This device was removed from your account.",
            "banned" => "Its admins ended your access.",
            "account_deleted" => "It was deleted from another of your devices.",
            _ => "The server ended this device's session.",
        };
        // An account that's gone can't be signed in to again.
        let can_sign_in = reason != "banned" && reason != "account_deleted";
        let state = self.state.clone();
        let address = server.entry.address.clone();
        let remove_state = self.state.clone();
        let id = server.entry.id.clone();
        div().flex_1().flex().items_center().justify_center().child(
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .max_w(px(460.))
                .text_color(theme.text2)
                .text_center()
                .child(div().mb(px(8.)).child(icon("log-out", 28., theme.text3)))
                .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child(title))
                .child(if reason == "account_deleted" {
                    format!("{why} What's on this device stays here for 30 days, or until you remove it.")
                } else {
                    format!("{why} What's on this device stays here for 30 days, or until you sign in again or remove it.")
                })
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .mt(px(8.))
                        .when(can_sign_in, |el| {
                            el.child(button("sign-in-again", ButtonKind::Primary, ButtonSize::Normal, false, cx).child("Sign in again").on_click(move |_, _, cx| {
                                state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::AddServer { link: None, sign_in_url: Some(address.clone()) }), cx))
                            }))
                        })
                        .child(button("remove-server", ButtonKind::Default, ButtonSize::Normal, false, cx).child("Remove from this device").on_click(move |_, _, cx| {
                            let id = id.clone();
                            remove_state.update(cx, |state, cx| {
                                state.call(None, "leaveServer", vec![serde_json::json!(id.clone())], cx, move |state, _, cx| state.remove_server(&id, cx))
                            })
                        })),
                ),
        )
    }

    fn toasts(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let current = self.state.read(cx).toasts.clone();
        // A dismissed toast stays where it was while it sinks away, and new ones go below.
        let now = std::time::Instant::now();
        let out = if motion::reduced_or_system() { std::time::Duration::ZERO } else { TOAST_OUT };
        for (toast, gone) in &mut self.toast_list {
            if gone.is_none() && !current.iter().any(|shown| shown.id == toast.id) {
                *gone = Some(now);
            }
        }
        self.toast_list.retain(|(_, gone)| gone.is_none_or(|gone| now - gone < out));
        for toast in current {
            if !self.toast_list.iter().any(|(shown, _)| shown.id == toast.id) {
                self.toast_list.push((toast, None));
            }
        }
        if self.toast_list.iter().any(|(_, gone)| gone.is_some()) {
            window.request_animation_frame();
        }
        let toasts = self.toast_list.clone();
        div()
            .absolute()
            .bottom(px(20.))
            .left_0()
            .right_0()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .children(toasts.into_iter().map(|(toast, gone)| {
                let (bg, border) = match toast.kind {
                    ToastKind::Error => (theme::color(theme::hex(0x2f1f20)), theme::color(theme::rgba(242, 85, 90, 0.35))),
                    ToastKind::Security => (theme::color(theme::hex(0x2e2615)), theme::color(theme::rgba(229, 165, 10, 0.35))),
                    ToastKind::Info => (theme.bg4, theme.line_strong),
                };
                let state = self.state.clone();
                let id = toast.id;
                let toast_el = div()
                    .id(gpui::ElementId::Name(format!("toast-{id}").into()))
                    .max_w(px(480.))
                    .bg(bg)
                    .border_1()
                    .border_color(border)
                    .px(px(12.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .shadow(shadow_m())
                    .text_size(px(13.))
                    .text_color(theme.text1)
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.dismiss_toast(id, cx)))
                    .child(toast.message);
                match gone {
                    Some(gone) => {
                        let left = 1. - gone.elapsed().as_secs_f32() / TOAST_OUT.as_secs_f32();
                        toast_el.occlude().leave(Enter::Rise(10.), left).into_any_element()
                    }
                    None => toast_el.enter(gpui::ElementId::Name(format!("toast-in-{id}").into()), Enter::Rise(14.), 220).into_any_element(),
                }
            }))
    }

    fn overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let wanted = self.state.read(cx).overlay.clone();
        let Some(wanted) = wanted else {
            self.close_overlay();
            self.close_settings();
            return None;
        };
        if matches!(wanted, crate::state::Overlay::Settings { .. } | crate::state::Overlay::ServerSettings { .. }) {
            if self.settings.as_ref().map(|(shown, _)| shown != &wanted).unwrap_or(true) {
                let state = self.state.clone();
                let view: gpui::AnyView = match wanted.clone() {
                    crate::state::Overlay::Settings { section } => cx.new(|cx| settings::SettingsView::new(state, section, window, cx)).into(),
                    crate::state::Overlay::ServerSettings { section } => cx.new(|cx| server_settings::ServerSettings::new(state, section, window, cx)).into(),
                    _ => unreachable!(),
                };
                self.settings = Some((wanted.clone(), view));
                self.settings_closing = None;
            }
            return None;
        }
        self.close_settings();
        if self.overlay.as_ref().map(|(current, _)| current != &wanted).unwrap_or(true) {
            self.close_overlay();
            let view = overlays::open(&wanted, self.state.clone(), window, cx);
            self.overlay = view.map(|view| (wanted.clone(), view));
        }
        self.overlay.as_ref().map(|(_, view)| view.clone().into_any_element())
    }
}

impl Root {
    /// The dialog going away fades out, as `AnimatePresence` lets `Modal` do.
    fn close_overlay(&mut self) {
        if let Some((_, view)) = self.overlay.take() {
            if !motion::reduced_or_system() {
                self.closing = Some((view, std::time::Instant::now()));
            }
        }
    }

    /// Settings going away sink back as they fade, the way they rose in.
    fn close_settings(&mut self) {
        if let Some((_, view)) = self.settings.take() {
            if !motion::reduced_or_system() {
                self.settings_closing = Some((view, std::time::Instant::now()));
            }
        }
    }

    /// Whether the message box may take focus: no dialog, settings, menu or picker is open, and
    /// no other field has it (`focusComposer` and `onKeyDown` in lib/focus.ts).
    fn composer_may_focus(&self, window: &Window, cx: &App) -> bool {
        self.overlay.is_none() && self.settings.is_none() && !menu::is_open(cx) && !picker::is_open(cx) && !text_input::any_focused(window)
    }

    /// Gives the message box focus again once a click or the window coming back has settled,
    /// so it never needs clicking into.
    fn refocus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.defer_in(window, |root, window, cx| {
            if root.composer_may_focus(window, cx) {
                if let Some((_, chat)) = &root.chat {
                    chat.update(cx, |chat, cx| chat.focus_composer(window, cx));
                }
            }
        });
    }

    /// Keys while a message's text is selected, which the message box holds focus through:
    /// Ctrl+C copies it, as the desktop's browser does, and typing lets go of it, as typing
    /// there moves the browser's selection into the message box.
    fn key_with_selection(&mut self, keystroke: &gpui::Keystroke, window: &Window, cx: &mut Context<Self>) {
        let Some(text) = selection::text() else { return };
        // Any other field keeps its keys.
        let in_composer = self.chat.as_ref().is_some_and(|(_, chat)| chat.read(cx).composer_has_focus());
        if text_input::any_focused(window) && !in_composer {
            return;
        }
        let modifiers = &keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && !modifiers.alt && (keystroke.key == "c" || keystroke.key == "insert") {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
            cx.stop_propagation();
            return;
        }
        let types = keystroke.key_char.is_some() || matches!(keystroke.key.as_str(), "escape" | "enter" | "backspace" | "delete" | "tab");
        if types && !modifiers.control && !modifiers.alt && !modifiers.platform && selection::clear() {
            self.text_selection_changed(cx);
        }
    }

    fn text_selection_changed(&self, cx: &mut Context<Self>) {
        if let Some((_, chat)) = &self.chat {
            chat.update(cx, |chat, cx| chat.refresh_messages(cx));
        }
    }

    /// The next or previous conversation in the list, hidden ones left out.
    fn step_conversation(&mut self, step: isize, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active() else { return };
        let visible: Vec<String> = server.conversations.iter().filter(|item| !item.hidden && !item.blocked).map(|item| item.key.clone()).collect();
        let index = server.active_key.as_ref().and_then(|key| visible.iter().position(|item| item == key));
        let next = match index {
            Some(index) => index as isize + step,
            None if step > 0 => 0,
            None => return,
        };
        if next < 0 || next as usize >= visible.len() {
            return;
        }
        let key = visible[next as usize].clone();
        self.state.update(cx, |state, cx| state.select_conversation(Some(key), cx));
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let phase = self.state.read(cx).phase.clone();
        let has_servers = !self.state.read(cx).order.is_empty();
        let list_width = self.state.read(cx).settings.list_width.clamp(260., 460.);

        let body: AnyElement = match phase {
            Phase::Booting => div().flex_1().flex().items_center().justify_center().child(logo(44.)).into_any_element(),
            Phase::Failed(message) => div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(6.))
                        .max_w(px(440.))
                        .text_color(theme.text2)
                        .text_center()
                        .child(div().mb(px(8.)).child(icon("triangle-alert", 26., theme.red)))
                        .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text1).child("Zuna couldn't start"))
                        .child("Its encrypted storage didn't open. Your messages are safe on your servers. Try restarting the app.")
                        .child(div().font_family(theme::FONT_MONO).text_size(px(12.)).text_color(theme.text3).child(message)),
                )
                .into_any_element(),
            Phase::Ready if !has_servers => {
                self.chat = None;
                self.onboarding.clone().into_any_element()
            }
            Phase::Ready => {
                let main = self.main_area(window, cx);
                let state = self.state.clone();
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .bg(theme.bg0)
                    .child(self.rail(cx))
                    .child(
                        div()
                            .relative()
                            .flex()
                            .flex_none()
                            .w(px(list_width))
                            .bg(theme.bg1)
                            .child(div().flex_1().min_w_0().min_h_0().flex().flex_col().child(gpui::AnyView::from(self.conversations.clone()).cached(gpui::StyleRefinement::default().flex_1().min_h_0())).children(voice::voice_panel(&self.state, &self.voice, cx)))
                            .child(
                                div()
                                    .id("sidebar-resizer")
                                    .absolute()
                                    .right(px(-3.))
                                    .top_0()
                                    .bottom_0()
                                    .w(px(6.))
                                    .cursor_col_resize()
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(move |root, event: &gpui::MouseDownEvent, _, cx| {
                                            let width = root.state.read(cx).settings.list_width;
                                            root.resizing = Some((f32::from(event.position.x), width));
                                            cx.stop_propagation();
                                        }),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .relative()
                            .bg(theme.bg_chat)
                            .border_l_1()
                            .border_color(theme.line)
                            .child(main),
                    )
                    .on_mouse_move(cx.listener(move |root, event: &MouseMoveEvent, _, cx| {
                        if let Some((start_x, start_width)) = root.resizing {
                            let width = (start_width + f32::from(event.position.x) - start_x).clamp(260., 460.);
                            state.update(cx, |state, cx| {
                                state.settings.list_width = width;
                                cx.notify();
                            });
                        }
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|root, _: &MouseUpEvent, _, cx| {
                            if root.resizing.take().is_some() {
                                root.state.update(cx, |state, cx| state.update_settings(|_| {}, cx));
                            }
                        }),
                    )
                    .into_any_element()
            }
        };

        motion::set_reduced(self.state.read(cx).settings.reduce_motion);
        let overlay = self.overlay(window, cx);
        let closing = match &self.closing {
            Some((view, closed)) if closed.elapsed() < DIALOG_OUT => {
                window.request_animation_frame();
                let left = 1. - closed.elapsed().as_secs_f32() / DIALOG_OUT.as_secs_f32();
                // Seen going, not used: it no longer takes clicks.
                Some(div().absolute().inset_0().child(view.clone()).child(div().id("closing-cover").absolute().inset_0().occlude()).leave(Enter::Fade, left))
            }
            _ => {
                self.closing = None;
                None
            }
        };
        let settings_closing = match &self.settings_closing {
            Some((view, closed)) if closed.elapsed() < SETTINGS_OUT => {
                window.request_animation_frame();
                let left = 1. - closed.elapsed().as_secs_f32() / SETTINGS_OUT.as_secs_f32();
                Some(div().absolute().inset_0().child(view.clone()).child(div().id("settings-closing-cover").absolute().inset_0().occlude()).leave(Enter::Rise(12.), left))
            }
            _ => {
                self.settings_closing = None;
                None
            }
        };
        let settings = self.settings.as_ref().map(|(_, view)| view.clone());
        // As the desktop's useReturnFocus: when a dialog goes, the message box has focus again.
        let covered = overlay.is_some() || settings.is_some();
        if self.covered && !covered {
            match &self.chat {
                Some((_, chat)) => chat.update(cx, |chat, cx| chat.focus_composer(window, cx)),
                None => window.focus(&self.focus, cx),
            }
        }
        self.covered = covered;
        let calls = if matches!(self.state.read(cx).phase, Phase::Ready) && has_servers { voice::incoming_calls(&self.state, &self.voice, cx) } else { None };
        let root = div()
            .size_full()
            .track_focus(&self.focus)
            .on_action(cx.listener(|root, _: &FocusSearch, window, cx| {
                let list = root.conversations.clone();
                list.update(cx, |list, cx| list.focus_search(window, cx));
            }))
            .on_action(cx.listener(|root, _: &NextConversation, _, cx| root.step_conversation(1, cx)))
            .on_action(cx.listener(|root, _: &PreviousConversation, _, cx| root.step_conversation(-1, cx)))
            // Typing with nowhere for it to go starts a message, and a click leaves focus in the
            // message box, as lib/focus.ts keeps it. Space and Enter stay with what has focus.
            .on_key_down(cx.listener(|root, event: &gpui::KeyDownEvent, window, cx| {
                let keystroke = &event.keystroke;
                let modifiers = &keystroke.modifiers;
                let paste = (modifiers.control || modifiers.platform) && keystroke.key == "v";
                if (modifiers.control || modifiers.alt || modifiers.platform) && !paste {
                    return;
                }
                let typed = keystroke.key_char.clone().filter(|text| text.chars().count() == 1 && text != " " && !text.chars().any(char::is_control));
                if (typed.is_none() && !paste) || !root.composer_may_focus(window, cx) {
                    return;
                }
                let Some((_, chat)) = root.chat.clone() else { return };
                if chat.update(cx, |chat, cx| chat.type_into_composer(typed.as_deref(), paste, window, cx)) {
                    // Handled, so Windows doesn't also type the letter wherever focus was.
                    cx.stop_propagation();
                }
            }))
            .capture_any_mouse_up(cx.listener(|root, _: &MouseUpEvent, window, cx| root.refocus_composer(window, cx)))
            // A press anywhere lets go of selected text, and one on a message's text starts anew.
            .capture_any_mouse_down(cx.listener(|root, event: &gpui::MouseDownEvent, _, cx| {
                if event.button == MouseButton::Left && selection::clear() {
                    root.text_selection_changed(cx);
                }
            }))

            .flex()
            .flex_col()
            .bg(theme.bg0)
            .text_color(theme.text1)
            .font_family(theme::FONT_UI)
            .text_size(px(14.))
            .line_height(gpui::relative(1.45))
            .when(crate::platform::draws_title_bar(window), |el| el.child(self.title_bar(window, cx)))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(body)
                    .when_some(settings_closing, |el, closing| el.child(closing))
                    // Rising into place as they fade in, as far as a dialog does.
                    .when_some(settings, |el, settings| el.child(div().absolute().inset_0().child(settings).appear("settings-in", Enter::Rise(16.), 240)))
                    .when_some(calls, |el, calls| el.child(calls)),
            )
            .when_some(closing, |el, closing| el.child(closing))
            .when_some(overlay, |el, overlay| el.child(overlay))
            .child(self.toasts(window, cx))
            .child(self.menu.clone())
            .child(self.picker.clone());
        // Wayland leaves resizing to the app, from a margin around the window, and only gives
        // it keys pressed in it, where push to talk's is chosen.
        #[cfg(target_os = "linux")]
        let root = crate::platform::window_frame(
            root.capture_key_down(|event: &gpui::KeyDownEvent, _, cx| {
                if crate::platform::ptt::hear(&event.keystroke) {
                    cx.stop_propagation();
                }
            }),
            window,
        );
        root
    }
}
