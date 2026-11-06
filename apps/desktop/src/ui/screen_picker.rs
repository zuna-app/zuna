//! What to share, and how, with a look at each before choosing (ScreenPicker.tsx).

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{AnyElement, App, Context, Entity, FocusHandle, FontWeight, IntoElement, ParentElement, Render, RenderImage, SharedString, Styled, Task, Window, div, img, prelude::*, px};

use super::components::*;
use super::scrollbar::{Scrolls, gutter, scroll_handle, scrollbar};
use crate::platform::screens::{self, Source, THUMB_HEIGHT, THUMB_WIDTH};
use crate::state::{AppState, Overlay};
use crate::theme::{self, RADIUS_M, RADIUS_S, RADIUS_XL};
use crate::voice::rules::{ScreenChoices, screen_terms};
use crate::voice::screen::{ScreenChoice, SoundApp, WindowSoundApp};
use crate::voice::settings::{SCREEN_HEIGHTS, SCREEN_RATES, height_name, rate_name, screen_limits_text};
use crate::voice::Voice;

/// How often the apps playing sound are looked at again while choosing.
const SOUND_APPS_EVERY: Duration = Duration::from_secs(3);

const QUALITIES: [(u32, &str, &str); 4] = [(6_000, "Smooth", "For a slow connection"), (12_000, "Clear", "A good all-round choice"), (20_000, "Sharp", "Text stays crisp"), (40_000, "Best", "For fast connections and games")];

fn app_name(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// A choice of number with "the server's choice" first, as `NumberSelect` offers it: those
/// over the server's limit can't be picked.
pub fn number_select(id: &'static str, label: &str, value: Option<u32>, options: &[u32], name: fn(u32) -> String, server_choice: Option<String>, limit: u32, on_change: Rc<dyn Fn(Option<u32>, &mut Window, &mut App)>, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let mut choices: Vec<(String, Rc<dyn Fn(&mut Window, &mut App)>)> = Vec::new();
    if let Some(label) = &server_choice {
        let on_change = on_change.clone();
        choices.push((label.clone(), Rc::new(move |window, cx| on_change(None, window, cx))));
    }
    let mut shown: Vec<u32> = options.to_vec();
    if let Some(value) = value {
        if !shown.contains(&value) {
            shown.push(value);
        }
    }
    for option in shown {
        if limit > 0 && option > limit {
            continue;
        }
        let on_change = on_change.clone();
        choices.push((name(option), Rc::new(move |window, cx| on_change(Some(option), window, cx))));
    }
    let current = match value {
        Some(value) => name(value),
        None => server_choice.unwrap_or_default(),
    };
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(label.to_string()))
        .child(select_box(id, current, choices, cx))
        .into_any_element()
}

pub struct ScreenPicker {
    state: Entity<AppState>,
    voice: Entity<Voice>,
    sources: Option<Vec<Source>>,
    thumbs: HashMap<String, Arc<RenderImage>>,
    screen_tab: bool,
    chosen: Option<String>,
    starting: bool,
    sound_apps: Vec<SoundApp>,
    /// The app the chosen window belongs to, once looked up.
    window_app: Option<(String, Option<WindowSoundApp>)>,
    /// What the person picked for sound, for which source: "", "everything" or "app:<id>".
    sound_pick: Option<(String, String)>,
    focus: FocusHandle,
    _tasks: Vec<Task<()>>,
}

impl ScreenPicker {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let voice = crate::voice::get(cx).expect("voice starts with the app");
        cx.observe(&voice, |_, _, cx| cx.notify()).detach();
        let load = cx.spawn(async move |this, cx| {
            let found = cx.background_executor().spawn(async move { screens::screens().into_iter().chain(screens::windows()).collect::<Vec<_>>() }).await;
            this.update(cx, |picker, cx| {
                for source in &found {
                    if let Some(bgra) = &source.thumbnail {
                        if let Some(buffer) = image::RgbaImage::from_raw(THUMB_WIDTH, THUMB_HEIGHT, bgra.clone()) {
                            picker.thumbs.insert(source.id.clone(), Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)])));
                        }
                    }
                }
                picker.chosen = found.iter().find(|source| source.screen).or(found.first()).map(|source| source.id.clone());
                picker.sources = Some(found);
                cx.notify();
            })
            .ok();
        });
        // Apps only show while they play, so they come and go.
        let apps = cx.spawn(async move |this, cx| loop {
            let found = cx.background_executor().spawn(async move { crate::voice::screen::sound_apps() }).await;
            if this.update(cx, |picker, cx| {
                picker.sound_apps = found;
                cx.notify();
            }).is_err()
            {
                break;
            }
            cx.background_executor().timer(SOUND_APPS_EVERY).await;
        });
        let focus = cx.focus_handle();
        window.focus(&focus);
        ScreenPicker { state, voice, sources: None, thumbs: HashMap::new(), screen_tab: true, chosen: None, starting: false, sound_apps: Vec::new(), window_app: None, sound_pick: None, focus, _tasks: vec![load, apps] }
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (_, image) in self.thumbs.drain() {
            window.drop_image(image).ok();
        }
        self.state.update(cx, |state, cx| state.set_overlay(None, cx));
    }

    fn source(&self) -> Option<Source> {
        self.sources.as_ref()?.iter().find(|source| Some(&source.id) == self.chosen.as_ref()).cloned()
    }

    /// Looks up whose a chosen window is, once.
    fn look_up_window(&mut self, cx: &mut Context<Self>) {
        let Some(source) = self.source() else { return };
        let Some(window) = source.window() else { return };
        if self.window_app.as_ref().is_some_and(|(id, _)| id == &source.id) {
            return;
        }
        self.window_app = Some((source.id.clone(), None));
        let id = source.id.clone();
        cx.spawn(async move |this, cx| {
            let found = cx.background_executor().spawn(async move { crate::voice::screen::window_sound_app(&window) }).await;
            this.update(cx, |picker, cx| {
                if picker.window_app.as_ref().is_some_and(|(current, _)| current == &id) {
                    picker.window_app = Some((id, found));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Whose sound a share starts with: a screen's the whole computer's, and a window's the app it belongs to.
    fn sound_pick(&self, source: Option<&Source>, by_default: bool) -> String {
        let key = source.map(|source| source.id.clone()).unwrap_or_default();
        if let Some((chosen_for, pick)) = &self.sound_pick {
            if *chosen_for == key {
                return pick.clone();
            }
        }
        if !by_default {
            return String::new();
        }
        match source {
            Some(source) if !source.screen => match &self.window_app {
                // Only the window's own app will do: everything would be more than the window shows.
                Some((id, Some(app))) if *id == source.id => format!("app:{}", app.app.id),
                _ => String::new(),
            },
            _ => "everything".into(),
        }
    }

    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(source) = self.source() else { return };
        self.starting = true;
        let settings = self.voice.read(cx).settings.clone();
        let pick = self.sound_pick(Some(&source), settings.screen_sound_by_default);
        let sound_app = pick.strip_prefix("app:").map(str::to_string);
        let choice = ScreenChoice { source, audio: !pick.is_empty(), sound_app };
        self.voice.update(cx, |voice, cx| voice.start_screen(choice, cx));
        self.close(window, cx);
    }
}

impl Render for ScreenPicker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        self.look_up_window(cx);
        let voice = self.voice.read(cx);
        let settings = voice.settings.clone();
        let server = voice.server_id.as_ref().and_then(|id| self.state.read(cx).servers.get(id)).cloned();
        let rules = server.as_ref().and_then(|server| server.info.as_ref()).and_then(|info| info.screen_share.clone());
        let role = server.as_ref().and_then(|server| server.me.as_ref()).map(|me| me.role.clone()).unwrap_or_default();
        let terms = screen_terms(&ScreenChoices { height: settings.screen_height, fps: settings.screen_fps, kbps: settings.screen_bitrate, sound_kbps: settings.screen_sound_kbps }, rules.as_ref(), &role);
        let suggested = screen_terms(&ScreenChoices { height: None, fps: None, kbps: None, sound_kbps: settings.screen_sound_kbps }, rules.as_ref(), &role);
        let limits = screen_limits_text(rules.as_ref(), &role);
        // What the limits leave out of the lists, which is nothing for someone they don't apply to.
        let limit = |value: u32| if limits.is_some() { value } else { 0 };
        let max_kbps = limit(rules.as_ref().map(|rules| rules.max_kbps).unwrap_or(0));
        let program = crate::voice::screen::program_path().is_some();
        let source = self.source();
        let pick = self.sound_pick(source.as_ref(), settings.screen_sound_by_default);

        let tab = |id: &'static str, label: &'static str, active: bool, screen: bool, cx: &mut Context<Self>| {
            div()
                .id(id)
                .px(px(12.))
                .py(px(5.))
                .rounded(RADIUS_S)
                .text_size(px(13.))
                .text_color(if active { theme.text1 } else { theme.text2 })
                .when(active, |el| el.bg(theme.bg5))
                .cursor_pointer()
                .on_click(cx.listener(move |picker, _, _, cx| {
                    picker.screen_tab = screen;
                    // Where the system picks, each tab has one thing to choose, which is what the tab means.
                    let only: Vec<&Source> = picker.sources.iter().flatten().filter(|source| source.screen == screen).collect();
                    if let [only] = only.as_slice() {
                        if only.system_picks() {
                            picker.chosen = Some(only.id.clone());
                        }
                    }
                    cx.notify();
                }))
                .child(label)
        };
        let mut body: Vec<AnyElement> = Vec::new();
        match &self.sources {
            None => body.push(div().flex().justify_center().p(px(40.)).child(spinner(22., theme.text2)).into_any_element()),
            Some(sources) => {
                body.push(div().flex().bg(theme.bg3).rounded(RADIUS_M).p(px(2.)).gap(px(1.)).w(px(180.)).child(tab("tab-screens", "Screens", self.screen_tab, true, cx)).child(tab("tab-windows", "Windows", !self.screen_tab, false, cx)).into_any_element());
                let mut grid = div().w(px(596.)).flex().flex_wrap().gap(px(8.)).p(px(2.));
                let pickable: Vec<&Source> = sources.iter().filter(|source| source.screen == self.screen_tab).collect();
                for item in &pickable {
                    let chosen = Some(&item.id) == self.chosen.as_ref();
                    let id = item.id.clone();
                    let thumb = self.thumbs.get(&item.id).cloned();
                    grid = grid.child(
                        div()
                            .id(SharedString::from(format!("source-{}", item.id)))
                            .w(px(190.))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .p(px(6.))
                            .rounded(RADIUS_M)
                            .border_1()
                            .border_color(if chosen { theme.accent } else { gpui::transparent_black() })
                            .when(chosen, |el| el.bg(theme.accent_soft))
                            .when(!chosen, |el| el.hover(move |style| style.bg(theme.hover)))
                            .cursor_pointer()
                            .on_click(cx.listener(move |picker, event: &gpui::ClickEvent, window, cx| {
                                picker.chosen = Some(id.clone());
                                if event.click_count() >= 2 {
                                    picker.start(window, cx);
                                }
                                cx.notify();
                            }))
                            .child(
                                div()
                                    .w_full()
                                    .h(px(110.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(RADIUS_S)
                                    .overflow_hidden()
                                    .bg(theme.bg3)
                                    .child(match thumb {
                                        Some(image) => img(image).size_full().object_fit(gpui::ObjectFit::Contain).into_any_element(),
                                        None => icon(if item.screen { "monitor" } else { "app-window" }, 26., theme.text3).into_any_element(),
                                    }),
                            )
                            .child(div().one_line().text_size(px(12.5)).text_color(theme.text2).child(item.name.clone())),
                    );
                }
                if pickable.is_empty() {
                    grid = grid.child(div().text_color(theme.text3).child(if self.screen_tab { "There are no screens to share." } else { "There are no windows to share." }));
                }
                let handle = scroll_handle("screen-grid");
                body.push(div().id("screen-grid").max_h(px(320.)).overflow_y_scroll().track_scroll(&handle).pr(gutter(&handle)).child(grid).child(scrollbar("screen-grid", Scrolls::Div(handle.clone()))).into_any_element());
                if let Some(source) = source.as_ref().filter(|source| source.system_picks()) {
                    // `.setting-hint`.
                    let asks = if source.screen { "Your system asks which screen, once you press Share." } else { "Your system asks which window, once you press Share." };
                    body.push(div().text_size(px(12.5)).text_color(theme.text2).child(asks).into_any_element());
                }
                if program {
                    body.push(div().flex().items_center().gap(px(6.)).text_size(px(12.5)).text_color(theme.text2).child(icon("zap", 13., theme.text2)).child("Captured and encoded on your graphics card, so it stays light on your computer.").into_any_element());
                } else {
                    body.push(notice("triangle-alert", "This build came without native capture, so it can't share a screen.", cx).into_any_element());
                }
            }
        }
        let qualities: Vec<_> = QUALITIES.iter().filter(|(kbps, _, _)| max_kbps == 0 || *kbps <= max_kbps).collect();
        if !qualities.is_empty() {
            let mut row = div().flex().gap(px(6.));
            for (kbps, label, hint) in qualities {
                let active = terms.kbps == *kbps;
                let (voice, kbps) = (self.voice.clone(), *kbps);
                row = row.child(
                    div()
                        .id(SharedString::from(format!("quality-{kbps}")))
                        .flex_1()
                        .p(px(8.))
                        .rounded(RADIUS_M)
                        .border_1()
                        .border_color(if active { theme.accent } else { theme.line })
                        .when(active, |el| el.bg(theme.accent_soft))
                        .when(!active, |el| el.hover(move |style| style.bg(theme.hover)))
                        .cursor_pointer()
                        .on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.update_settings(|settings| settings.screen_bitrate = Some(kbps), cx)))
                        .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).child(*label))
                        .child(div().text_size(px(11.5)).text_color(theme.text3).line_height(gpui::relative(1.25)).mt(px(1.)).child(*hint)),
                );
            }
            body.push(div().flex().flex_col().gap(px(6.)).child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Quality")).child(row).into_any_element());
        }
        let (size_voice, rate_voice) = (self.voice.clone(), self.voice.clone());
        body.push(
            div()
                .flex()
                .gap(px(10.))
                .child(div().flex_1().min_w_0().child(number_select("screen-size", "Size", settings.screen_height, &[0, 2160, 1440, 1080, 720, 480, 360], height_name, Some(format!("Server's choice ({})", height_name(suggested.height))), limit(rules.as_ref().map(|rules| rules.max_height).unwrap_or(0)), Rc::new(move |value, _, cx| size_voice.update(cx, |voice, cx| voice.update_settings(|settings| settings.screen_height = value, cx))), cx)))
                .child(div().flex_1().min_w_0().child(number_select("screen-rate", "Frame rate", settings.screen_fps, &SCREEN_RATES, rate_name, Some(format!("Server's choice ({})", rate_name(suggested.fps))), limit(rules.as_ref().map(|rules| rules.max_fps).unwrap_or(0)), Rc::new(move |value, _, cx| rate_voice.update(cx, |voice, cx| voice.update_settings(|settings| settings.screen_fps = value, cx))), cx)))
                .into_any_element(),
        );
        let _ = SCREEN_HEIGHTS;
        if let Some(limits) = limits {
            body.push(div().text_size(px(12.5)).text_color(theme.text2).child(limits).into_any_element());
        }
        if terms.sound && program {
            // Whose sound goes with the share: nobody's, everything but Zuna's, or one app's.
            let window_app = self.window_app.as_ref().filter(|(id, _)| Some(id) == self.chosen.as_ref()).and_then(|(_, app)| app.clone());
            let mut listed: Vec<(SoundApp, bool)> = Vec::new();
            if let Some(app) = &window_app {
                listed.push((app.app.clone(), !app.playing));
            }
            for app in &self.sound_apps {
                if window_app.as_ref().is_some_and(|window| window.app.id == app.id || window.covers.contains(&app.id)) {
                    continue;
                }
                listed.push((app.clone(), false));
            }
            let picked = pick.strip_prefix("app:").map(str::to_string);
            if let Some(picked) = &picked {
                if !listed.iter().any(|(app, _)| &app.id == picked) {
                    listed.push((SoundApp { id: picked.clone(), name: picked.clone() }, true));
                }
            }
            let label = |app: &SoundApp, quiet: bool, listed: &[(SoundApp, bool)]| {
                let name = app_name(&app.name);
                let named = if listed.iter().filter(|(other, _)| other.name == app.name).count() > 1 { format!("{name} ({})", app.id) } else { name };
                if quiet { format!("{named}, once it plays") } else { named }
            };
            let key = source.as_ref().map(|source| source.id.clone()).unwrap_or_default();
            let choose = |value: String, picker: Entity<ScreenPicker>, key: String| -> Rc<dyn Fn(&mut Window, &mut App)> {
                Rc::new(move |_, cx| {
                    let (value, key) = (value.clone(), key.clone());
                    picker.update(cx, |picker, cx| {
                        picker.sound_pick = Some((key, value));
                        cx.notify();
                    })
                })
            };
            let me = cx.entity();
            let mut choices: Vec<(String, Rc<dyn Fn(&mut Window, &mut App)>)> = vec![("No sound".into(), choose(String::new(), me.clone(), key.clone())), ("Entire system".into(), choose("everything".into(), me.clone(), key.clone()))];
            for (app, quiet) in &listed {
                choices.push((label(app, *quiet, &listed), choose(format!("app:{}", app.id), me.clone(), key.clone())));
            }
            let current = match pick.as_str() {
                "" => "No sound".to_string(),
                "everything" => "Entire system".to_string(),
                _ => listed.iter().find(|(app, _)| Some(&app.id) == picked.as_ref()).map(|(app, quiet)| label(app, *quiet, &listed)).unwrap_or_default(),
            };
            let picked_name = listed.iter().find(|(app, _)| Some(&app.id) == picked.as_ref()).map(|(app, _)| app.name.clone());
            let hint = if pick == "everything" {
                "Everything your computer plays, apart from Zuna, so nobody hears themselves back.".to_string()
            } else if let Some(name) = picked_name {
                format!("Only what {} plays.", app_name(&name))
            } else {
                "Apps show here while they play sound.".to_string()
            };
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child("Sound"))
                    .child(select_box("screen-sound", current, choices, cx))
                    .child(div().text_size(px(12.5)).text_color(theme.text3).child(hint))
                    .into_any_element(),
            );
        }
        let settings_state = self.state.clone();
        body.push(
            div()
                .id("screen-more")
                .text_size(px(12.5))
                .text_color(theme.text2)
                .underline()
                .cursor_pointer()
                .hover(|style| style.text_color(theme.text1))
                .on_click(move |_, _, cx| settings_state.update(cx, |state, cx| state.set_overlay(Some(Overlay::Settings { section: Some("screen".into()) }), cx)))
                .child("More screen sharing settings")
                .into_any_element(),
        );
        let can_share = !self.starting && self.sources.is_some() && source.is_some() && program;
        let footer = div()
            .flex()
            .justify_end()
            .gap(px(8.))
            .px(px(20.))
            .pb(px(16.))
            .child(button("screen-cancel", ButtonKind::Default, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|picker, _, window, cx| picker.close(window, cx))))
            .child(button("screen-share", ButtonKind::Primary, ButtonSize::Normal, !can_share, cx).child(if self.starting { spinner(15., theme.on_accent).into_any_element() } else { div().child("Share").into_any_element() }).when(can_share, |el| el.on_click(cx.listener(|picker, _, window, cx| picker.start(window, cx)))));
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
            .track_focus(&self.focus)
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|picker, _, window, cx| picker.close(window, cx)))
            .on_key_down(cx.listener(|picker, event: &gpui::KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    picker.close(window, cx);
                }
            }))
            .child(
                div()
                    .id("modal")
                    .w_full()
                    .max_w(px(640.))
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
                    .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .pt(px(16.))
                            .pr(px(16.))
                            .pb(px(4.))
                            .pl(px(20.))
                            .child(div().flex_1().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).child("Share your screen"))
                            .child(icon_button("close-modal", "x", 16., true, false, cx).on_click(cx.listener(|picker, _, window, cx| picker.close(window, cx)))),
                    )
                    .child({
                        let handle = scroll_handle("screen-picker-body");
                        div().id("modal-body").overflow_y_scroll().track_scroll(&handle).px(px(20.)).pr(px(20.) + gutter(&handle)).pt(px(10.)).pb(px(20.)).flex().flex_col().gap(px(14.)).children(body).child(scrollbar("screen-picker-body", Scrolls::Div(handle.clone())))
                    })
                    .child(footer),
            )
    }
}
