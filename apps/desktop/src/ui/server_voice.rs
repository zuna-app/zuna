//! A server's Soundboard and Screen sharing sections, for its admins (ServerSoundboardSection
//! in Soundboard.tsx, ServerScreenSection in ScreenSettings.tsx).

use std::path::PathBuf;
use std::rc::Rc;

use gpui::{AnyElement, App, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div, prelude::*, px};
use serde_json::json;

use super::components::*;
use super::text_input::{InputEvent, TextInput};
use super::voice_settings::number_select;
use crate::models::{ScreenRules, SoundView};
use crate::state::{AppState, ToastKind};
use crate::theme::{RADIUS_M, RADIUS_S};
use crate::voice::settings::{SCREEN_HEIGHTS, SCREEN_LIMIT_BITRATES, SCREEN_RATES, bitrate_name, height_name, rate_name};

/// How many sounds a server's soundboard holds.
const MAX_SOUNDS: usize = 50;
/// How much of a picked file becomes a sound, at most, before the core cuts it to five seconds.
const SOUND_INPUT_SECONDS: usize = 20;

fn heading(text: &str) -> AnyElement {
    div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).child(text.to_string()).into_any_element()
}

fn lead(text: &str, cx: &App) -> AnyElement {
    let theme = theme(cx);
    div().mt(px(-8.)).text_size(px(13.5)).text_color(theme.text2).child(text.to_string()).into_any_element()
}

/// What someone picked, as the core makes a sound from: WAV in one channel at 48 kHz, of no more
/// than its first 20 seconds. The core cuts the silence and the rest.
fn sound_from_file(path: &std::path::Path) -> Result<PathBuf, String> {
    let (samples, rate) = crate::media::mf::decode_audio(path).map_err(|_| "That file isn't a sound Zuna can read.".to_string())?;
    if samples.is_empty() || rate == 0 {
        return Err("That file isn't a sound Zuna can read.".into());
    }
    let step = rate as f64 / 48_000.;
    let frames = ((samples.len() as f64 / step) as usize).min(48_000 * SOUND_INPUT_SECONDS);
    let mut pcm: Vec<i16> = Vec::with_capacity(frames);
    for index in 0..frames {
        let position = index as f64 * step;
        let at = position as usize;
        let fraction = (position - at as f64) as f32;
        let (a, b) = (samples[at.min(samples.len() - 1)], samples[(at + 1).min(samples.len() - 1)]);
        pcm.push(((a + (b - a) * fraction).clamp(-1., 1.) * 32767.) as i16);
    }
    let mut wav = Vec::with_capacity(44 + pcm.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + pcm.len() as u32 * 2).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&48_000u32.to_le_bytes());
    wav.extend_from_slice(&96_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32 * 2).to_le_bytes());
    for sample in pcm {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    let out = crate::host::cache_dir().join("media").join(format!("sound-{}.wav", crate::format::now_ms() as u64));
    std::fs::create_dir_all(out.parent().unwrap()).ok();
    std::fs::write(&out, wav).map_err(|error| error.to_string())?;
    Ok(out)
}

pub struct ServerSoundboard {
    state: Entity<AppState>,
    emoji: Entity<TextInput>,
    name: Entity<TextInput>,
    file: Option<PathBuf>,
    busy: bool,
    /// A sound being renamed: its id, and its emoji and name as typed.
    editing: Option<(String, Entity<TextInput>, Entity<TextInput>)>,
    /// A sound waiting to be confirmed for deleting.
    deleting: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl ServerSoundboard {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let emoji = cx.new(|cx| TextInput::new(cx, "🔊"));
        let name = cx.new(|cx| TextInput::new(cx, "Airhorn"));
        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.subscribe_in(&emoji, window, |_, _, _, _, cx| cx.notify()),
            cx.subscribe_in(&name, window, |view, _, event, _, cx| {
                if *event == InputEvent::Submit {
                    view.add(cx);
                }
                cx.notify();
            }),
        ];
        ServerSoundboard { state, emoji, name, file: None, busy: false, editing: None, deleting: None, _subscriptions: subscriptions }
    }

    fn call(&mut self, method: &'static str, args: Vec<serde_json::Value>, done: Option<String>, then: impl FnOnce(&mut Self, &mut Context<Self>) + 'static, cx: &mut Context<Self>) {
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), method, args);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok(_) => {
                        if let Some(done) = done {
                            view.state.update(cx, |state, cx| state.toast(done, ToastKind::Info, cx));
                        }
                        then(view, cx);
                    }
                    Err(error) => view.state.update(cx, |state, cx| state.toast(error.message, ToastKind::Error, cx)),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn choose_file(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |view, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.first().cloned() else { return };
            view.update(cx, |view, cx| {
                if view.name.read(cx).text().trim().is_empty() {
                    let stem: String = path.file_stem().map(|stem| stem.to_string_lossy().chars().take(32).collect()).unwrap_or_default();
                    view.name.update(cx, |input, cx| input.set_text(stem, cx));
                }
                view.file = Some(path);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn add(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.file.clone() else { return };
        let name = self.name.read(cx).text().trim().to_string();
        let emoji = self.emoji.read(cx).text().trim().to_string();
        if name.is_empty() || self.busy {
            return;
        }
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let prepared = cx.background_executor().spawn(async move { sound_from_file(&path) }).await;
            view.update(cx, |view, cx| match prepared {
                Ok(wav) => {
                    view.busy = false;
                    let file = crate::host::file(&wav.to_string_lossy(), "audio/wav");
                    view.call("addSound", vec![file, json!(name.clone()), json!(emoji)], Some(format!("Added {name}")), |view, cx| {
                        view.file = None;
                        view.name.update(cx, |input, cx| input.set_text("", cx));
                        view.emoji.update(cx, |input, cx| input.set_text("", cx));
                    }, cx);
                }
                Err(error) => {
                    view.busy = false;
                    view.state.update(cx, |state, cx| state.toast(error, ToastKind::Error, cx));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn start_editing(&mut self, sound: &SoundView, cx: &mut Context<Self>) {
        let emoji = cx.new(|cx| {
            let mut input = TextInput::new(cx, "🔊");
            input.set_text(sound.emoji.clone(), cx);
            input
        });
        let name = cx.new(|cx| {
            let mut input = TextInput::new(cx, "");
            input.set_text(sound.name.clone(), cx);
            input
        });
        let id = sound.id.clone();
        cx.subscribe(&name, move |view, _, event: &InputEvent, cx| match event {
            InputEvent::Submit => view.save_editing(cx),
            InputEvent::Escape => {
                view.editing = None;
                cx.notify();
            }
            _ => cx.notify(),
        })
        .detach();
        self.editing = Some((id, emoji, name));
        cx.notify();
    }

    fn save_editing(&mut self, cx: &mut Context<Self>) {
        let Some((id, emoji, name)) = &self.editing else { return };
        let (id, emoji, name) = (id.clone(), emoji.read(cx).text().trim().to_string(), name.read(cx).text().trim().to_string());
        if name.is_empty() {
            return;
        }
        self.call("updateSound", vec![json!(id), json!({ "name": name, "emoji": emoji })], None, |view, cx| {
            view.editing = None;
            cx.notify();
        }, cx);
    }

    fn row(&mut self, sound: &SoundView, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        if let Some((id, emoji, name)) = self.editing.clone() {
            if id == sound.id {
                let can_save = !name.read(cx).text().trim().is_empty() && !self.busy;
                return div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .p(px(6.))
                    .rounded(RADIUS_M)
                    .bg(theme.bg2)
                    .child(div().w(px(64.)).flex_none().child(field(None, emoji, None, None, false, None, cx)))
                    .child(div().flex_1().min_w_0().child(field(None, name, None, None, false, None, cx)))
                    .child(button(SharedString::from(format!("cancel-{}", sound.id)), ButtonKind::Default, ButtonSize::Normal, false, cx).child("Cancel").on_click(cx.listener(|view, _, _, cx| {
                        view.editing = None;
                        cx.notify();
                    })))
                    .child(button(SharedString::from(format!("save-{}", sound.id)), ButtonKind::Primary, ButtonSize::Normal, !can_save, cx).child("Save").when(can_save, |el| el.on_click(cx.listener(|view, _, _, cx| view.save_editing(cx)))))
                    .into_any_element();
            }
        }
        if self.deleting.as_deref() == Some(sound.id.as_str()) {
            let id = sound.id.clone();
            return div()
                .flex()
                .items_center()
                .gap(px(10.))
                .min_h(px(44.))
                .pl(px(12.))
                .pr(px(6.))
                .py(px(4.))
                .rounded(RADIUS_M)
                .bg(theme.bg2)
                .text_size(px(13.5))
                .child(div().flex_1().min_w_0().child(format!("Delete {}? It goes from everyone's soundboard.", sound.name)))
                .child(button(SharedString::from(format!("keep-{}", sound.id)), ButtonKind::Default, ButtonSize::Small, false, cx).child("Cancel").on_click(cx.listener(|view, _, _, cx| {
                    view.deleting = None;
                    cx.notify();
                })))
                .child(button(SharedString::from(format!("delete-{}", sound.id)), ButtonKind::Danger, ButtonSize::Small, self.busy, cx).child("Delete").on_click(cx.listener(move |view, _, _, cx| {
                    view.deleting = None;
                    view.call("deleteSound", vec![json!(id.clone())], None, |_, _| {}, cx);
                })))
                .into_any_element();
        }
        let (listen, rename, delete) = (sound.clone(), sound.clone(), sound.id.clone());
        let server_id = self.state.read(cx).active_server.clone().unwrap_or_default();
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .min_h(px(44.))
            .pl(px(12.))
            .pr(px(6.))
            .py(px(4.))
            .rounded(RADIUS_M)
            .bg(theme.bg2)
            .text_size(px(13.5))
            .child(div().w(px(22.)).flex_none().text_center().text_size(px(17.)).child(if sound.emoji.is_empty() { "🔊".to_string() } else { sound.emoji.clone() }))
            .child(div().flex_1().min_w_0().one_line().child(sound.name.clone()))
            .child(div().text_size(px(12.5)).text_color(theme.text3).child(format!("{:.1} s", sound.duration_ms / 1000.)))
            .child(icon_button(SharedString::from(format!("listen-{}", sound.id)), "play", 15., true, false, cx).tip("Listen", Side::Bottom).on_click(move |_, _, cx| {
                if let Some(voice) = crate::voice::get(cx) {
                    let (server_id, id) = (server_id.clone(), listen.id.clone());
                    voice.update(cx, |voice, cx| voice.preview_sound(server_id, id, cx));
                }
            }))
            .child(icon_button(SharedString::from(format!("rename-{}", sound.id)), "pencil", 15., true, false, cx).tip("Rename", Side::Bottom).on_click(cx.listener(move |view, _, _, cx| view.start_editing(&rename, cx))))
            .child(icon_button(SharedString::from(format!("remove-{}", sound.id)), "trash", 15., true, false, cx).tip("Delete", Side::Bottom).on_click(cx.listener(move |view, _, _, cx| {
                view.deleting = Some(delete.clone());
                cx.notify();
            })))
            .into_any_element()
    }
}

impl Render for ServerSoundboard {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let sounds = self.state.read(cx).active().map(|server| server.sounds.clone()).unwrap_or_default();
        let full = sounds.len() >= MAX_SOUNDS;
        let can_add = self.file.is_some() && !self.name.read(cx).text().trim().is_empty() && !self.busy && !full;
        let file_label = self.file.as_ref().and_then(|path| path.file_name()).map(|name| name.to_string_lossy().to_string());
        let mut parts = vec![
            heading("Soundboard"),
            lead("Sounds anyone in a voice channel or a call can play to everyone there. Each is cut to five seconds and made about as loud as the rest. What they're called and how they sound are encrypted, so the server can't hear them.", cx),
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(div().flex().gap(px(10.)).child(div().w(px(96.)).flex_none().child(field(Some("Emoji"), self.emoji.clone(), None, None, false, None, cx))).child(div().flex_1().min_w_0().child(field(Some("Name"), self.name.clone(), None, None, false, None, cx))))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(button("choose-sound", ButtonKind::Default, ButtonSize::Normal, false, cx).max_w(px(260.)).child(div().min_w_0().one_line().child(file_label.unwrap_or_else(|| "Choose a sound".into()))).on_click(cx.listener(|view, _, _, cx| view.choose_file(cx))))
                        .child(button("add-sound", ButtonKind::Primary, ButtonSize::Normal, !can_add, cx).child(if self.busy { spinner(15., theme.on_accent).into_any_element() } else { div().flex().items_center().gap(px(6.)).child(icon("plus", 15., theme.on_accent)).child("Add sound").into_any_element() }).when(can_add, |el| el.on_click(cx.listener(|view, _, _, cx| view.add(cx))))),
                )
                .child(div().text_size(px(12.5)).text_color(theme.text3).child(if full { "The soundboard is full. Delete a sound to add another.".to_string() } else { format!("{} of {MAX_SOUNDS} sounds.", sounds.len()) }))
                .into_any_element(),
        ];
        if !sounds.is_empty() {
            let mut list = div().flex().flex_col().gap(px(3.)).mt(px(6.));
            for sound in &sounds {
                list = list.child(self.row(sound, cx));
            }
            parts.push(list.into_any_element());
        }
        let _ = RADIUS_S;
        div().flex().flex_col().gap(px(14.)).children(parts)
    }
}

/// What this server allows and suggests for sharing a screen, for its admins.
pub struct ServerScreenRules {
    state: Entity<AppState>,
    rules: ScreenRules,
    per_channel: Entity<TextInput>,
    per_server: Entity<TextInput>,
    busy: bool,
    _subscriptions: Vec<Subscription>,
}

impl ServerScreenRules {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let rules = state.read(cx).active().and_then(|server| server.info.as_ref()).and_then(|info| info.screen_share.clone()).unwrap_or_default();
        let number = |cx: &mut Context<Self>, value: u32| {
            cx.new(|cx| {
                let mut input = TextInput::new(cx, "0");
                input.set_text(value.to_string(), cx);
                input
            })
        };
        let per_channel = number(cx, rules.max_per_channel);
        let per_server = number(cx, rules.max_per_server);
        let subscriptions = vec![cx.subscribe_in(&per_channel, window, |_, _, _, _, cx| cx.notify()), cx.subscribe_in(&per_server, window, |_, _, _, _, cx| cx.notify())];
        ServerScreenRules { state, rules, per_channel, per_server, busy: false, _subscriptions: subscriptions }
    }

    fn change(&self, change: impl Fn(&mut ScreenRules, Option<u32>) + 'static, cx: &mut Context<Self>) -> Rc<dyn Fn(Option<u32>, &mut Window, &mut App)> {
        let me = cx.entity();
        let change = Rc::new(change);
        Rc::new(move |value, _, cx| {
            let change = change.clone();
            me.update(cx, |view, cx| {
                change(&mut view.rules, value);
                cx.notify();
            })
        })
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        let count = |text: &str| text.trim().parse::<f64>().map(|value| value.max(0.).floor() as u32).unwrap_or(0);
        let mut rules = self.rules.clone();
        rules.max_per_channel = count(self.per_channel.read(cx).text()).min(99);
        rules.max_per_server = count(self.per_server.read(cx).text()).min(1000);
        let Some(server) = self.state.read(cx).active_server.clone() else { return };
        let call = self.state.read(cx).core.call(Some(&server), "updateServerSettings", vec![json!({ "screen_share": rules })]);
        self.busy = true;
        cx.notify();
        cx.spawn(async move |view, cx| {
            let result = call.await;
            view.update(cx, |view, cx| {
                view.busy = false;
                view.state.update(cx, |state, cx| match result {
                    Ok(_) => state.toast("Saved", ToastKind::Info, cx),
                    Err(error) => state.toast(error.message, ToastKind::Error, cx),
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for ServerScreenRules {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let rules = self.rules.clone();
        let voice_ready = self.state.read(cx).active().and_then(|server| server.info.as_ref()).is_some_and(|info| info.voice.is_some_and(|voice| voice > 0.));
        let note = |text: &str| div().text_size(px(12.5)).text_color(theme.text2).child(text.to_string()).into_any_element();
        let subhead = |text: &str| div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.text3).mt(px(8.)).child(text.to_uppercase()).into_any_element();
        let row = |title: &str, hint: Option<&str>, control: AnyElement| super::settings::SettingsView::row(title, hint, control, &theme);
        let me = cx.entity();
        let who_options = [("everyone", "Everyone"), ("admins", "Admins"), ("nobody", "Nobody")];
        let mut who = div().flex().bg(theme.bg3).rounded(RADIUS_M).p(px(2.)).gap(px(1.));
        for (id, label) in who_options {
            let active = rules.who == id;
            let me = me.clone();
            who = who.child(
                div()
                    .id(SharedString::from(format!("who-{id}")))
                    .px(px(11.))
                    .py(px(4.))
                    .rounded(RADIUS_S)
                    .text_size(px(13.))
                    .text_color(if active { theme.text1 } else { theme.text2 })
                    .when(active, |el| el.bg(theme.bg5))
                    .cursor_pointer()
                    .on_click(move |_, _, cx| {
                        me.update(cx, |view, cx| {
                            view.rules.who = id.into();
                            cx.notify();
                        })
                    })
                    .child(label),
            );
        }
        let sound = rules.sound;
        let exempt = rules.admins_exempt;
        let (sound_me, exempt_me) = (me.clone(), me.clone());
        let mut parts = vec![heading("Screen sharing"), lead("Screen shares are end-to-end encrypted, so the server never sees them.", cx)];
        if !voice_ready {
            parts.push(div().text_size(px(13.)).text_color(theme.amber).bg(theme.amber_soft).rounded(RADIUS_M).px(px(10.)).py(px(8.)).child("This server has no media server yet, so nobody can join voice channels. Whoever runs it can set up LiveKit (see SELF_HOSTING.md).").into_any_element());
        }
        parts.push(subhead("Permissions"));
        parts.push(row("Who can share", Some("Changing this stops shares it no longer allows."), who.into_any_element()));
        parts.push(row("Allow audio", Some("Turning it off stops shares with audio."), switch("rules-sound", sound, cx).on_click(move |_, _, cx| sound_me.update(cx, |view, cx| {
            view.rules.sound = !sound;
            cx.notify();
        })).into_any_element()));
        parts.push(field(Some("Max shares per voice channel"), self.per_channel.clone(), None, Some("0 for no limit. Each voice channel can set its own.".into()), false, None, cx).into_any_element());
        parts.push(field(Some("Max shares on the server"), self.per_server.clone(), None, Some("0 for no limit.".into()), false, None, cx).into_any_element());
        let with_zero = |options: &[u32]| -> Vec<u32> { std::iter::once(0).chain(options.iter().copied()).collect() };
        parts.push(subhead("Quality limits"));
        parts.push(number_select("max-height", "Max resolution", Some(rules.max_height), &with_zero(&SCREEN_HEIGHTS), |value| if value == 0 { "No limit".into() } else { height_name(value) }, None, 0, self.change(|rules, value| rules.max_height = value.unwrap_or(0), cx), cx));
        parts.push(number_select("max-fps", "Max frame rate", Some(rules.max_fps), &with_zero(&SCREEN_RATES), |value| if value == 0 { "No limit".into() } else { rate_name(value) }, None, 0, self.change(|rules, value| rules.max_fps = value.unwrap_or(0), cx), cx));
        parts.push(number_select("max-kbps", "Max bitrate", Some(rules.max_kbps), &with_zero(&SCREEN_LIMIT_BITRATES), |value| if value == 0 { "No limit".into() } else { bitrate_name(value) }, None, 0, self.change(|rules, value| rules.max_kbps = value.unwrap_or(0), cx), cx));
        parts.push(div().mt(px(-8.)).child(note("Each viewer costs your media server up to this much bandwidth.")).into_any_element());
        parts.push(row("Admins bypass limits", Some("Quality limits and share counts don't apply to admins."), switch("rules-exempt", exempt, cx).on_click(move |_, _, cx| exempt_me.update(cx, |view, cx| {
            view.rules.admins_exempt = !exempt;
            cx.notify();
        })).into_any_element()));
        parts.push(note("Each app keeps to the quality limits itself, since the media server can't see encrypted video. A share already going keeps what it started with."));
        let busy = self.busy;
        parts.push(div().flex().child(button("save-screen-rules", ButtonKind::Primary, ButtonSize::Normal, busy, cx).child(if busy { spinner(15., theme.on_accent).into_any_element() } else { div().child("Save changes").into_any_element() }).when(!busy, |el| el.on_click(cx.listener(|view, _, _, cx| view.save(cx))))).into_any_element());
        div().flex().flex_col().gap(px(14.)).children(parts)
    }
}
