//! Settings, over the whole window below the title bar
//! (packages/ui/src/features/overlays/Settings.tsx).

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use super::text_input::{InputEvent, TextInput};
use crate::format::{MIN_PASSWORD, format_full};
use crate::models::{DeviceView, from_value};
use crate::state::{AppState, Overlay, ToastKind};
use crate::theme::{self, Accent, RADIUS_L, RADIUS_M, RADIUS_S, TextSize, Theme};

const SECTIONS: [(&str, &str, &str); 8] = [
    ("profile", "Profile", "user-round"),
    ("privacy", "Privacy", "lock"),
    ("notifications", "Notifications", "bell"),
    ("voice", "Voice and video", "mic"),
    ("screen", "Screen sharing", "monitor-up"),
    ("appearance", "Appearance", "palette"),
    ("security", "Security", "shield-check"),
    ("about", "About", "info"),
];

pub struct SettingsView {
    state: Entity<AppState>,
    section: String,
    display_name: Entity<TextInput>,
    bio: Entity<TextInput>,
    current: Entity<TextInput>,
    next: Entity<TextInput>,
    confirm: Entity<TextInput>,
    recovery_password: Entity<TextInput>,
    focused: Option<usize>,
    devices: Vec<DeviceView>,
    recovery_key: Option<String>,
    strength: (u8, String),
    confirming_keep: bool,
    busy: bool,
    /// Holds focus while nothing in it does, so Escape closes it.
    focus: gpui::FocusHandle,
    voice_page: Option<Entity<super::voice_settings::VoiceSettingsPage>>,
    screen_page: Option<Entity<super::voice_settings::ScreenSettingsPage>>,
    _subscriptions: Vec<Subscription>,
}

impl SettingsView {
    pub fn new(state: Entity<AppState>, section: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let make = |cx: &mut Context<Self>, placeholder: &str, masked: bool, multiline: bool| {
            cx.new(|cx| {
                let input = TextInput::new(cx, placeholder.to_string()).masked(masked);
                if multiline {
                    let mut input = input.multiline();
                    input.set_newline_on_enter(true);
                    input
                } else {
                    input
                }
            })
        };
        let display_name = make(cx, "", false, false);
        let bio = make(cx, "A few words about you", false, true);
        let current = make(cx, "", true, false);
        let next = make(cx, "", true, false);
        let confirm = make(cx, "", true, false);
        let recovery_password = make(cx, "", true, false);
        let mut subscriptions = vec![cx.observe(&state, |_, _, cx| cx.notify())];
        for (index, input) in [&display_name, &bio, &current, &next, &confirm, &recovery_password].into_iter().enumerate() {
            subscriptions.push(cx.subscribe_in(input, window, move |view, _, event, _, cx| {
                match event {
                    InputEvent::Focused => view.focused = Some(index),
                    InputEvent::Blurred if view.focused == Some(index) => view.focused = None,
                    InputEvent::Changed if index == 3 => view.rate(cx),
                    _ => {}
                }
                cx.notify();
            }));
        }
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let mut view = SettingsView {
            state,
            section: section.unwrap_or_else(|| "profile".into()),
            display_name,
            bio,
            current,
            next,
            confirm,
            recovery_password,
            focused: None,
            devices: Vec::new(),
            recovery_key: None,
            strength: (0, String::new()),
            confirming_keep: false,
            busy: false,
            focus,
            voice_page: None,
            screen_page: None,
            _subscriptions: subscriptions,
        };
        view.reset_profile(cx);
        view.load_devices(cx);
        view
    }

    fn me(&self, cx: &gpui::App) -> Option<(crate::state::ServerState, crate::models::UserView)> {
        let state = self.state.read(cx);
        let server = state.active()?;
        let me = server.users.get(server.self_id())?.clone();
        Some((server.clone(), me))
    }

    fn reset_profile(&mut self, cx: &mut Context<Self>) {
        if let Some((_, me)) = self.me(cx) {
            self.display_name.update(cx, |input, cx| input.set_text(me.display_name.clone(), cx));
            self.bio.update(cx, |input, cx| input.set_text(me.bio.clone(), cx));
        }
    }

    fn load_devices(&mut self, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "getDevices", vec![]);
        cx.spawn(async move |view, cx| {
            if let Ok(value) = call.await {
                view.update(cx, |view, cx| {
                    view.devices = from_value(value);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn rate(&mut self, cx: &mut Context<Self>) {
        let password = self.next.read(cx).text().to_string();
        let related = self.me(cx).map(|(_, me)| vec![me.username, me.display_name]).unwrap_or_default();
        let rating = self.state.read(cx).core.password_strength(password, related);
        cx.spawn(async move |view, cx| {
            let strength = rating.await;
            view.update(cx, |view, cx| {
                view.strength = strength;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }

    pub(super) fn row(title: &str, hint: Option<&str>, control: impl IntoElement, theme: &Theme) -> AnyElement {
        div()
            .flex()
            .items_center()
            .gap(px(16.))
            .py(px(10.))
            .text_size(px(14.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().font_weight(FontWeight::MEDIUM).child(title.to_string()))
                    .when_some(hint, |el, hint| el.child(div().mt(px(1.)).text_size(px(12.5)).text_color(theme.text2).child(hint.to_string()))),
            )
            .child(control)
            .into_any_element()
    }

    pub(super) fn heading(text: &str, theme: &Theme) -> AnyElement {
        let _ = theme;
        div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(text.to_string()).into_any_element()
    }

    pub(super) fn lead(text: String, theme: &Theme) -> AnyElement {
        div().mt(px(-8.)).text_size(px(13.5)).text_color(theme.text2).child(text).into_any_element()
    }

    fn divider(theme: &Theme) -> AnyElement {
        div().h(px(1.)).bg(theme.line).my(px(8.)).into_any_element()
    }

    pub(super) fn subheading(text: &str) -> AnyElement {
        div().text_size(px(14.5)).font_weight(FontWeight::SEMIBOLD).child(text.to_string()).into_any_element()
    }

    fn profile(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, me)) = self.me(cx) else { return Vec::new() };
        let image = me.avatar.as_ref().and_then(|avatar| {
            let server_id = server.entry.id.clone();
            self.state.update(cx, |state, cx| state.decrypted_picture(&server_id, avatar, cx))
        });
        let name = self.display_name.read(cx).text().trim().to_string();
        let bio = self.bio.read(cx).text().to_string();
        let dirty = name != me.display_name || bio != me.bio;
        let state = self.state.clone();
        let busy = self.busy;
        vec![
            Self::heading("Profile", &theme),
            Self::lead(format!("Only members of {} can see this. Your server stores it encrypted.", server.entry.name), &theme),
            div()
                .flex()
                .items_center()
                .gap(px(18.))
                .child(
                    div()
                        .relative()
                        .flex_none()
                        .child(avatar(AvatarProps { name: me.display_name.clone(), seed: me.id.clone(), image, size: 72., online: false, rounded: false, dot_border: theme.bg_chat }, cx))
                        .child(
                            div()
                                .id("change-avatar")
                                .absolute()
                                .right(px(-2.))
                                .bottom(px(-2.))
                                .size(px(28.))
                                .rounded_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(theme.bg4)
                                .border_2()
                                .border_color(theme.bg1)
                                .cursor_pointer()
                                .hover(move |style| style.bg(theme.bg5))
                                
                                .on_click(cx.listener(|view, _, _, cx| view.change_avatar(cx)))
                                .child(icon("camera", 17., theme.text1)),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(div().font_weight(FontWeight::SEMIBOLD).text_size(px(15.)).child(me.display_name.clone()))
                        .child(div().text_color(theme.text2).child(format!("@{}", me.username)))
                        .when(me.avatar.is_some(), |el| {
                            let state = self.state.clone();
                            el.child(
                                div()
                                    .id("remove-avatar")
                                    .text_size(px(13.))
                                    .text_color(theme.text2)
                                    .cursor_pointer()
                                    .hover(move |style| style.text_color(theme.text1))
                                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("updateProfile", vec![json!({}), serde_json::Value::Null], cx)))
                                    .child("Remove picture"),
                            )
                        }),
                )
                .into_any_element(),
            field(Some("Display name"), self.display_name.clone(), None, None, self.focused == Some(0), None, cx).into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Bio"))
                .child(
                    div()
                        .min_h(px(76.))
                        .bg(theme.bg2)
                        .border_1()
                        .border_color(if self.focused == Some(1) { theme.line_strong } else { theme.line })
                        .rounded(RADIUS_M)
                        .px(px(11.))
                        .py(px(9.))
                        .line_height(px(20.))
                        .child(self.bio.clone()),
                )
                .into_any_element(),
            div()
                .flex()
                .child(
                    button("save-profile", ButtonKind::Primary, ButtonSize::Normal, !dirty || name.is_empty() || busy, cx)
                        .child(if busy { "Saving…" } else { "Save changes" })
                        .when(dirty && !name.is_empty() && !busy, |el| {
                            el.on_click(cx.listener(move |view, _, _, cx| {
                                view.busy = true;
                                let state = state.clone();
                                state.update(cx, |state, cx| {
                                    let server = state.active_server.clone();
                                    state.call(server.as_deref(), "updateProfile", vec![json!({ "displayName": name, "bio": bio })], cx, |state, result, cx| match result {
                                        Ok(_) => state.toast("Profile saved", ToastKind::Info, cx),
                                        Err(error) => state.toast(error.message, ToastKind::Error, cx),
                                    });
                                });
                                view.busy = false;
                                cx.notify();
                            }))
                        }),
                )
                .into_any_element(),
            Self::divider(&theme),
            {
                let state = self.state.clone();
                let delete_state = self.state.clone();
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        button("sign-out", ButtonKind::Danger, ButtonSize::Normal, false, cx)
                            .child(icon("log-out", 15., theme.red))
                            .child("Sign out of this server")
                            .on_click(move |_, _, cx| state.update(cx, |state, cx| state.set_overlay(Some(Overlay::LeaveServer), cx))),
                    )
                    .child(
                        button("delete-account", ButtonKind::Default, ButtonSize::Normal, false, cx)
                            .child(icon("trash", 15., theme.text1))
                            .child("Delete account")
                            .on_click(move |_, _, cx| delete_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::ServerSettings { section: Some("delete".into()) }), cx))),
                    )
                    .into_any_element()
            },
        ]
    }

    /// A new profile picture: the middle square of an image, 256 pixels across, as the desktop makes it.
    fn change_avatar(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        let state = self.state.clone();
        cx.spawn(async move |_, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.first() else { return };
            let prepared = crate::media::prepare_avatar(path);
            state.update(cx, |state, cx| match prepared {
                Some(file) => state.act("updateProfile", vec![json!({}), crate::host::file(&file.to_string_lossy(), "image/jpeg")], cx),
                None => state.toast("That image couldn't be processed.", ToastKind::Error, cx),
            });
        })
        .detach();
    }

    fn privacy(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, me)) = self.me(cx) else { return Vec::new() };
        let settings = self.state.read(cx).settings.clone();
        let receipts = server.prefs.send_read_receipts;
        let (state_a, state_b, state_c, state_d) = (self.state.clone(), self.state.clone(), self.state.clone(), self.state.clone());
        let hides = me.hides_last_seen;
        let mut parts = vec![
            Self::heading("Privacy", &theme),
            Self::lead(format!("These apply to {}. Each server you join has its own settings.", server.entry.name), &theme),
            Self::row(
                "Send read receipts",
                Some("Others see when you've read their messages. If off, your devices still stay in sync."),
                switch("receipts", receipts, cx).on_click(move |_, _, cx| state_a.update(cx, |state, cx| state.act("updatePreferences", vec![json!({ "sendReadReceipts": !receipts })], cx))),
                &theme,
            ),
            Self::row(
                "Show when I'm online",
                Some("If off, people see “last seen recently” instead of your status."),
                switch("online", !hides, cx).on_click(move |_, _, cx| state_b.update(cx, |state, cx| state.act("setHideLastSeen", vec![json!(!hides)], cx))),
                &theme,
            ),
            Self::divider(&theme),
            Self::subheading("Blocked people"),
        ];
        let blocked: Vec<_> = server.prefs.blocked().iter().filter_map(|id| server.users.get(id).cloned()).collect();
        if blocked.is_empty() {
            parts.push(div().text_size(px(12.5)).text_color(theme.text2).child("Nobody. You can block someone from their details in a chat, or from a group's members.").into_any_element());
        }
        for user in blocked {
            let state = self.state.clone();
            let id = user.id.clone();
            parts.push(Self::row(
                &user.display_name,
                Some(&format!("@{}", user.username)),
                button(SharedString::from(format!("unblock-{}", user.id)), ButtonKind::Default, ButtonSize::Small, false, cx)
                    .child("Unblock")
                    .on_click(move |_, _, cx| state.update(cx, |state, cx| state.act("setBlocked", vec![json!(id), json!(false)], cx))),
                &theme,
            ));
        }
        parts.push(div().text_size(px(12.5)).text_color(theme.text2).child("You don't see messages from people you block, or hear about them. Nobody is told, and your server can't see who you block.").into_any_element());
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("On this device"));
        let link_previews = settings.link_previews;
        parts.push(Self::row(
            "Link previews",
            Some("When you write a link, this device fetches the page to show its title and picture, and sends them encrypted with your message. The site sees your address, as when you open a link. Your server never sees it."),
            switch("link-previews", link_previews, cx).on_click(move |_, _, cx| state_c.update(cx, |state, cx| state.update_settings(|s| s.link_previews = !link_previews, cx))),
            &theme,
        ));
        let remove = settings.remove_metadata;
        parts.push(Self::row(
            "Remove metadata from files",
            Some("Before a file is sent, this device takes out where and when it was made, the camera or phone and its serial number, the program, and editing history. Photos: JPEG, PNG, WebP, GIF, HEIC and AVIF. Videos: MP4, MOV, 3GP, WebM and MKV. Drawings: SVG. Other files are sent as they are."),
            switch("remove-metadata", remove, cx).on_click(cx.listener(move |view, _, _, cx| {
                if remove {
                    view.confirming_keep = true;
                    cx.notify();
                } else {
                    state_d.update(cx, |state, cx| state.update_settings(|s| s.remove_metadata = true, cx));
                }
            })),
            &theme,
        ));
        parts
    }

    fn notifications(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let settings = self.state.read(cx).settings.clone();
        let (on_state, sound_state, tray_state) = (self.state.clone(), self.state.clone(), self.state.clone());
        let (on, sound, tray) = (settings.notifications, settings.notification_sound, settings.close_to_tray);
        let preview_label = match settings.notification_preview.as_str() {
            "sender" => "Sender only",
            "none" => "Nothing",
            _ => "Sender and message",
        };
        let preview_state = self.state.clone();
        // As the desktop's select: the choice, and a menu of the three under it.
        let (select_bounds, select_probe) = bounds_probe();
        let select = div()
            .id("notification-preview")
            .w(px(180.))
            .h(px(36.))
            .px(px(10.))
            .flex()
            .items_center()
            .justify_between()
            .rounded(RADIUS_M)
            .bg(theme.bg2)
            .border_1()
            .border_color(theme.line)
            .text_size(px(13.5))
            .cursor_pointer()
            .child(select_probe)
            .on_click(move |_, _, cx| {
                let choice = |label: &str, value: &'static str| {
                    let state = preview_state.clone();
                    super::menu::MenuEntry::new(label, "bell", move |_, cx| {
                        state.update(cx, |state, cx| state.update_settings(|settings| settings.notification_preview = value.to_string(), cx))
                    })
                };
                let entries = vec![choice("Sender and message", "full"), choice("Sender only", "sender"), choice("Nothing", "none")];
                let at = select_bounds.get();
                super::menu::open_menu(gpui::point(at.left(), at.bottom() + px(4.)), entries, false, cx);
            })
            .child(preview_label)
            .child(icon("chevron-down", 15., theme.text2));
        vec![
            Self::heading("Notifications", &theme),
            Self::lead("Previews are decrypted on this device. No notification service ever sees them.".into(), &theme),
            Self::row(
                "Desktop notifications",
                Some("While you're on another device, they wait 30 seconds, and don't show if you read the chat there."),
                switch("notifications-on", on, cx).on_click(move |_, _, cx| on_state.update(cx, |state, cx| state.update_settings(|s| s.notifications = !on, cx))),
                &theme,
            ),
            Self::row(
                "Sound",
                None,
                switch("notification-sound", sound, cx).on_click(move |_, _, cx| sound_state.update(cx, |state, cx| state.update_settings(|s| s.notification_sound = !sound, cx))),
                &theme,
            ),
            Self::row("What notifications show", Some("Choose less if others can see your screen."), select, &theme),
            Self::row(
                "Keep running when closed",
                Some("Zuna stays in the system tray so messages still arrive."),
                switch("close-to-tray", tray, cx).on_click(move |_, _, cx| tray_state.update(cx, |state, cx| state.update_settings(|s| s.close_to_tray = !tray, cx))),
                &theme,
            ),
        ]
    }

    fn appearance(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let settings = self.state.read(cx).settings.clone();
        let swatches = div().flex().gap(px(8.)).children(Accent::ALL.into_iter().map(|accent| {
            let active = settings.accent == accent;
            let check = if matches!(accent, Accent::Neutral | Accent::Amber) { theme::color(theme::hex(0x111113)) } else { gpui::white() };
            let state = self.state.clone();
            div()
                .id(SharedString::from(format!("accent-{}", accent.label())))
                .size(px(32.))
                .rounded_full()
                .bg(Theme::swatch(accent))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .relative()
                .border_1()
                .border_color(theme::color(theme::white_a(0.1)))
                .when(active, |el| el.child(div().absolute().top(px(-5.)).left(px(-5.)).size(px(40.)).rounded_full().border_2().border_color(theme.text1)))
                
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.update_settings(|s| s.accent = accent, cx)))
                .when(active, |el| el.child(icon("check", 15., check)))
        }));
        let segmented = div().flex().bg(theme.bg3).rounded(RADIUS_M).p(px(2.)).gap(px(1.)).children([TextSize::Small, TextSize::Medium, TextSize::Large].into_iter().map(|size| {
            let active = settings.message_size == size;
            let label = match size {
                TextSize::Small => "Small",
                TextSize::Medium => "Medium",
                TextSize::Large => "Large",
            };
            let state = self.state.clone();
            div()
                .id(label)
                .px(px(11.))
                .py(px(4.))
                .rounded(RADIUS_S)
                .text_size(px(13.))
                .text_color(if active { theme.text1 } else { theme.text2 })
                .when(active, |el| el.bg(theme.bg5))
                .cursor_pointer()
                .on_click(move |_, _, cx| state.update(cx, |state, cx| state.update_settings(|s| s.message_size = size, cx)))
                .child(label)
        }));
        let (motion_state, enter_state) = (self.state.clone(), self.state.clone());
        let reduce = settings.reduce_motion;
        let enter = settings.enter_to_send;
        vec![
            Self::heading("Appearance", &theme),
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Accent color"))
                .child(swatches)
                .into_any_element(),
            Self::row("Message size", None, segmented, &theme),
            Self::row(
                "Reduce motion",
                Some("Turns off most animations."),
                switch("reduce-motion", reduce, cx).on_click(move |_, _, cx| motion_state.update(cx, |state, cx| state.update_settings(|s| s.reduce_motion = !reduce, cx))),
                &theme,
            ),
            Self::row(
                "Press Enter to send",
                Some("If off, use Ctrl+Enter to send and Enter for new lines."),
                switch("enter-to-send", enter, cx).on_click(move |_, _, cx| enter_state.update(cx, |state, cx| state.update_settings(|s| s.enter_to_send = !enter, cx))),
                &theme,
            ),
        ]
    }

    fn security(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let Some((server, me)) = self.me(cx) else { return Vec::new() };
        let key_protected = self.state.read(cx).key_protected;
        let verify_state = self.state.clone();
        let user_id = me.id.clone();
        let mut parts = vec![Self::heading("Security", &theme)];
        if !key_protected {
            parts.push(
                div()
                    .flex()
                    .gap(px(10.))
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(RADIUS_M)
                    .bg(theme.amber_soft)
                    .text_size(px(13.))
                    .text_color(theme::color(theme::hex(0xe8d3a2)))
                    .child(icon("lock", 15., theme.amber))
                    .child(crate::platform::KEY_WARNING)
                    .into_any_element(),
            );
        }
        parts.push(Self::row(
            "Your security key",
            Some("Compare it with friends to prove nobody is in between."),
            button("view-key", ButtonKind::Default, ButtonSize::Small, false, cx)
                .child(icon("key-round", 14., theme.text1))
                .child("View")
                .on_click(move |_, _, cx| verify_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Verify { user_id: user_id.clone() }), cx))),
            &theme,
        ));
        let mut devices = div().flex().flex_col().gap(px(3.));
        for device in self.devices.clone() {
            let state = self.state.clone();
            let id = device.id.clone();
            devices = devices.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(11.))
                    .px(px(10.))
                    .py(px(8.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg2)
                    .text_size(px(13.5))
                    .child(div().size(px(34.)).rounded_full().bg(theme.bg3).flex().items_center().justify_center().child(icon("laptop", 18., theme.text2)))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .child(div().font_weight(FontWeight::MEDIUM).child(device.name.clone()))
                                    .when(device.is_current, |el| el.child(div().ml(px(8.)).px(px(7.)).py(px(1.)).rounded(px(10.)).text_size(px(11.)).bg(theme.bg4).text_color(theme.text2).child("This device"))),
                            )
                            .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("Signed in {}", format_full(device.created_at)))),
                    )
                    .when(!device.is_current, |el| {
                        el.child(button(SharedString::from(format!("revoke-{}", device.id)), ButtonKind::Danger, ButtonSize::Small, false, cx).child(icon("trash", 13., theme.red)).child("Remove").on_click(move |_, _, cx| {
                            state.update(cx, |state, cx| state.act("revokeDevice", vec![json!(id)], cx))
                        }))
                    }),
            );
        }
        parts.push(
            div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Your devices on this server"))
                .child(devices)
                .child(div().text_size(px(12.)).text_color(theme.text3).child(format!("To add one, sign in there to {}", server.entry.address)))
                .into_any_element(),
        );
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Change password"));
        let current = self.current.read(cx).text().to_string();
        let next = self.next.read(cx).text().to_string();
        let confirm = self.confirm.read(cx).text().to_string();
        let can_change = !current.is_empty() && next.chars().count() >= MIN_PASSWORD && self.strength.0 >= 2 && confirm == next;
        parts.push(field(Some("Current password"), self.current.clone(), None, None, self.focused == Some(2), None, cx).into_any_element());
        parts.push(
            field(
                Some("New password"),
                self.next.clone(),
                None,
                Some(if next.is_empty() { format!("At least {MIN_PASSWORD} characters.") } else { self.strength.1.clone() }),
                self.focused == Some(3),
                None,
                cx,
            )
            .into_any_element(),
        );
        let confirm_error = if !confirm.is_empty() && !next.starts_with(&confirm) { Some("The passwords don't match.".to_string()) } else { None };
        parts.push(field(Some("Confirm new password"), self.confirm.clone(), confirm_error, None, self.focused == Some(4), None, cx).into_any_element());
        let state = self.state.clone();
        parts.push(
            div()
                .child(button("change-password", ButtonKind::Default, ButtonSize::Normal, !can_change, cx).child("Change password").when(can_change, |el| {
                    el.on_click(cx.listener(move |view, _, _, cx| {
                        let (current, next) = (view.current.read(cx).text().to_string(), view.next.read(cx).text().to_string());
                        let inputs = [view.current.clone(), view.next.clone(), view.confirm.clone()];
                        state.update(cx, |state, cx| {
                            let server = state.active_server.clone();
                            state.call(server.as_deref(), "changePassword", vec![json!(current), json!(next)], cx, move |state, result, cx| match result {
                                Ok(_) => {
                                    for input in &inputs {
                                        input.update(cx, |input, cx| input.set_text("", cx));
                                    }
                                    state.toast("Password changed", ToastKind::Info, cx)
                                }
                                Err(error) => state.toast(error.message, ToastKind::Error, cx),
                            });
                        });
                    }))
                }))
                .into_any_element(),
        );
        parts.push(Self::divider(&theme));
        parts.push(Self::subheading("Recovery key"));
        parts.push(div().text_size(px(13.5)).text_color(theme.text2).child("Create a new key if you've lost the old one or think someone saw it. The old key stops working immediately.").into_any_element());
        if let Some(key) = self.recovery_key.clone() {
            let copy = key.clone();
            let state = self.state.clone();
            parts.push(
                div()
                    .grid()
                    .grid_cols(5)
                    .gap(px(8.))
                    .p(px(14.))
                    .bg(theme.bg2)
                    .border_1()
                    .border_color(theme.line)
                    .rounded(RADIUS_M)
                    .font_family(theme::FONT_MONO)
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .children(key.split('-').map(|part| div().flex().justify_center().child(part.to_string())))
                    .into_any_element(),
            );
            parts.push(
                button("copy-new-key", ButtonKind::Default, ButtonSize::Normal, false, cx)
                    .child(icon("copy", 14., theme.text1))
                    .child("Copy")
                    .on_click(move |_, _, cx| {
                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy.clone()));
                        state.update(cx, |state, cx| state.toast("Copied", ToastKind::Info, cx));
                    })
                    .into_any_element(),
            );
        } else {
            parts.push(field(Some("Current password"), self.recovery_password.clone(), None, None, self.focused == Some(5), None, cx).into_any_element());
            let password = self.recovery_password.read(cx).text().to_string();
            let state = self.state.clone();
            parts.push(
                div()
                    .child(button("new-recovery-key", ButtonKind::Default, ButtonSize::Normal, password.is_empty(), cx).child("Create a new recovery key").when(!password.is_empty(), |el| {
                        el.on_click(cx.listener(move |view, _, _, cx| {
                            let call = {
                                let state = state.read(cx);
                                state.active_server.clone().map(|server| state.core.call(Some(&server), "regenerateRecoveryKey", vec![json!(password)]))
                            };
                            let Some(call) = call else { return };
                            let state = state.clone();
                            cx.spawn(async move |view, cx| {
                                let result = call.await;
                                view.update(cx, |view, cx| match result {
                                    Ok(value) => {
                                        view.recovery_key = value.as_str().map(str::to_string);
                                        view.recovery_password.update(cx, |input, cx| input.set_text("", cx));
                                        cx.notify();
                                    }
                                    Err(error) => state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                                })
                                .ok();
                            })
                            .detach();
                            let _ = view;
                        }))
                    }))
                    .into_any_element(),
            );
        }
        parts
    }

    fn about(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = theme(cx);
        let server = self.state.read(cx).active().cloned();
        let mut parts = vec![
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.))
                .py(px(16.))
                .text_center()
                .child(logo(56.))
                .child(div().mt(px(6.)).text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child("Zuna"))
                .child(div().text_color(theme.text2).child(format!("Version {} for {}", crate::platform::VERSION, crate::platform::SYSTEM_NAME)))
                .child(div().text_size(px(13.)).text_color(theme.text3).child("End-to-end encrypted chat on servers you run."))
                .into_any_element(),
        ];
        if let Some(server) = server {
            parts.push(Self::row(&server.entry.name, Some(&server.entry.url), div().text_size(px(12.5)).text_color(theme.text3).child(server.info.map(|info| info.version).unwrap_or_default()), &theme));
        }
        let links = [("source", "Source code", super::PROJECT_URL.to_string()), ("security-model", "Security model", format!("{}/blob/main/SECURITY.md", super::PROJECT_URL)), ("terms", "Terms of Use", super::TERMS_URL.to_string())];
        parts.push(
            div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .children(links.into_iter().map(|(id, label, url)| button(id, ButtonKind::Default, ButtonSize::Normal, false, cx).child(label).on_click(move |_, _, cx| cx.open_url(&url))))
                .into_any_element(),
        );
        parts
    }

    fn keep_metadata_confirm(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let state = self.state.clone();
        div()
            .id("keep-metadata-layer")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .p(px(28.))
            .bg(theme::color(theme::black_a(0.6)))
            .occlude()
            .child(
                div()
                    .w(px(440.))
                    .flex()
                    .flex_col()
                    .bg(theme.bg1)
                    .border_1()
                    .border_color(theme.line_strong)
                    .rounded(px(14.))
                    .shadow(shadow_l())
                    .child(div().flex().items_center().gap(px(10.)).pt(px(16.)).pr(px(16.)).pb(px(4.)).pl(px(20.)).child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child("Send files with their metadata?")))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .px(px(20.))
                            .pt(px(10.))
                            .pb(px(20.))
                            .text_size(px(13.5))
                            .child("Photos and videos from phones usually record where they were taken, to within a few meters, and when. With this off, everyone in a chat you send them to can see that, along with the camera or phone and its serial number, the program used, and what was changed in it. So can anyone they pass the files on to.")
                            .child(div().text_color(theme.text2).child("Your server still can't see any of it, as files are encrypted. This is only for this device, and for files you send from now on.")),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .px(px(20.))
                            .pb(px(16.))
                            .child(button("keep-cancel", ButtonKind::Ghost, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|view, _, _, cx| {
                                view.confirming_keep = false;
                                cx.notify();
                            })))
                            .child(button("keep-confirm", ButtonKind::Danger, ButtonSize::Normal, false, cx).child("Turn off").on_click(cx.listener(move |view, _, _, cx| {
                                view.confirming_keep = false;
                                state.update(cx, |state, cx| state.update_settings(|s| s.remove_metadata = false, cx));
                                cx.notify();
                            }))),
                    ),
            )
            .into_any_element()
    }
}

impl Render for SettingsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let page = match self.section.as_str() {
            "privacy" => self.privacy(cx),
            "notifications" => self.notifications(cx),
            "voice" => {
                let state = self.state.clone();
                let page = self.voice_page.get_or_insert_with(|| cx.new(|cx| super::voice_settings::VoiceSettingsPage::new(state, cx)));
                vec![page.clone().into_any_element()]
            }
            "screen" => {
                let state = self.state.clone();
                let page = self.screen_page.get_or_insert_with(|| cx.new(|cx| super::voice_settings::ScreenSettingsPage::new(state, cx)));
                vec![page.clone().into_any_element()]
            }
            "appearance" => self.appearance(cx),
            "security" => self.security(cx),
            "about" => self.about(cx),
            _ => self.profile(cx),
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
            .child(div().px(px(10.)).pb(px(8.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).one_line().child("Settings"))
            .children(SECTIONS.iter().map(|(id, label, icon_name)| {
                let active = self.section == *id;
                let id_string = id.to_string();
                div()
                    .id(*id)
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .px(px(10.))
                    .py(px(7.))
                    .rounded(RADIUS_M)
                    .text_size(px(14.))
                    .text_color(if active { theme.text1 } else { theme.text2 })
                    .when(active, |el| el.bg(theme.bg3))
                    .when(!active, |el| el.hover(move |style| style.bg(theme.hover).text_color(theme.text1)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |view, _, _, cx| {
                        view.section = id_string.clone();
                        if view.section == "profile" {
                            view.reset_profile(cx);
                        }
                        cx.notify();
                    }))
                    .child(icon(icon_name, 17., if active { theme.text1 } else { theme.text2 }))
                    .child(label.to_string())
            }));
        div()
            .id("settings-layer")
            .size_full()
            .flex()
            .bg(theme.bg_chat)
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    if view.confirming_keep {
                        view.confirming_keep = false;
                        cx.notify();
                    } else {
                        view.close(cx);
                    }
                }
            }))
            .child(nav)
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .child({
                        let handle = scroll_handle("settings-content");
                        div().id("settings-content").size_full().overflow_y_scroll().track_scroll(&handle).pr(gutter(&handle)).child(div().w(px(580.)).max_w_full().mx_auto().pt(px(32.)).px(px(28.)).pb(px(56.)).flex().flex_col().gap(px(14.)).children(page)).child(scrollbar("settings-content", Scrolls::Div(handle.clone())))
                    })
                    .child(div().absolute().right(px(16.)).top(px(16.)).child(icon_button("close-settings", "x", 19., false, false, cx).on_click(cx.listener(|view, _, _, cx| view.close(cx))))),
            )
            .when(self.confirming_keep, |el| el.child(self.keep_metadata_confirm(cx)))
    }
}

#[allow(dead_code)]
fn radius() -> gpui::Pixels {
    RADIUS_L
}
