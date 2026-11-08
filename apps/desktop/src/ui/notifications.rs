//! Notifications, drawn by the app as Telegram draws its own, as the Electron app did on
//! Windows: one
//! window in the corner of the screen, above everything and never taking focus unless a
//! reply is typed. The newest goes at the bottom, three at a time with the rest waiting,
//! each staying until the person next touches the computer, then 3 s more and a 4 s fade
//! that the mouse stops. What it shows came from someone else, so it only goes in as text.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, AppContext, Bounds, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Render, SharedString, Styled,
    Task, WeakEntity, Window, WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, point, prelude::*, px,
    size,
};
use gpui::Focusable as _;

use super::components::*;
use super::text_input::{InputEvent, TextInput};
use crate::format::avatar_color;
use crate::platform;
use crate::state::AppState;
use crate::theme;

const CARD_WIDTH: f32 = 320.;
/// A card and the gap it leaves at the edge of the screen.
const WIDTH: f32 = CARD_WIDTH + 6.;
const CARD_HEIGHT: f32 = 80.;
const HIDE_ALL_HEIGHT: f32 = 36.;
const GAP: f32 = 7.;
const MAX_SHOWN: usize = 3;
/// Anyone away for a weekend doesn't need to sit through more than this.
const MAX_WAITING: usize = 100;
const FAST: Duration = Duration::from_millis(150);
const SLOW: Duration = Duration::from_millis(4000);
const AFTER_INPUT: Duration = Duration::from_millis(3000);

pub use crate::platform::notification::{Payload, Picture};

#[derive(Clone, Copy)]
struct Fade {
    from: f32,
    to: f32,
    start: Instant,
    duration: Duration,
    slow: bool,
}

struct Card {
    id: u64,
    payload: Payload,
    started: Instant,
    waiting_for_input: bool,
    hide_at: Option<Instant>,
    fade: Option<Fade>,
    /// On its way out, so it takes up no room any more once it's faded.
    gone: bool,
    replying: bool,
    reply: Option<Entity<TextInput>>,
}

/// "Hide all", above the cards while there's more than one or any waiting.
struct HideAll {
    fade: Option<Fade>,
}

pub struct NotificationCenter {
    state: WeakEntity<AppState>,
    waiting: VecDeque<Payload>,
    shown: Vec<Card>,
    hide_all: Option<HideAll>,
    hovered: bool,
    window: Option<WindowHandle<NotificationsView>>,
    opening: bool,
    hwnd: isize,
    placed: Option<(i32, i32, i32, i32)>,
    typing: bool,
    reduce_motion: bool,
    next_id: u64,
    ticker: Option<Task<()>>,
}

#[derive(Clone)]
struct CenterGlobal(Entity<NotificationCenter>);

impl gpui::Global for CenterGlobal {}

pub fn center(cx: &App) -> Option<Entity<NotificationCenter>> {
    cx.try_global::<CenterGlobal>().map(|global| global.0.clone())
}

pub fn install(state: WeakEntity<AppState>, cx: &mut App) {
    let center = cx.new(|_| NotificationCenter {
        state,
        waiting: VecDeque::new(),
        shown: Vec::new(),
        hide_all: None,
        hovered: false,
        window: None,
        opening: false,
        hwnd: 0,
        placed: None,
        typing: false,
        reduce_motion: false,
        next_id: 1,
        ticker: None,
    });
    cx.set_global(CenterGlobal(center));
}

/// cubic-bezier(0.6, 0.04, 0.98, 0.335): stays nearly solid for most of the fade, and the mouse has time to catch it.
fn slow_easing(t: f32) -> f32 {
    let (x1, y1, x2, y2) = (0.6f32, 0.04f32, 0.98f32, 0.335f32);
    let bezier = |t: f32, a: f32, b: f32| 3. * (1. - t).powi(2) * t * a + 3. * (1. - t) * t * t * b + t * t * t;
    let mut u = t;
    for _ in 0..8 {
        let x = bezier(u, x1, x2) - t;
        let dx = 3. * (1. - u).powi(2) * x1 + 6. * (1. - u) * u * (x2 - x1) + 3. * u * u * (1. - x2);
        if dx.abs() < 1e-5 {
            break;
        }
        u = (u - x / dx).clamp(0., 1.);
    }
    bezier(u, y1, y2)
}

fn fade_value(fade: &Option<Fade>, reduce_motion: bool, now: Instant) -> (f32, bool) {
    let Some(fade) = fade else { return (1., true) };
    let elapsed = now.saturating_duration_since(fade.start).as_secs_f32();
    let progress = (elapsed / fade.duration.as_secs_f32().max(0.001)).clamp(0., 1.);
    let eased = if fade.slow {
        // With motion reduced it stays solid for as long, and then goes.
        if reduce_motion { if progress >= 1. { 1. } else { 0. } } else { slow_easing(progress) }
    } else {
        progress
    };
    (fade.from + (fade.to - fade.from) * eased, progress >= 1.)
}

impl NotificationCenter {
    fn opacity(&self, fade: &Option<Fade>) -> f32 {
        fade_value(fade, self.reduce_motion, Instant::now()).0
    }

    fn card_height(card: &Card, cx: &App) -> f32 {
        if !card.replying {
            return CARD_HEIGHT;
        }
        // The reply grows with its lines, from 36 to 72 px, under the 78 px card.
        let lines = card.reply.as_ref().map(|input| input.read(cx).text().lines().count().max(1)).unwrap_or(1);
        78. + 2. + (lines as f32 * 18. + 18.).clamp(36., 72.)
    }

    fn live(&self) -> impl Iterator<Item = &Card> {
        self.shown.iter().filter(|card| !card.gone)
    }

    /// Shows one, or holds it until there's room.
    pub fn show(&mut self, payload: Payload, reduce_motion: bool, cx: &mut Context<Self>) {
        self.reduce_motion = reduce_motion;
        self.waiting.push_back(payload);
        if self.waiting.len() > MAX_WAITING {
            self.waiting.pop_front();
        }
        self.show_next(cx);
    }

    /// Takes back notifications matching everything given: a server's, read chats', or one message's.
    pub fn clear(&mut self, server_id: Option<&str>, keys: Option<&[String]>, message_id: Option<&str>, cx: &mut Context<Self>) {
        let matches = |payload: &Payload| {
            server_id.is_none_or(|id| payload.server_id == id) && keys.is_none_or(|keys| keys.contains(&payload.key)) && message_id.is_none_or(|id| payload.message_id == id)
        };
        self.waiting.retain(|payload| !matches(payload));
        let ids: Vec<u64> = self
            .shown
            .iter()
            // Reading a chat elsewhere doesn't take away what's being typed to it.
            .filter(|card| matches(&card.payload) && !(keys.is_some() && card.replying))
            .map(|card| card.id)
            .collect();
        for id in ids {
            self.hide_fast(id, cx);
        }
        self.show_next(cx);
    }

    fn show_next(&mut self, cx: &mut Context<Self>) {
        let mut room = MAX_SHOWN.saturating_sub(self.live().count());
        while room > 0 {
            let Some(payload) = self.waiting.pop_front() else { break };
            let id = self.next_id;
            self.next_id += 1;
            let fade_in = if self.reduce_motion { None } else { Some(Fade { from: 0., to: 1., start: Instant::now(), duration: FAST, slow: false }) };
            self.shown.push(Card { id, payload, started: Instant::now(), waiting_for_input: true, hide_at: None, fade: fade_in, gone: false, replying: false, reply: None });
            room -= 1;
        }
        let wants_hide_all = self.live().count() > 1 || !self.waiting.is_empty();
        if wants_hide_all && self.hide_all.is_none() {
            self.hide_all = Some(HideAll { fade: None });
        } else if !wants_hide_all {
            if let Some(hide_all) = &mut self.hide_all {
                if hide_all.fade.is_none_or(|fade| fade.to > 0.) {
                    let from = fade_value(&hide_all.fade, self.reduce_motion, Instant::now()).0;
                    hide_all.fade = Some(Fade { from, to: 0., start: Instant::now(), duration: FAST, slow: false });
                }
            }
        }
        self.ensure_ticking(cx);
        self.arrange(cx);
    }

    fn hide_slow(&mut self, id: u64) {
        let reduce = self.reduce_motion;
        if let Some(card) = self.shown.iter_mut().find(|card| card.id == id && !card.gone) {
            let from = fade_value(&card.fade, reduce, Instant::now()).0;
            card.fade = Some(Fade { from, to: 0., start: Instant::now(), duration: SLOW, slow: true });
        }
    }

    fn hide_fast(&mut self, id: u64, cx: &mut Context<Self>) {
        let reduce = self.reduce_motion;
        if let Some(card) = self.shown.iter_mut().find(|card| card.id == id && !card.gone) {
            let from = fade_value(&card.fade, reduce, Instant::now()).0;
            card.gone = true;
            card.replying = false;
            card.hide_at = None;
            card.fade = Some(Fade { from, to: 0., start: Instant::now(), duration: FAST, slow: false });
        }
        self.update_typing(cx);
    }

    fn start_all_hiding(&mut self) {
        if self.shown.iter().any(|card| card.replying) {
            return;
        }
        let ids: Vec<u64> = self.shown.iter().filter(|card| !card.gone).map(|card| card.id).collect();
        for id in ids {
            self.hide_slow(id);
        }
        if self.waiting.len() < 2 {
            if let Some(hide_all) = &mut self.hide_all {
                hide_all.fade = Some(Fade { from: 1., to: 0., start: Instant::now(), duration: SLOW, slow: true });
            }
        }
    }

    fn stop_all_hiding(&mut self) {
        let reduce = self.reduce_motion;
        for card in self.shown.iter_mut().filter(|card| !card.gone) {
            card.hide_at = None;
            if card.fade.is_some_and(|fade| fade.to < 1.) {
                let from = fade_value(&card.fade, reduce, Instant::now()).0;
                card.fade = Some(Fade { from, to: 1., start: Instant::now(), duration: FAST, slow: false });
            }
        }
        if let Some(hide_all) = &mut self.hide_all {
            if hide_all.fade.is_some_and(|fade| fade.to < 1.) {
                let from = fade_value(&hide_all.fade, reduce, Instant::now()).0;
                hide_all.fade = Some(Fade { from, to: 1., start: Instant::now(), duration: FAST, slow: false });
            }
        }
    }

    fn dismiss(&mut self, id: u64, cx: &mut Context<Self>) {
        self.hide_fast(id, cx);
        self.show_next(cx);
    }

    /// Opening a chat or replying to it reads it, so the rest of its notifications go too.
    fn read_chat(&mut self, server_id: &str, key: &str, cx: &mut Context<Self>) {
        let keys = [key.to_string()];
        self.waiting.retain(|payload| !(payload.server_id == server_id && payload.key == key));
        let ids: Vec<u64> = self.shown.iter().filter(|card| card.payload.server_id == server_id && card.payload.key == key).map(|card| card.id).collect();
        for id in ids {
            self.hide_fast(id, cx);
        }
        let _ = keys;
        self.show_next(cx);
    }

    fn open(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(card) = self.shown.iter().find(|card| card.id == id) else { return };
        if card.replying {
            return;
        }
        let (server_id, key) = (card.payload.server_id.clone(), card.payload.key.clone());
        platform::later(cx, platform::show_main);
        if let Some(state) = self.state.upgrade() {
            state.update(cx, |state, cx| {
                state.select_server(&server_id, cx);
                state.select_conversation(Some(key.clone()), cx);
            });
        }
        self.read_chat(&server_id, &key, cx);
    }

    /// Opens the reply box, for the caller to focus: it's asked from inside the
    /// notifications window, which can't be reached through its handle from there.
    fn start_reply(&mut self, id: u64, cx: &mut Context<Self>) -> Option<Entity<TextInput>> {
        let card = self.shown.iter_mut().find(|card| card.id == id)?;
        card.replying = true;
        let input = cx.new(|cx| {
            let mut input = TextInput::new(cx, "Write a reply…").multiline();
            input.set_newline_on_enter(false);
            input
        });
        cx.subscribe(&input, move |center, _, event: &InputEvent, cx| match event {
            InputEvent::Submit => center.send_reply(id, cx),
            InputEvent::Escape => center.dismiss(id, cx),
            InputEvent::Changed => center.arrange(cx),
            _ => {}
        })
        .detach();
        card.reply = Some(input.clone());
        self.stop_all_hiding();
        self.update_typing(cx);
        self.arrange(cx);
        Some(input)
    }

    fn send_reply(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(card) = self.shown.iter().find(|card| card.id == id) else { return };
        let text = card.reply.as_ref().map(|input| input.read(cx).text().trim().to_string()).unwrap_or_default();
        if text.is_empty() {
            return;
        }
        let payload = card.payload.clone();
        if let Some(state) = self.state.upgrade() {
            state.update(cx, |state, cx| state.send_notification_reply(&payload.server_id, &payload.key, &payload.message_id, &text, cx));
        }
        self.read_chat(&payload.server_id, &payload.key, cx);
        self.start_all_hiding();
    }

    /// Typing a reply is the only thing that may take focus.
    fn update_typing(&mut self, cx: &mut Context<Self>) {
        let now = self.shown.iter().any(|card| card.replying);
        if now == self.typing {
            return;
        }
        self.typing = now;
        if self.hwnd != 0 {
            let hwnd = self.hwnd;
            platform::later(cx, move || platform::make_popup(windows::Win32::Foundation::HWND(hwnd as *mut _), now));
        }
        // The others were waiting for this, and the mouse may have left long ago.
        if !now && !self.hovered {
            self.start_all_hiding();
        }
        cx.notify();
    }

    fn set_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        if self.hovered == hovered {
            return;
        }
        self.hovered = hovered;
        if hovered {
            self.stop_all_hiding();
        } else {
            self.start_all_hiding();
        }
        cx.notify();
    }

    fn hide_everything(&mut self, cx: &mut Context<Self>) {
        self.waiting.clear();
        let ids: Vec<u64> = self.shown.iter().map(|card| card.id).collect();
        for id in ids {
            self.hide_fast(id, cx);
        }
        self.show_next(cx);
    }

    /// Runs the fades and the hiding while anything shows.
    fn ensure_ticking(&mut self, cx: &mut Context<Self>) {
        if self.ticker.is_some() {
            return;
        }
        self.ticker = Some(cx.spawn(async move |center, cx| {
            let mut last_input_check = Instant::now() - Duration::from_secs(1);
            loop {
                cx.background_executor().timer(Duration::from_millis(16)).await;
                let keep_going = center
                    .update(cx, |center, cx| {
                        let now = Instant::now();
                        if now.duration_since(last_input_check) >= Duration::from_millis(300) {
                            last_input_check = now;
                            center.check_input(now);
                        }
                        center.tick(now, cx)
                    })
                    .unwrap_or(false);
                if !keep_going {
                    center.update(cx, |center, _| center.ticker = None).ok();
                    break;
                }
            }
        }));
    }

    /// Cards stay until someone is at the computer to see them, and their time starts from there.
    fn check_input(&mut self, now: Instant) {
        let idle = Duration::from_millis(platform::idle_ms() as u64 + 1000);
        let paused = self.hovered || self.shown.iter().any(|card| card.replying);
        for card in self.shown.iter_mut().filter(|card| card.waiting_for_input && !card.gone) {
            let input_since_start = idle < now.duration_since(card.started);
            if card.payload.wait_for_input && !input_since_start {
                continue;
            }
            card.waiting_for_input = false;
            if !paused {
                card.hide_at = Some(now + AFTER_INPUT);
            }
        }
    }

    fn tick(&mut self, now: Instant, cx: &mut Context<Self>) -> bool {
        let due: Vec<u64> = self.shown.iter().filter(|card| card.hide_at.is_some_and(|at| at <= now) && !card.gone).map(|card| card.id).collect();
        for id in due {
            if let Some(card) = self.shown.iter_mut().find(|card| card.id == id) {
                card.hide_at = None;
            }
            self.hide_slow(id);
        }
        // Gone once faded out, whether hidden slowly or fast.
        let reduce = self.reduce_motion;
        let before = self.shown.len();
        self.shown.retain(|card| {
            let (value, done) = fade_value(&card.fade, reduce, now);
            !(done && value <= 0.001 && card.fade.is_some_and(|fade| fade.to == 0.))
        });
        if let Some(hide_all) = &self.hide_all {
            let (value, done) = fade_value(&hide_all.fade, reduce, now);
            if done && value <= 0.001 && hide_all.fade.is_some_and(|fade| fade.to == 0.) {
                self.hide_all = None;
            }
        }
        if self.shown.len() != before {
            self.show_next(cx);
        }
        self.arrange(cx);
        cx.notify();
        if let Some(window) = self.window {
            window.update(cx, |_, window, _| window.refresh()).ok();
        }
        !self.shown.is_empty() || self.hide_all.is_some()
    }

    /// Sizes the window to the stack and keeps it in the corner, or hides it when empty.
    fn arrange(&mut self, cx: &mut Context<Self>) {
        let mut height = 0.;
        for card in self.live() {
            height += Self::card_height(card, cx) + GAP;
        }
        if self.hide_all.is_some() {
            height += HIDE_ALL_HEIGHT + GAP;
        }
        // Cards still fading out keep their place until they go.
        for card in self.shown.iter().filter(|card| card.gone) {
            height += Self::card_height(card, cx) + GAP;
        }
        if height <= 0. {
            if self.hwnd != 0 {
                let hwnd = self.hwnd;
                platform::later(cx, move || platform::hide_window(windows::Win32::Foundation::HWND(hwnd as *mut _)));
            }
            self.placed = None;
            return;
        }
        self.ensure_window(cx);
        if self.hwnd == 0 {
            return;
        }
        let (area, scale) = platform::work_area();
        let width = (WIDTH * scale).round() as i32;
        let high = ((height * scale).round() as i32).min(area.bottom - area.top);
        let placed = (area.right - width, area.bottom - high, width, high);
        if self.placed != Some(placed) {
            self.placed = Some(placed);
            let hwnd = self.hwnd;
            platform::later(cx, move || platform::place_popup(windows::Win32::Foundation::HWND(hwnd as *mut _), placed.0, placed.1, placed.2, placed.3));
        }
    }

    /// Opens the window once, right after this update: GPUI draws a new window at once,
    /// and its view reads the center, which can't be read while it's being changed.
    fn ensure_window(&mut self, cx: &mut Context<Self>) {
        if self.window.is_some() || self.opening {
            return;
        }
        self.opening = true;
        cx.spawn(async move |center, cx| {
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds { origin: point(px(0.), px(0.)), size: size(px(WIDTH), px(CARD_HEIGHT)) })),
                // A native title bar, which make_popup then takes away: without one GPUI keeps a
                // resize frame inside the window, and the cards would be drawn 8 px in from its edges.
                titlebar: Some(gpui::TitlebarOptions { title: None, appears_transparent: false, traffic_light_position: None }),
                focus: false,
                show: false,
                kind: WindowKind::PopUp,
                is_movable: false,
                is_resizable: false,
                is_minimizable: false,
                window_background: WindowBackgroundAppearance::Transparent,
                app_id: Some("Zuna".into()),
                ..Default::default()
            };
            let Some(entity) = center.upgrade() else { return };
            let opened = cx.update(|cx| cx.open_window(options, |_, cx| cx.new(|cx| NotificationsView::new(entity.clone(), cx))));
            let Ok(window) = opened else { return };
            let hwnd = window.update(cx, |_, window, _| platform::hwnd_of(window)).ok().flatten();
            center
                .update(cx, |center, cx| {
                    center.opening = false;
                    center.window = Some(window);
                    if let Some(hwnd) = hwnd {
                        let typing = center.typing;
                        let raw = hwnd.0 as isize;
                        platform::later(cx, move || platform::make_popup(windows::Win32::Foundation::HWND(raw as *mut _), typing));
                        center.hwnd = raw;
                    }
                    center.placed = None;
                    center.arrange(cx);
                    cx.notify();
                })
                .ok();
        })
        .detach();
    }
}

pub struct NotificationsView {
    center: Entity<NotificationCenter>,
}

impl NotificationsView {
    fn new(center: Entity<NotificationCenter>, cx: &mut Context<Self>) -> Self {
        cx.observe(&center, |_, _, cx| cx.notify()).detach();
        NotificationsView { center }
    }

    fn card(&self, card: &Card, opacity: f32, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let theme = theme(cx);
        let id = card.id;
        let payload = &card.payload;
        let center = self.center.clone();
        let photo: AnyElement = match &payload.picture {
            None => logo(62.).into_any_element(),
            Some(picture) => match &picture.image {
                Some(image) => cover(image.clone(), 1., 124, cx).size(px(62.)).rounded_full().into_any_element(),
                None => div()
                    .size(px(62.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme::css(avatar_color(&picture.seed)))
                    .text_color(theme::color(theme::white_a(0.92)))
                    .text_size(px(24.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(picture.initials.clone())
                    .into_any_element(),
            },
        };
        // Who said it, in a group, has its own color.
        let split = if payload.kind != "dm" { payload.body.find(": ").filter(|index| *index > 0) } else { None };
        let (author, body) = match split {
            Some(index) => (format!("{} ", &payload.body[..=index]), payload.body[index + 2..].to_string()),
            None => (String::new(), payload.body.clone()),
        };
        let group = SharedString::from(format!("card-{id}"));
        let replying = card.replying;
        let can_reply = payload.can_reply;
        let mut element = div()
            .id(("notification", id as usize))
            .group(group.clone())
            .relative()
            .w(px(CARD_WIDTH))
            .h(px(height))
            .flex_none()
            .opacity(opacity)
            .bg(theme.bg2)
            .border_1()
            .border_color(theme.bg5)
            .font_family(theme::FONT_UI)
            .text_size(px(13.))
            .line_height(px(18.))
            .text_color(theme.text1)
            .when(!replying, |el| el.cursor_pointer())
            .on_hover({
                let center = center.clone();
                move |hovered, _, cx| center.update(cx, |center, cx| center.set_hovered(*hovered, cx))
            })
            .on_mouse_down(MouseButton::Right, {
                let center = center.clone();
                move |_, _, cx| center.update(cx, |center, cx| center.dismiss(id, cx))
            })
            .on_click({
                let center = center.clone();
                move |_, _, cx| center.update(cx, |center, cx| center.open(id, cx))
            })
            .child(div().absolute().left(px(8.)).top(px(8.)).size(px(62.)).rounded_full().overflow_hidden().child(photo))
            .child(
                div()
                    .absolute()
                    .left(px(82.))
                    .top(px(6.))
                    .w(px(206.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .when(payload.kind == "group" && payload.picture.is_some(), |el| el.child(icon("users", 14., theme.text1)))
                    .child(div().min_w_0().one_line().child(payload.title.clone())),
            )
            .child(
                div()
                    .absolute()
                    .left(px(82.))
                    .top(px(29.))
                    .w(px(206.))
                    .max_h(px(36.))
                    .font_family(theme::FONT_UI)
                    .text_color(theme.text2)
                    // Two lines at most, the second ending in an ellipsis, as `-webkit-line-clamp`.
                    .child(clamped(format!("{author}{body}"), 2).colored(vec![(author.len(), theme.accent_text)])),
            )
            .child(
                div()
                    .id(("close", id as usize))
                    .absolute()
                    .top(px(1.))
                    .right_0()
                    .size(px(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(theme.text3)
                    .hover(move |style| style.text_color(theme.text1))
                    .on_click({
                        let center = center.clone();
                        move |_, _, cx| {
                            cx.stop_propagation();
                            center.update(cx, |center, cx| center.dismiss(id, cx))
                        }
                    })
                    .child(icon("x", 13., theme.text3)),
            );
        if can_reply && !replying {
            // Fades in over the end of the text while the mouse is on the card.
            element = element.child(
                div()
                    .absolute()
                    .top(px(24.))
                    .right_0()
                    .h(px(54.))
                    .pl(px(32.))
                    .pr(px(8.))
                    .pb(px(8.))
                    .flex()
                    .items_end()
                    .opacity(0.)
                    .group_hover(group, |style| style.opacity(1.))
                    .child(
                        div()
                            .id(("reply", id as usize))
                            .h(px(30.))
                            .px(px(14.))
                            .flex()
                            .items_center()
                            .rounded(crate::theme::RADIUS_S)
                            .bg(theme.bg2)
                            .text_color(theme.accent_text)
                            .font_weight(FontWeight::SEMIBOLD)
                            .hover(move |style| style.bg(theme.hover_strong))
                            .on_click({
                                let center = center.clone();
                                move |_, window, cx| {
                                    cx.stop_propagation();
                                    if let Some(input) = center.update(cx, |center, cx| center.start_reply(id, cx)) {
                                        input.focus_handle(cx).focus(window, cx);
                                    }
                                }
                            })
                            .child("REPLY"),
                    ),
            );
        }
        if let (true, Some(input)) = (replying, card.reply.clone()) {
            element = element.child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .top(px(78.))
                    .flex()
                    .items_end()
                    .cursor_text()
                    .child(div().flex_1().min_w_0().min_h(px(36.)).max_h(px(72.)).pl(px(8.)).pr(px(8.)).pt(px(8.)).pb(px(6.)).child(input))
                    .child(
                        div()
                            .id(("send", id as usize))
                            .size(px(36.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .on_click({
                                let center = center.clone();
                                move |_, _, cx| {
                                    cx.stop_propagation();
                                    center.update(cx, |center, cx| center.send_reply(id, cx))
                                }
                            })
                            .child(icon("send-horizontal", 18., theme.accent_text)),
                    ),
            );
        }
        element.into_any_element()
    }
}

impl Render for NotificationsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        let center = self.center.read(cx);
        let hide_all = center.hide_all.as_ref().map(|hide_all| center.opacity(&hide_all.fade));
        let cards: Vec<(u64, f32, f32)> = center.shown.iter().map(|card| (card.id, center.opacity(&card.fade), NotificationCenter::card_height(card, cx))).collect();
        let mut column = div().size_full().flex().flex_col().justify_end().items_start().gap(px(GAP)).pb(px(GAP));
        if let Some(opacity) = hide_all {
            let center = self.center.clone();
            column = column.child(
                div()
                    .id("hide-all")
                    .w(px(CARD_WIDTH))
                    .h(px(HIDE_ALL_HEIGHT))
                    .flex_none()
                    .opacity(opacity)
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme.bg3)
                    .border_1()
                    .border_color(theme.bg5)
                    .font_family(theme::FONT_UI)
                    .text_size(px(13.))
                    .text_color(theme.accent_text)
                    .font_weight(FontWeight::SEMIBOLD)
                    .cursor_pointer()
                    .hover(move |style| style.bg(theme.bg4))
                    .on_click(move |_, _, cx| center.update(cx, |center, cx| center.hide_everything(cx)))
                    .child("Hide all"),
            );
        }
        let shown: Vec<(u64, f32, f32)> = cards;
        for (id, opacity, height) in shown {
            let card = {
                let center = self.center.read(cx);
                center.shown.iter().find(|card| card.id == id).map(|card| Card {
                    id: card.id,
                    payload: card.payload.clone(),
                    started: card.started,
                    waiting_for_input: card.waiting_for_input,
                    hide_at: card.hide_at,
                    fade: card.fade,
                    gone: card.gone,
                    replying: card.replying,
                    reply: card.reply.clone(),
                })
            };
            if let Some(card) = card {
                column = column.child(self.card(&card, opacity, height, cx));
            }
        }
        column
    }
}
