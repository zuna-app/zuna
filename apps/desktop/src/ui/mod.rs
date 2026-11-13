//! The window's interface, laid out as the web's (packages/ui).

pub mod channel_message;
pub mod chat;
pub mod components;
pub mod conversations;
pub mod image_viewer;
pub mod menu;
pub mod motion;
// The cards are Windows's. On Linux and macOS the system's notifications take their place, with the same calls.
#[cfg(windows)]
pub mod notifications;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use crate::platform::notifications;
pub mod message;
pub mod onboarding;
pub mod overlays;
pub mod invites;
pub mod media_views;
pub mod picker;
pub mod plugins;
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

mod main_area;
mod new_device;
mod rail;

use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement, Render, Styled,
    Window, WindowControlArea, div, prelude::*, px,
};

use crate::state::{AppState, Phase, ToastKind};

gpui::actions!(shell, [FocusSearch, NextConversation, PreviousConversation]);

/// Ctrl+K jumps to search, ⌘K on macOS, and Alt+Up and Alt+Down move through conversations, as
/// on the web.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        gpui::KeyBinding::new(if cfg!(target_os = "macos") { "cmd-k" } else { "ctrl-k" }, FocusSearch, None),
        gpui::KeyBinding::new("alt-down", NextConversation, None),
        gpui::KeyBinding::new("alt-up", PreviousConversation, None),
    ]);
}
use crate::theme::{self, RAIL_WIDTH, RADIUS_L, RADIUS_M, TITLEBAR_HEIGHT};
use components::*;
use motion::{Enter, Motion};
use text_input::TabScope;

/// Where the project lives (lib/links.ts).
pub const PROJECT_URL: &str = "https://github.com/zuna-app/zuna";

/// The terms of use everyone agrees to when they create an account.
pub const TERMS_URL: &str = "https://zuna.chat/terms/";

/// Pressing Update: installs the update that's ready and starts the app again. In a voice
/// channel or a call it asks first, as that ends it.
pub fn install_update(cx: &mut gpui::App) {
    if crate::voice::connected_channel(cx).is_some() {
        let state = cx.global::<crate::state::Store>().0.clone();
        state.update(cx, |state, cx| state.set_overlay(Some(crate::state::Overlay::InstallUpdate), cx));
        return;
    }
    restart_into_update(cx);
}

/// Starts the update's installer and quits, as Quit in the tray does. The installer waits for
/// the app to leave, installs, and starts it again.
pub fn restart_into_update(cx: &mut gpui::App) {
    if crate::platform::updates::install(true) {
        crate::quit(cx);
    } else {
        let state = cx.global::<crate::state::Store>().0.clone();
        state.update(cx, |state, cx| state.toast("The update couldn't be started. Zuna will download it again.", ToastKind::Error, cx));
    }
}

/// How long a closed dialog takes to fade away.
const DIALOG_OUT: std::time::Duration = std::time::Duration::from_millis(150);
/// How long settings take to go once closed.
const SETTINGS_OUT: std::time::Duration = std::time::Duration::from_millis(170);
/// How long a dismissed toast takes to go.
const TOAST_OUT: std::time::Duration = std::time::Duration::from_millis(160);

/// What the server rail shows of each server.
struct RailItem {
    id: String,
    name: String,
    url: String,
    has_icon: bool,
    unread: u32,
    has_new: bool,
    /// The Telegram account linked on this device, which wears Zuna's own drawing, not a server's icon.
    telegram: bool,
}

thread_local! {
    static ON_TOP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether something of GPUI's is drawn over the window's content as this frame is: a dialog,
/// settings, a menu, a picker or the question about a new device. A web view laid over the window
/// draws over all of that, so it hides while this is so.
pub fn something_on_top() -> bool {
    ON_TOP.get()
}

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
    /// While the sidebar is being resized: where the pointer started, the width then, and now.
    resizing: Option<(f32, f32, f32)>,
    menu: Entity<menu::MenuLayer>,
    picker: Entity<picker::PickerLayer>,
    focus: gpui::FocusHandle,
    /// Whether a dialog or settings was open last frame, to give focus back when they close.
    covered: bool,
    /// What a new device of the person's is asked about with, which keys go to while it is.
    prompt_focus: gpui::FocusHandle,
    prompting: bool,
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
        state.update(cx, |state, _| {
            state.window_focused = focused;
            state.in_front_since = focused.then(std::time::Instant::now);
        });
        let activation_state = state.clone();
        cx.observe_window_activation(window, move |root, window, cx| {
            let active = window.is_window_active();
            #[cfg(target_os = "linux")]
            crate::platform::main_activation(active);
            activation_state.update(cx, |state, cx| {
                state.window_focused = active;
                if active {
                    state.in_front_since = Some(std::time::Instant::now());
                }
                // Online or not as the window comes or goes, as Telegram's `handleActiveChanged`.
                state.report_activity(cx);
                cx.notify();
            });
            if active {
                root.refocus_composer(window, cx);
            }
        })
        .detach();
        let picker = picker::picker_layer(window, cx);
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
        Root { state, onboarding, conversations, chat: None, stage: None, voice, settings: None, overlay: None, closing: None, settings_closing: None, toast_list: Vec::new(), rail_hovered: None, resizing: None, menu, picker, focus, covered: false, prompt_focus: cx.focus_handle(), prompting: false }
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
        self.overlay.is_none() && self.settings.is_none() && !self.prompting && !menu::is_open(cx) && !picker::is_open(cx) && !text_input::any_focused(window)
    }

    /// The person did something in the window, which says they're here where the system can't
    /// (`quiet_ms` in `state/notify.rs`). Nothing is drawn for it.
    fn note_input(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, _| state.last_input = Some(std::time::Instant::now()));
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
    /// Ctrl+C copies it, as a browser does, and typing lets go of it, as typing
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

#[cfg(test)]
impl Root {
    /// The chat open in the window, for tests outside the interface's own.
    pub fn open_chat(&self) -> Option<Entity<chat::ChatView>> {
        self.chat.as_ref().map(|(_, chat)| chat.clone())
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let phase = self.state.read(cx).phase.clone();
        let has_servers = !self.state.read(cx).order.is_empty();
        // While the sidebar is being resized, its width is Root's alone, and saved once at the end.
        let list_width = self.resizing.map(|(_, _, width)| width).unwrap_or(self.state.read(cx).settings.list_width).clamp(260., 460.);

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
                                            root.resizing = Some((f32::from(event.position.x), width, width));
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
                        if let Some((start_x, start_width, width)) = root.resizing {
                            // Let go where something else took the button's release, as the list's
                            // scrollbar beside the handle can: the resize ends there, not on the next click.
                            if event.pressed_button != Some(MouseButton::Left) {
                                root.resizing = None;
                                root.state.update(cx, |state, cx| state.update_settings(|settings| settings.list_width = width, cx));
                                cx.notify();
                                return;
                            }
                            let width = (start_width + f32::from(event.position.x) - start_x).clamp(260., 460.);
                            root.resizing = Some((start_x, start_width, width));
                            cx.notify();
                        }
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|root, _: &MouseUpEvent, _, cx| {
                            if let Some((_, _, width)) = root.resizing.take() {
                                root.state.update(cx, |state, cx| state.update_settings(|settings| settings.list_width = width, cx));
                            }
                        }),
                    )
                    .into_any_element()
            }
        };

        motion::set_reduced(self.state.read(cx).settings.reduce_motion);
        // What plugins put in the message box goes into the open chat's, where the cursor is.
        if !self.state.read(cx).composer_inserts.is_empty() {
            let inserts = self.state.update(cx, |state, _| std::mem::take(&mut state.composer_inserts));
            if let Some((_, chat)) = self.chat.clone() {
                chat.update(cx, |chat, cx| {
                    for text in inserts {
                        chat.insert_into_composer(&text, window, cx);
                    }
                });
            }
        }
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
        // As the web's useReturnFocus: when a dialog goes, the message box has focus again.
        let covered = overlay.is_some() || settings.is_some();
        if self.covered && !covered {
            match &self.chat {
                Some((_, chat)) => chat.update(cx, |chat, cx| chat.focus_composer(window, cx)),
                None => window.focus(&self.focus, cx),
            }
        }
        self.covered = covered;
        // Over everything, even a dialog, and taking keys from whatever was under it.
        let prompt = if matches!(self.state.read(cx).phase, Phase::Ready) { new_device::prompt(&self.state, &self.prompt_focus, cx) } else { None };
        // What a web view laid over the window, as a video watched together plays in, has to get out of the way of.
        ON_TOP.set(covered || prompt.is_some() || closing.is_some() || settings_closing.is_some() || menu::is_open(cx) || picker::is_open(cx));
        if prompt.is_some() && !self.prompting {
            window.focus(&self.prompt_focus, cx);
        } else if prompt.is_none() && self.prompting {
            match &self.chat {
                Some((_, chat)) if !covered => chat.update(cx, |chat, cx| chat.focus_composer(window, cx)),
                _ => window.focus(&self.focus, cx),
            }
        }
        self.prompting = prompt.is_some();
        let calls = if matches!(self.state.read(cx).phase, Phase::Ready) && has_servers { voice::incoming_calls(&self.state, &self.voice, cx) } else { None };
        let root = div()
            .size_full()
            .track_focus(&self.focus)
            .tab_scope(&self.focus)
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
                root.note_input(cx);
                if event.button == MouseButton::Left && selection::clear() {
                    root.text_selection_changed(cx);
                }
            }))
            // Input to the window, which says the person is here where the system can't (`quiet_ms`):
            // a key, a click or the wheel, as Telegram's `Application::eventFilter` counts its own.
            .capture_key_down(cx.listener(|root, event: &gpui::KeyDownEvent, _, cx| {
                root.note_input(cx);
                // A plugin's command, on the keys it was bound to because nothing else had them.
                if root.covered || root.prompting {
                    return;
                }
                let Some(plugins) = crate::plugins::get(cx) else { return };
                if let Some((uid, command)) = plugins.read(cx).command_for(&event.keystroke) {
                    plugins.update(cx, |plugins, cx| plugins.run_command(&uid, &command, "", cx));
                    cx.stop_propagation();
                }
            }))
            .on_scroll(cx.listener(|root, _: &gpui::ScrollEvent, _, cx| root.note_input(cx)))

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
            .when_some(prompt, |el, prompt| el.child(prompt))
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
