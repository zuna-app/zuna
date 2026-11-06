//! Settings' Voice and video and Screen sharing pages (VoiceSettings.tsx, ScreenSettings.tsx).

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui::{AnyElement, App, Context, Entity, FontWeight, IntoElement, ParentElement, Render, RenderImage, SharedString, Styled, Task, Window, div, img, prelude::*, px};
use parking_lot::Mutex;

use super::components::*;
use super::screen_picker::number_select;
use super::settings::SettingsView;
use crate::models::ScreenRules;
use crate::state::AppState;
use crate::theme::{self, RADIUS_M, RADIUS_S};
use crate::voice::rules::{Held, ScreenChoices, screen_terms};
use crate::voice::settings::{SCREEN_BITRATES, SCREEN_HEIGHTS, SCREEN_RATES, SCREEN_SOUND_BITRATES, VoiceSettings, bitrate_name, height_name, key_name, rate_name, screen_limits_text};
use crate::voice::{Voice, VoiceStatus};

/// The dB the meter shows, from silence on the left to loud on the right.
const METER_FLOOR: f32 = -80.;

fn percent(level: f32) -> f32 {
    ((level - METER_FLOOR) / -METER_FLOOR).clamp(0., 1.)
}

const NOISE_CHOICES: [(&str, &str, &str); 3] = [
    ("zuna", "Noise cancelling", "Takes out fans, keyboards and traffic, right on this device."),
    ("standard", "Standard", "WebRTC's own, lighter and less thorough."),
    ("off", "Off", "For a good microphone in a quiet room."),
];

fn label_with(label: &str, value: String, cx: &App) -> AnyElement {
    let theme = theme(cx);
    div().flex().gap(px(4.)).text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(label.to_string()).child(div().text_color(theme.text1).child(value)).into_any_element()
}

fn field(label: AnyElement, control: impl IntoElement, hint: Option<&str>, cx: &App) -> AnyElement {
    let theme = theme(cx);
    div().flex().flex_col().gap(px(6.)).child(label).child(control).when_some(hint, |el, hint| el.child(div().text_size(px(12.5)).text_color(theme.text3).child(hint.to_string()))).into_any_element()
}

/// A heading within a page, as `.settings-subhead` draws it: small, in capitals.
fn subhead(text: &str) -> AnyElement {
    div().mt(px(8.)).text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(crate::theme::color(crate::theme::hex(0x6e6e75))).child(text.to_uppercase()).into_any_element()
}

fn plain_label(text: &str, cx: &App) -> AnyElement {
    let theme = theme(cx);
    div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.text2).child(text.to_string()).into_any_element()
}

/// A choice among a few, drawn as `.segmented`, with those in `disabled` greyed out.
fn segmented(id: &'static str, value: &str, options: &[(&'static str, &'static str)], disabled: &[&str], on_change: Rc<dyn Fn(&'static str, &mut App)>, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let mut row = div().flex().bg(theme.bg3).rounded(RADIUS_M).p(px(2.)).gap(px(1.));
    for (option, label) in options {
        let active = value == *option;
        let (on_change, option) = (on_change.clone(), *option);
        let off = disabled.contains(&option);
        row = row.child(
            div()
                .id(SharedString::from(format!("{id}-{option}")))
                .px(px(11.))
                .py(px(4.))
                .rounded(RADIUS_S)
                .text_size(px(13.))
                .text_color(if active { theme.text1 } else { theme.text2 })
                .when(active, |el| el.bg(theme.bg5))
                .when(off, |el| el.opacity(0.45).cursor(gpui::CursorStyle::OperationNotAllowed))
                .when(!off, |el| el.cursor_pointer().on_click(move |_, _, cx| on_change(option, cx)))
                .child(*label),
        );
    }
    row.into_any_element()
}

/// How loud the microphone is, as what the noise suppression lets through, which is what the
/// gate goes by. The bar is green past the point where sound goes out.
fn meter(voice: &Voice, cx: &App) -> gpui::Div {
    let theme = theme(cx);
    let reading = voice.reading().unwrap_or_default();
    let open = reading.open && voice.reading().is_some();
    div()
        .relative()
        .h(px(10.))
        .rounded(px(5.))
        .bg(theme.bg3)
        .overflow_hidden()
        .child(div().absolute().left_0().top_0().bottom_0().w(gpui::relative(if voice.reading().is_some() { percent(reading.level) } else { 0. })).bg(if open { theme.green } else { theme.text3 }))
        .child(div().absolute().right(px(4.)).top(px(3.)).size(px(4.)).rounded_full().bg(if open { theme.green } else { theme.bg5 }))
}

/// The level sound has to pass, as a thin bar over the meter that's pressed or dragged along it.
fn threshold(meter: gpui::Div, value: f32, on_change: impl Fn(f32, &mut App) + 'static, cx: &App) -> AnyElement {
    let theme = theme(cx);
    let bounds = Rc::new(std::cell::Cell::new(gpui::Bounds::<gpui::Pixels>::default()));
    let measured = bounds.clone();
    let on_change = Rc::new(on_change);
    let (press, drag) = (on_change.clone(), on_change);
    let (press_bounds, drag_bounds) = (bounds.clone(), bounds);
    let at = |bounds: gpui::Bounds<gpui::Pixels>, x: gpui::Pixels| if bounds.size.width > px(0.) { ((x - bounds.left()) / bounds.size.width).clamp(0., 1.) } else { 0. };
    div()
        .id("sensitivity")
        .relative()
        .h(px(18.))
        .cursor_pointer()
        .child(gpui::canvas(move |area, _, _| measured.set(area), |_, _, _, _| {}).absolute().inset_0())
        .child(div().absolute().left_0().right_0().top(px(4.)).child(meter))
        .child(div().absolute().left(gpui::relative(value.clamp(0., 1.))).ml(px(-2.)).top_0().w(px(4.)).h(px(18.)).rounded(px(2.)).bg(theme.accent))
        .on_mouse_down(gpui::MouseButton::Left, move |event, _, cx| press(at(press_bounds.get(), event.position.x), cx))
        .on_mouse_move(move |event, _, cx| {
            if event.pressed_button == Some(gpui::MouseButton::Left) {
                drag(at(drag_bounds.get(), event.position.x), cx);
            }
        })
        .into_any_element()
}

pub struct VoiceSettingsPage {
    state: Entity<AppState>,
    voice: Entity<Voice>,
    choosing_key: bool,
    /// The camera, tried here, and its newest picture.
    camera: Option<(crate::media::record::Camera, Arc<Mutex<Option<(u32, u32, Vec<u8>, u64)>>>)>,
    camera_image: Option<(u64, Arc<RenderImage>)>,
    retired: Vec<Arc<RenderImage>>,
    _tick: Task<()>,
}

impl VoiceSettingsPage {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let voice = crate::voice::get(cx).expect("voice starts with the app");
        cx.observe(&voice, |_, _, cx| cx.notify()).detach();
        // The meter and the camera are drawn as they change.
        let tick = cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(50)).await;
            let alive = this
                .update(cx, |page, cx| {
                    let voice = page.voice.read(cx);
                    if voice.status != VoiceStatus::Idle || voice.testing_mic() || page.camera.is_some() {
                        cx.notify();
                    }
                })
                .is_ok();
            if !alive {
                break;
            }
        });
        // Whether a key held in another window can be heard, which the system may not allow.
        let (told, answered) = futures::channel::oneshot::channel::<()>();
        crate::platform::ptt::check_support(move || {
            told.send(()).ok();
        });
        cx.spawn(async move |this, cx| {
            if answered.await.is_ok() {
                this.update(cx, |_, cx| cx.notify()).ok();
            }
        })
        .detach();
        VoiceSettingsPage { state, voice, choosing_key: false, camera: None, camera_image: None, retired: Vec::new(), _tick: tick }
    }

    fn update(&self, change: impl FnOnce(&mut VoiceSettings) + 'static, cx: &mut App) {
        self.voice.update(cx, |voice, cx| voice.update_settings(change, cx));
    }

    fn device_select(&self, id: &'static str, label: &str, input: bool, current: &str, cx: &mut Context<Self>) -> AnyElement {
        let devices = crate::voice::audio::devices(input);
        let shown = devices.iter().find(|device| device.id == current).map(|device| device.name.clone()).unwrap_or_else(|| "Default".into());
        let choices = devices
            .into_iter()
            .map(|device| {
                let (voice, id) = (self.voice.clone(), device.id.clone());
                let action: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |_, cx| {
                    let id = id.clone();
                    voice.update(cx, |voice, cx| voice.update_settings(move |settings| if input { settings.input_device = id } else { settings.output_device = id }, cx));
                });
                (device.name, action)
            })
            .collect();
        field(plain_label(label, cx), select_box(id, shown, choices, cx), None, cx)
    }

    fn camera_select(&self, current: &str, cx: &mut Context<Self>) -> AnyElement {
        let cameras = crate::media::record::cameras();
        let shown = cameras.iter().find(|camera| camera.id == current).map(|camera| camera.name.clone()).unwrap_or_else(|| "Default".into());
        let choices = cameras
            .into_iter()
            .map(|camera| {
                let (voice, id) = (self.voice.clone(), camera.id.clone());
                let action: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |_, cx| {
                    let id = id.clone();
                    voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.camera_device = id, cx));
                });
                (camera.name, action)
            })
            .collect();
        field(plain_label("Camera", cx), select_box("camera-device", shown, choices, cx), None, cx)
    }

    fn slider_field(&self, id: &'static str, label: &str, value: String, fraction: f32, hint: Option<&str>, on_change: impl Fn(f32, &mut App) + 'static, cx: &mut Context<Self>) -> AnyElement {
        field(label_with(label, value, cx), slider(id, fraction, move |fraction, _, cx| on_change(fraction, cx), cx), hint, cx)
    }

    fn choose_key(&mut self, cx: &mut Context<Self>) {
        if self.choosing_key {
            self.choosing_key = false;
            crate::platform::ptt::stop_choosing();
            cx.notify();
            return;
        }
        self.choosing_key = true;
        let (sender, receiver) = futures::channel::oneshot::channel::<String>();
        crate::platform::ptt::choose(move |code| {
            sender.send(code).ok();
        });
        cx.spawn(async move |this, cx| {
            if let Ok(code) = receiver.await {
                this.update(cx, |page, cx| {
                    page.choosing_key = false;
                    if code != "Escape" {
                        page.update(move |settings| settings.ptt_key = code, cx);
                    }
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        cx.notify();
    }

    fn toggle_camera(&mut self, cx: &mut Context<Self>) {
        if self.camera.take().is_some() {
            if let Some((_, image)) = self.camera_image.take() {
                self.retired.push(image);
            }
            cx.notify();
            return;
        }
        let latest: Arc<Mutex<Option<(u32, u32, Vec<u8>, u64)>>> = Arc::default();
        let writing = latest.clone();
        let device = self.voice.read(cx).settings.camera_device.clone();
        let mut serial = 0u64;
        match crate::media::record::Camera::start_feed(&device, 360, move |width, height, bgra| {
            serial += 1;
            *writing.lock() = Some((width, height, bgra, serial));
        }) {
            Ok(camera) => self.camera = Some((camera, latest)),
            Err(error) => self.state.update(cx, |state, cx| state.toast(error, crate::state::ToastKind::Error, cx)),
        }
        cx.notify();
    }

    fn camera_preview(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let frame = self.camera.as_ref().and_then(|(_, latest)| latest.lock().clone());
        if let Some((width, height, mut bgra, serial)) = frame {
            if self.camera_image.as_ref().is_none_or(|(shown, _)| *shown != serial) {
                // As you'd see yourself in a mirror.
                let row = width as usize * 4;
                for line in bgra.chunks_mut(row) {
                    let flipped: Vec<u8> = line.chunks(4).rev().flatten().copied().collect();
                    line.copy_from_slice(&flipped);
                }
                if let Some(buffer) = image::RgbaImage::from_raw(width, height, bgra) {
                    let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(buffer)]));
                    if let Some((_, old)) = self.camera_image.replace((serial, image)) {
                        self.retired.push(old);
                    }
                }
            }
        }
        let content: AnyElement = match (&self.camera, &self.camera_image) {
            (Some(_), Some((_, image))) => img(image.clone()).w_full().max_h(px(260.)).object_fit(gpui::ObjectFit::Contain).rounded(RADIUS_M).into_any_element(),
            (Some(_), None) => spinner(18., theme.text2).into_any_element(),
            (None, _) => button("try-camera", ButtonKind::Default, ButtonSize::Normal, false, cx).child(div().flex().items_center().gap(px(6.)).child(icon("camera", 15., theme.text1)).child("Try your camera")).on_click(cx.listener(|page, _, _, cx| page.toggle_camera(cx))).into_any_element(),
        };
        div()
            .id("camera-preview")
            .flex()
            .items_center()
            .justify_center()
            .min_h(px(54.))
            .rounded(RADIUS_M)
            .bg(theme.bg2)
            .overflow_hidden()
            .when(self.camera.is_some(), |el| el.cursor_pointer().on_click(cx.listener(|page, _, _, cx| page.toggle_camera(cx))))
            .child(content)
            .into_any_element()
    }
}

impl Render for VoiceSettingsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        for old in self.retired.drain(..) {
            window.drop_image(old).ok();
        }
        let voice = self.voice.read(cx);
        let settings = voice.settings.clone();
        let in_call = voice.status != VoiceStatus::Idle;
        let testing = voice.testing_mic();
        let meter_now = meter(voice, cx);
        let mut parts: Vec<AnyElement> = vec![SettingsView::heading("Voice and video", &theme), SettingsView::lead("These are for this device. Everything said in a voice channel is encrypted before it leaves it.".into(), &theme)];
        parts.push(self.device_select("input-device", "Microphone", true, &settings.input_device, cx));
        let voice_entity = self.voice.clone();
        parts.push(self.slider_field("input-volume", "Microphone volume", format!("{}%", (settings.input_volume * 100.).round()), settings.input_volume / 2., None, {
            let voice = voice_entity.clone();
            move |fraction, cx| voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.input_volume = fraction * 2., cx))
        }, cx));
        parts.push(self.device_select("output-device", "Speakers or headphones", false, &settings.output_device, cx));
        parts.push(self.slider_field("output-volume", "Volume", format!("{}%", (settings.output_volume * 100.).round()), settings.output_volume / 2., None, {
            let voice = voice_entity.clone();
            move |fraction, cx| voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.output_volume = fraction * 2., cx))
        }, cx));
        parts.push(self.slider_field(
            "soundboard-volume-setting",
            "Soundboard volume",
            if settings.soundboard_volume == 0. { "off".into() } else { format!("{}%", (settings.soundboard_volume * 100.).round()) },
            settings.soundboard_volume,
            Some("All the way down, no sounds from the soundboard play for you."),
            {
                let voice = voice_entity.clone();
                move |fraction, cx| voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.soundboard_volume = fraction, cx))
            },
            cx,
        ));
        let mode_voice = voice_entity.clone();
        // Where the system can't hear a key held in another window, push to talk can't work.
        let support = crate::platform::ptt::support();
        let no_push_to_talk = support.is_some_and(|support| !support.anywhere);
        let why_not = support.and_then(|support| support.why).filter(|_| no_push_to_talk).map(|why| match why {
            crate::platform::NoKeyWatch::Uninstalled => "Push to talk can't work here: your system only gives global shortcuts to installed apps, and it doesn't see this copy of Zuna as one. Start Zuna from your applications menu, or install the package for your distribution.",
            crate::platform::NoKeyWatch::Compositor => "Your compositor doesn't support push to talk. It has no global shortcuts, so no app can hear a key held while another window is in front.",
        });
        parts.push(field(
            plain_label("When sound goes out", cx),
            div().flex().child(segmented(
                "voice-mode",
                &settings.input_mode,
                &[("voice", "When you talk"), ("ptt", "Push to talk")],
                if no_push_to_talk { &["ptt"] } else { &[] },
                Rc::new(move |mode, cx| mode_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.input_mode = mode.into(), cx))),
                cx,
            )),
            why_not,
            cx,
        ));
        if settings.input_mode == "voice" {
            let auto = settings.auto_sensitivity;
            let auto_voice = voice_entity.clone();
            parts.push(SettingsView::row("Work out what's speech", Some("Listens for speech itself, so you don't have to pick a level."), switch("auto-sensitivity", auto, cx).on_click(move |_, _, cx| auto_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.auto_sensitivity = !auto, cx))), &theme));
            if !auto {
                let sense_voice = voice_entity.clone();
                let fraction = (settings.sensitivity - METER_FLOOR) / -METER_FLOOR;
                parts.push(field(
                    label_with("Only sounds louder than", format!("{} dB", settings.sensitivity), cx),
                    threshold(meter_now, fraction, move |fraction, cx| {
                        let level = (METER_FLOOR + fraction * -METER_FLOOR).round();
                        sense_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.sensitivity = level, cx));
                    }, cx),
                    None,
                    cx,
                ));
            }
        } else {
            let label = if self.choosing_key { "Press a key".to_string() } else { key_name(&settings.ptt_key) };
            let choosing = self.choosing_key;
            // Where the system binds the key itself, it may ask, and give another.
            let key_hint = if support.is_some_and(|support| !support.mouse) {
                let bound = self.voice.read(cx).key_bound.as_ref().map(|key| format!(" It's {key} now.")).unwrap_or_default();
                format!("Works whichever window you're in. Your system asks you to confirm the key, and may let you choose another.{bound}")
            } else {
                "Works whichever window you're in.".into()
            };
            parts.push(SettingsView::row(
                "Key to hold",
                Some(&key_hint),
                button("ptt-key", ButtonKind::Default, ButtonSize::Normal, false, cx).min_w(px(150.)).when(choosing, |el| el.border_1().border_color(theme.accent)).child(label).on_click(cx.listener(|page, _, _, cx| page.choose_key(cx))),
                &theme,
            ));
            let release_voice = voice_entity.clone();
            parts.push(self.slider_field("ptt-release", "Keep going after you let go", format!("{} ms", settings.ptt_release as u32), settings.ptt_release / 1000., None, move |fraction, cx| {
                let value = (fraction * 100.).round() * 10.;
                release_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.ptt_release = value, cx));
            }, cx));
        }
        if settings.input_mode != "voice" || settings.auto_sensitivity {
            parts.push(field(plain_label("How your microphone sounds", cx), meter(self.voice.read(cx), cx), None, cx));
        }
        if !in_call {
            let test_voice = voice_entity.clone();
            parts.push(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(button("mic-test", ButtonKind::Default, ButtonSize::Normal, false, cx).child(if testing { "Stop" } else { "Test your microphone" }).on_click(move |_, _, cx| test_voice.update(cx, |voice, cx| voice.toggle_mic_test(cx))))
                    .when(testing, |el| el.child(div().text_size(px(12.5)).text_color(theme.text3).child("You're hearing what others would.")))
                    .when(!testing, |el| el.child(div().text_size(px(12.5)).text_color(theme.text3).child("Use headphones, or you'll hear yourself twice.")))
                    .into_any_element(),
            );
        }
        let mut noise = div().flex().flex_col().gap(px(6.));
        for (id, label, hint) in NOISE_CHOICES {
            let active = settings.noise_suppression == id;
            let noise_voice = voice_entity.clone();
            noise = noise.child(
                div()
                    .id(SharedString::from(format!("noise-{id}")))
                    .px(px(11.))
                    .py(px(9.))
                    .rounded(RADIUS_M)
                    .border_1()
                    .border_color(if active { theme.accent } else { theme.line })
                    .when(active, |el| el.bg(theme.accent_soft))
                    .when(!active, |el| el.hover(move |style| style.bg(theme.hover)))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| noise_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.noise_suppression = id.into(), cx)))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::MEDIUM).child(label))
                    .child(div().text_size(px(12.5)).text_color(theme.text2).child(hint)),
            );
        }
        parts.push(field(plain_label("Background noise", cx), noise, None, cx));
        let toggle_row = |id: &'static str, title: &'static str, hint: &'static str, on: bool, set: fn(&mut VoiceSettings, bool), voice: Entity<Voice>, cx: &mut Context<Self>| {
            SettingsView::row(title, Some(hint), switch(id, on, cx).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.update_settings(move |settings| set(settings, !on), cx))), &theme)
        };
        parts.push(toggle_row("echo", "Echo cancellation", "Stops others hearing themselves through your speakers.", settings.echo_cancellation, |settings, on| settings.echo_cancellation = on, voice_entity.clone(), cx));
        parts.push(toggle_row("auto-gain", "Automatic volume", "Keeps your voice at about the same level.", settings.auto_gain, |settings, on| settings.auto_gain = on, voice_entity.clone(), cx));
        parts.push(self.camera_select(&settings.camera_device, cx));
        parts.push(self.camera_preview(cx));
        parts.push(toggle_row("voice-sounds", "Sounds", "When people come and go, and when you mute.", settings.sounds, |settings, on| settings.sounds = on, voice_entity.clone(), cx));
        parts.push(toggle_row("start-muted", "Come in muted", "Starts every voice channel with your microphone off.", settings.start_muted, |settings, on| settings.start_muted = on, voice_entity, cx));
        div().flex().flex_col().gap(px(14.)).children(parts)
    }
}

/// How this device shares a screen and watches others', within what its server allows.
pub struct ScreenSettingsPage {
    state: Entity<AppState>,
    voice: Entity<Voice>,
}

impl ScreenSettingsPage {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let voice = crate::voice::get(cx).expect("voice starts with the app");
        cx.observe(&voice, |_, _, cx| cx.notify()).detach();
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        ScreenSettingsPage { state, voice }
    }
}

impl Render for ScreenSettingsPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let voice = self.voice.read(cx);
        let settings = voice.settings.clone();
        let app = self.state.read(cx);
        // The server of the call this device is in, or else the one open.
        let server = voice.server_id.as_ref().and_then(|id| app.servers.get(id)).or_else(|| app.active()).cloned();
        let rules = server.as_ref().and_then(|server| server.info.as_ref()).and_then(|info| info.screen_share.clone());
        let role = server.as_ref().and_then(|server| server.me.as_ref()).map(|me| me.role.clone()).unwrap_or_default();
        let shown = rules.clone().unwrap_or_default();
        let exempt = shown.admins_exempt && (role == "owner" || role == "admin");
        let limit = |value: u32| if exempt { 0 } else { value };
        let terms = screen_terms(&ScreenChoices { height: settings.screen_height, fps: settings.screen_fps, kbps: settings.screen_bitrate, sound_kbps: settings.screen_sound_kbps }, rules.as_ref(), &role);
        let suggested = screen_terms(&ScreenChoices { height: None, fps: None, kbps: None, sound_kbps: settings.screen_sound_kbps }, rules.as_ref(), &role);
        let limits = screen_limits_text(rules.as_ref(), &role);
        let set = |voice: &Entity<Voice>, change: Rc<dyn Fn(&mut VoiceSettings, Option<u32>)>| -> Rc<dyn Fn(Option<u32>, &mut Window, &mut App)> {
            let voice = voice.clone();
            Rc::new(move |value, _, cx| {
                let change = change.clone();
                voice.update(cx, |voice, cx| voice.update_settings(move |settings| change(settings, value), cx));
            })
        };
        let hint_text = |text: String| div().text_size(px(12.5)).text_color(theme.text3).child(text).into_any_element();
        let held_note = |text: &str| div().text_size(px(12.5)).text_color(theme.text2).child(text.to_string()).into_any_element();
        let mut parts: Vec<AnyElement> = vec![SettingsView::heading("Screen sharing", &theme), SettingsView::lead("These are for this device. Whatever you share is encrypted before it leaves it.".into(), &theme)];
        if let Some(limits) = &limits {
            parts.push(held_note(limits));
        }
        parts.push(subhead("Picture"));
        parts.push(number_select("screen-size-setting", "Size", settings.screen_height, &[0, 2160, 1440, 1080, 720, 480, 360], height_name, Some(format!("Server's choice ({})", height_name(suggested.height))), limit(shown.max_height), set(&self.voice, Rc::new(|settings, value| settings.screen_height = value)), cx));
        parts.push(hint_text(if terms.held.contains(&Held::Height) { format!("Sent at up to {}, which is this server's limit.", height_name(terms.height)) } else { "A larger screen is made smaller to fit, keeping its shape.".into() }));
        parts.push(number_select("screen-rate-setting", "Frame rate", settings.screen_fps, &SCREEN_RATES, rate_name, Some(format!("Server's choice ({})", rate_name(suggested.fps))), limit(shown.max_fps), set(&self.voice, Rc::new(|settings, value| settings.screen_fps = value)), cx));
        if terms.held.contains(&Held::Fps) {
            parts.push(hint_text(format!("Sent at {}, which is this server's limit.", rate_name(terms.fps))));
        }
        parts.push(number_select("screen-bitrate-setting", "Most it may send", settings.screen_bitrate, &SCREEN_BITRATES, bitrate_name, Some(format!("Server's choice ({})", bitrate_name(suggested.kbps))), limit(shown.max_kbps), set(&self.voice, Rc::new(|settings, value| settings.screen_bitrate = value)), cx));
        parts.push(hint_text(if terms.held.contains(&Held::Kbps) { format!("Sent at up to {}, which is this server's limit.", bitrate_name(terms.kbps)) } else { "It sends less when your connection or the screen doesn't need that much.".into() }));
        let _ = SCREEN_HEIGHTS;
        parts.push(subhead("Sound"));
        if shown.sound {
            let on = settings.screen_sound_by_default;
            let voice = self.voice.clone();
            parts.push(SettingsView::row("Start with sound on", Some("A screen starts with everything your computer plays, apart from this call, and a window with its app's sound where Zuna can tell which that is. You can still change it each time."), switch("sound-default", on, cx).on_click(move |_, _, cx| voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_sound_by_default = !on, cx))), &theme));
            parts.push(number_select("sound-quality", "Sound quality", Some(settings.screen_sound_kbps), &SCREEN_SOUND_BITRATES, bitrate_name, None, limit(shown.max_sound_kbps), set(&self.voice, Rc::new(|settings, value| settings.screen_sound_kbps = value.unwrap_or(128))), cx));
        } else {
            parts.push(held_note("This server doesn't let sound go with a share."));
        }
        parts.push(subhead("On your graphics card"));
        let cursor = settings.screen_cursor;
        let cursor_voice = self.voice.clone();
        parts.push(SettingsView::row("Show your pointer", None, switch("screen-cursor", cursor, cx).on_click(move |_, _, cx| cursor_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_cursor = !cursor, cx))), &theme));
        let encoders: [(&str, &str); 4] = [("auto", "Automatic: the card driving the screen"), ("h264_nvenc", "NVIDIA (NVENC)"), ("h264_amf", "AMD (AMF)"), ("h264_mf", "Intel or another (Media Foundation)")];
        let current = encoders.iter().find(|(id, _)| *id == settings.screen_encoder).map(|(_, name)| name.to_string()).unwrap_or_else(|| encoders[0].1.into());
        let choices = encoders
            .iter()
            .map(|(id, name)| {
                let (voice, id) = (self.voice.clone(), id.to_string());
                let action: Rc<dyn Fn(&mut Window, &mut App)> = Rc::new(move |_, cx| {
                    let id = id.clone();
                    voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_encoder = id, cx));
                });
                (name.to_string(), action)
            })
            .collect();
        parts.push(field(plain_label("Encoder", cx), select_box("screen-encoder", current, choices, cx), Some("If this one can't be used, your share doesn't start, and says why."), cx));
        let effort_voice = self.voice.clone();
        parts.push(SettingsView::row("Effort per frame", Some("More effort looks better at the same bitrate, and can drop frames at large sizes."), segmented("screen-effort", &settings.screen_effort, &[("speed", "Fastest"), ("balanced", "Balanced"), ("best", "Best picture")], &[], Rc::new(move |effort, cx| effort_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_effort = effort.into(), cx))), cx), &theme));
        let key_voice = self.voice.clone();
        parts.push(field(
            label_with("A full picture every", format!("{} s", settings.screen_keyframes), cx),
            slider("screen-keyframes", (settings.screen_keyframes.saturating_sub(1)) as f32 / 29., move |fraction, _, cx| {
                let seconds = 1 + (fraction * 29.).round() as u32;
                key_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_keyframes = seconds, cx));
            }, cx),
            Some("Sooner helps anyone who joins or loses packets, and costs some sharpness."),
            cx,
        ));
        parts.push(subhead("Watching"));
        let focus = settings.screen_focus;
        let focus_voice = self.voice.clone();
        parts.push(SettingsView::row("Open a share when it starts", Some("A screen someone starts sharing fills the stage, unless you're already looking at something."), switch("screen-focus", focus, cx).on_click(move |_, _, cx| focus_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_focus = !focus, cx))), &theme));
        let volume_voice = self.voice.clone();
        parts.push(field(label_with("How loud shares are", format!("{}%", (settings.screen_volume * 100.).round()), cx), slider("screen-volume-setting", settings.screen_volume / 2., move |fraction, _, cx| volume_voice.update(cx, |voice, cx| voice.update_settings(move |settings| settings.screen_volume = fraction * 2., cx)), cx), None, cx));
        let _: Option<ScreenRules> = None;
        let _ = theme::RADIUS_L;
        div().flex().flex_col().gap(px(14.)).children(parts)
    }
}
