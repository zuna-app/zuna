//! Settings, over the whole window below the title bar
//! (packages/ui/src/features/overlays/Settings.tsx).

mod plugins;
mod connections;
mod profile;
mod preferences;
mod security;
mod server_data;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::scrollbar::{RevealsFocus, Scrolls, gutter, scroll_handle, scrollbar};
use super::text_input::{InputEvent, TabScope, TextInput};
use crate::format::{MIN_PASSWORD, format_full};
use crate::models::{DeviceView, from_value};
use crate::state::{AppState, Overlay, ToastKind};
use crate::theme::{self, Accent, RADIUS_M, RADIUS_S, TextSize, Theme};

const SECTIONS: [(&str, &str, &str); 11] = [
    ("profile", "Profile", "user-round"),
    ("privacy", "Privacy", "lock"),
    ("connections", "Connections", "link"),
    ("notifications", "Notifications", "bell"),
    ("voice", "Voice and video", "mic"),
    ("screen", "Screen sharing", "monitor-up"),
    ("appearance", "Appearance", "palette"),
    ("security", "Security", "shield-check"),
    ("data", "Your data", "server"),
    ("plugins", "Plugins", "puzzle"),
    ("about", "About", "info"),
];

/// The sections that are a server's own, which the Telegram account in front has none of.
const SERVER_SECTIONS: [&str; 4] = ["profile", "privacy", "security", "data"];

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
    /// What the server said it keeps, and which server said it.
    server_data: Option<(String, crate::models::ServerDataExport)>,
    loading_data: bool,
    strength: (u8, String),
    confirming_keep: bool,
    /// Asking before the Telegram account is unlinked.
    confirming_unlink: bool,
    busy: bool,
    /// Holds focus while nothing in it does, so Escape closes it.
    focus: gpui::FocusHandle,
    voice_page: Option<Entity<super::voice_settings::VoiceSettingsPage>>,
    screen_page: Option<Entity<super::voice_settings::ScreenSettingsPage>>,
    /// The marketplace's list is open, and what it's searched for.
    browsing: bool,
    plugin_search: Entity<TextInput>,
    /// Explaining, once, what the switch for unverified plugins opens up.
    confirming_unverified: bool,
    /// The plugin whose log is open.
    showing_log: Option<String>,
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
        let plugin_search = make(cx, "Search plugins", false, false);
        subscriptions.push(cx.subscribe(&plugin_search, |_, _, _: &InputEvent, cx| cx.notify()));
        if let Some(plugins) = crate::plugins::get(cx) {
            subscriptions.push(cx.observe(&plugins, |_, _, cx| cx.notify()));
        }
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let telegram_in_front = state.read(cx).active().is_some_and(|server| server.entry.is_telegram());
        let mut view = SettingsView {
            state,
            // A server's own settings don't apply to the Telegram account, so it opens on what does.
            section: section.unwrap_or_else(|| if telegram_in_front { "connections".into() } else { "profile".into() }),
            display_name,
            bio,
            current,
            next,
            confirm,
            recovery_password,
            focused: None,
            devices: Vec::new(),
            recovery_key: None,
            server_data: None,
            loading_data: false,
            strength: (0, String::new()),
            confirming_keep: false,
            confirming_unlink: false,
            busy: false,
            focus,
            voice_page: None,
            screen_page: None,
            browsing: false,
            plugin_search,
            confirming_unverified: false,
            showing_log: None,
            _subscriptions: subscriptions,
        };
        view.reset_profile(cx);
        view.load_devices(cx);
        if view.section == "data" {
            view.load_server_data(false, cx);
        }
        view
    }

    fn me(&self, cx: &gpui::App) -> Option<(crate::state::ServerState, crate::models::UserView)> {
        let state = self.state.read(cx);
        let server = state.active().filter(|server| !server.entry.is_telegram())?;
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
                .child(div().text_color(theme.text2).child(format!("Version {} for {}", crate::platform::version_name(crate::platform::VERSION, crate::platform::CHANNEL, crate::platform::BUILD), crate::platform::SYSTEM_NAME)))
                .child(div().text_size(px(13.)).text_color(theme.text3).child("End-to-end encrypted chat on servers you run."))
                .into_any_element(),
        ];
        parts.extend(self.updates(cx));
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

    /// Updates, where this copy updates itself: which releases it follows, where that stands,
    /// and what's new. Elsewhere on Windows, a line saying it doesn't.
    fn updates(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        use crate::platform::updates::{self, Activity, Channel};
        let theme = theme(cx);
        let found = updates::current();
        if !found.enabled {
            let note = "This copy doesn't update automatically. Only installed releases do.";
            return if cfg!(windows) { vec![div().text_center().text_size(px(12.5)).text_color(theme.text3).child(note).into_any_element()] } else { Vec::new() };
        }
        let channels = div().flex().bg(theme.bg3).rounded(RADIUS_M).p(px(2.)).gap(px(1.)).children([Channel::Stable, Channel::Nightly].into_iter().map(|channel| {
            let active = found.following == channel;
            let label = if channel == Channel::Stable { "Stable" } else { "Nightly" };
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
                .on_click(move |_, _, cx| {
                    if !active {
                        state.update(cx, |state, cx| state.update_settings(|settings| settings.update_channel = Some(channel.name().into()), cx));
                        updates::follow(channel);
                    }
                })
                .child(label)
        }));
        // Going back to stable never installs an older build, as the app's data has moved on.
        let hint = match (found.following, Channel::of_build()) {
            (Channel::Nightly, _) => "Nightly builds get new changes first, but are tested less.",
            (Channel::Stable, Channel::Nightly) => "This is a nightly build, so it won't update until a newer stable release comes out. Stable releases are fully tested before they come out.",
            (Channel::Stable, Channel::Stable) => "Stable releases are fully tested before they come out.",
        };
        let page = found.ready.as_ref().map(|update| update.page()).or_else(updates::own_page);
        let busy = found.activity != Activity::Idle;
        let actions = div()
            .flex()
            .flex_none()
            .gap(px(8.))
            .when_some(page, |el, page| el.child(button("whats-new", ButtonKind::Ghost, ButtonSize::Small, false, cx).child("What's new").on_click(move |_, _, cx| cx.open_url(&page))))
            .child(if found.ready.is_some() {
                button("update-now", ButtonKind::Primary, ButtonSize::Small, false, cx).child("Update and restart").on_click(|_, _, cx| crate::ui::install_update(cx))
            } else {
                button("check-now", ButtonKind::Default, ButtonSize::Small, busy, cx).child("Check now").when(!busy, |el| el.on_click(|_, _, _| updates::check_now()))
            });
        vec![
            Self::divider(&theme),
            Self::row("Updates", Some(hint), channels, &theme),
            Self::row(&updates::status_line(&found, std::time::SystemTime::now()), None, actions, &theme),
        ]
    }
}

#[cfg(test)]
impl SettingsView {
    /// The profile's name and about fields, for tests outside the settings' own.
    pub fn profile_fields(&self) -> (Entity<TextInput>, Entity<TextInput>) {
        (self.display_name.clone(), self.bio.clone())
    }
}

impl Render for SettingsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let telegram_in_front = self.state.read(cx).active().is_some_and(|server| server.entry.is_telegram());
        let has_connections = crate::telegram::available() || self.state.read(cx).servers.contains_key(crate::telegram::SERVER_ID);
        if telegram_in_front && SERVER_SECTIONS.contains(&self.section.as_str()) {
            self.section = "connections".into();
        }
        if self.section == "connections" && !has_connections {
            self.section = "profile".into();
        }
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
            "data" => self.server_data_page(cx),
            "plugins" => self.plugins_page(cx),
            "connections" => self.connections(cx),
            "about" => self.about(cx),
            section if section.starts_with("plugin:") => {
                let uid = section.trim_start_matches("plugin:").to_string();
                self.plugin_section(&uid, cx)
            }
            _ => self.profile(cx),
        };
        // Each plugin with settings has a section of its own, under a heading of their own.
        let plugin_sections = Self::plugin_sections(cx);
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
            // Connections only where Telegram can be linked, or one is: a build without an api_id has nothing to say there.
            .children(SECTIONS.iter().filter(|(id, _, _)| (!telegram_in_front || !SERVER_SECTIONS.contains(id)) && (*id != "connections" || has_connections)).map(|(id, label, icon_name)| {
                let active = self.section == *id;
                let id_string = id.to_string();
                named_div(SharedString::from(format!("section-{id}")))
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
                        } else if view.section == "data" {
                            view.load_server_data(false, cx);
                        }
                        cx.notify();
                    }))
                    .child(icon(icon_name, 17., if active { theme.text1 } else { theme.text2 }))
                    .child(label.to_string())
            }))
            .when(!plugin_sections.is_empty(), |el| el.child(div().px(px(10.)).pt(px(14.)).pb(px(6.)).text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(theme.text3).child("Plugins")))
            .children(plugin_sections.into_iter().map(|(uid, name, verified)| {
                let section = format!("plugin:{uid}");
                let active = self.section == section;
                div()
                    .id(SharedString::from(format!("settings-{section}")))
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
                        view.section = section.clone();
                        cx.notify();
                    }))
                    .child(icon("puzzle", 17., if active { theme.text1 } else { theme.text2 }))
                    .child(div().flex_1().min_w_0().one_line().child(name))
                    .when(!verified, |el| el.child(crate::ui::plugins::unverified_mark(cx)))
            }));
        div()
            .id("settings-layer")
            .size_full()
            .flex()
            .bg(theme.bg_chat)
            .occlude()
            .track_focus(&self.focus)
            .tab_scope(&self.focus)
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
                        div().id("settings-content").size_full().overflow_y_scroll().track_scroll(&handle).pr(gutter(&handle)).child(div().w(px(580.)).max_w_full().mx_auto().pt(px(32.)).px(px(28.)).pb(px(56.)).flex().flex_col().gap(px(14.)).children(page)).child(scrollbar("settings-content", Scrolls::Div(handle.clone()))).reveals_focus(&handle)
                    })
                    .child(div().absolute().right(px(16.)).top(px(16.)).child(icon_button("close-settings", "x", 19., false, false, cx).on_click(cx.listener(|view, _, _, cx| view.close(cx))))),
            )
            .when(self.confirming_keep, |el| el.child(self.keep_metadata_confirm(cx)))
            .when(self.confirming_unverified, |el| el.child(self.unverified_confirm(cx)))
            // A plugin's package dropped on the Plugins page proposes it, as "Install from a file…" does.
            .on_drop(cx.listener(|view, paths: &gpui::ExternalPaths, _, cx| {
                if view.section != "plugins" {
                    return;
                }
                if let Some(path) = paths.paths().iter().find(|path| path.extension().is_some_and(|extension| extension == "zunaplugin")) {
                    let path = path.clone();
                    view.propose_file(&path, cx);
                }
            }))
    }
}

#[cfg(test)]
mod tests {
    //! Settings gone through as a person goes through them: each section from the list beside
    //! them, and Escape, which puts away a question first and then the settings.

    use gpui::TestAppContext;
    use serde_json::json;

    use super::*;
    use crate::state::Overlay;
    use crate::testing::fixtures::*;
    use crate::testing::{App as Running, World};

    #[gpui::test]
    fn each_section_and_escape(cx: &mut TestAppContext) {
        let mut world = World::new("settings-sections");
        world.server["getCalls"] = json!([]);
        let app = Running::open(cx, &world);
        app.update(cx, |state, cx| {
            state.settings.reduce_motion = true;
            state.select_server(SERVER, cx);
            state.set_overlay(Some(Overlay::Settings { section: None }), cx);
        });
        let view = app.window.update(cx, |root, _, _| root.settings.as_ref().and_then(|(_, view)| view.clone().downcast::<SettingsView>().ok())).unwrap().expect("Settings are open");
        for (id, _, _) in SECTIONS {
            if !app.drawn(cx, &format!("section-{id}")) {
                assert_eq!(id, "connections", "only Connections is left out, in a build that can't link Telegram");
                continue;
            }
            app.click(cx, &format!("section-{id}"));
            assert_eq!(cx.read(|cx| view.read(cx).section.clone()), id);
        }
        assert!(!app.calls_of("exportServerData").is_empty(), "Your data reads what the server holds");
        // Escape: a question first, then the settings.
        view.update(cx, |view, _| view.confirming_keep = true);
        let focus = cx.read(|cx| view.read(cx).focus.clone());
        app.window.update(cx, |_, window, cx| focus.focus(window, cx)).unwrap();
        let mut window = gpui::VisualTestContext::from_window(app.window.into(), cx);
        window.simulate_keystrokes("escape");
        app.run(cx);
        assert!(!cx.read(|cx| view.read(cx).confirming_keep));
        assert!(app.read(cx, |state| matches!(state.overlay, Some(Overlay::Settings { .. }))));
        let mut window = gpui::VisualTestContext::from_window(app.window.into(), cx);
        window.simulate_keystrokes("escape");
        app.run(cx);
        assert_eq!(app.read(cx, |state| state.overlay.clone()), None);
    }
}
