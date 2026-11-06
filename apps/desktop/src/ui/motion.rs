//! The desktop's motion, which GPUI has none of by itself: base.css's entrances (fade-in,
//! rise-in, pop-in, panel-in) and motion/react's for dialogs and menus, with its easing,
//! and CSS transitions, which only move when what they show changes.
//!
//! GPUI can't transform an element, so an entrance fades the element itself and moves it
//! where it's painted, without touching the layout. A scale, as pop-in's 0.97, is left as
//! the fade it comes with.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui::{AnimationElement, AnimationExt, AnyElement, App, Animation, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId, Pixels, Point, SharedString, Styled, Window, point, px};

thread_local! {
    /// When each `enter_once` element was first shown.
    static FIRST_SEEN: RefCell<HashMap<SharedString, Instant>> = RefCell::new(HashMap::new());
}

/// A CSS cubic-bezier timing function.
pub fn bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 + Clone + 'static {
    move |t: f32| {
        let t = t.clamp(0., 1.);
        let at = |a: f32, b: f32, s: f32| 3. * a * s * (1. - s) * (1. - s) + 3. * b * s * s * (1. - s) + s * s * s;
        // x is monotonic, so halving finds where it's t.
        let (mut low, mut high) = (0., 1.);
        for _ in 0..24 {
            let middle = (low + high) / 2.;
            if at(x1, x2, middle) < t { low = middle } else { high = middle }
        }
        at(y1, y2, (low + high) / 2.)
    }
}

/// `--ease-out`, and motion's `quick`: cubic-bezier(0.2, 0, 0, 1).
pub fn ease_out() -> impl Fn(f32) -> f32 + Clone + 'static {
    bezier(0.2, 0., 0., 1.)
}

/// CSS's own `ease`, for an animation that names no timing.
pub fn ease() -> impl Fn(f32) -> f32 + Clone + 'static {
    bezier(0.25, 0.1, 0.25, 1.)
}

/// How something comes in.
#[derive(Clone, Copy, PartialEq)]
pub enum Enter {
    /// `fade-in`, with CSS's default easing.
    Fade,
    /// `rise-in`: up from this far below, fading in.
    Rise(f32),
    /// `pop-in`, motion's opacity and scale: the fade.
    Pop,
    /// `panel-in`: in from this far to the right, fading in.
    Slide(f32),
}

/// An element faded and moved where it's painted, for an entrance.
pub struct Moving<E> {
    element: Option<E>,
    offset: Point<Pixels>,
    opacity: f32,
}

impl<E: IntoElement + Styled + 'static> Moving<E> {
    pub fn new(element: E) -> Self {
        Moving { element: Some(element), offset: point(px(0.), px(0.)), opacity: 1. }
    }

    fn at(mut self, kind: Enter, progress: f32) -> Self {
        self.opacity = progress;
        self.offset = match kind {
            Enter::Rise(distance) => point(px(0.), px(distance * (1. - progress))),
            Enter::Slide(distance) => point(px(distance * (1. - progress)), px(0.)),
            Enter::Fade | Enter::Pop => point(px(0.), px(0.)),
        };
        self
    }
}

impl<E: IntoElement + Styled + 'static> IntoElement for Moving<E> {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl<E: IntoElement + Styled + 'static> gpui::Element for Moving<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, AnyElement) {
        let mut element = self.element.take().expect("laid out once");
        // On top of whatever opacity it has of its own.
        let own = element.style().opacity.unwrap_or(1.);
        element.style().opacity = Some(own * self.opacity);
        let mut child = element.into_any_element();
        (child.request_layout(window, cx), child)
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: gpui::Bounds<Pixels>, child: &mut AnyElement, window: &mut Window, cx: &mut App) {
        window.with_element_offset(self.offset, |window| child.prepaint(window, cx));
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: gpui::Bounds<Pixels>, child: &mut AnyElement, _: &mut (), window: &mut Window, cx: &mut App) {
        child.paint(window, cx);
    }
}

pub trait Motion: IntoElement + Styled + Sized + 'static {
    /// Comes in as the desktop's `animation: <kind> <ms>`, once, when it first appears with
    /// this id, as a CSS animation runs when its element is added.
    fn enter(self, id: impl Into<ElementId>, kind: Enter, ms: u64) -> AnimationElement<Moving<Self>> {
        self.enter_after(id, kind, 0, ms)
    }

    /// Comes in as motion/react animates dialogs, menus and the picker, which Windows's own
    /// Animation effects setting stills too.
    fn appear(self, id: impl Into<ElementId>, kind: Enter, ms: u64) -> AnimationElement<Moving<Self>> {
        self.enter_after(id, kind, 0, if reduced_or_system() { 0 } else { ms })
    }

    /// Comes in the first time it's shown, and is simply there after that: inside a list
    /// that draws only the rows on screen, a row scrolled back into view is a new element
    /// to GPUI, which would play its animation again on every scroll.
    fn enter_once(self, id: impl Into<SharedString>, kind: Enter, ms: u64) -> AnyElement {
        let id: SharedString = id.into();
        let now = Instant::now();
        let first = FIRST_SEEN.with(|seen| {
            let mut seen = seen.borrow_mut();
            if seen.len() > 20_000 {
                seen.retain(|_, at| now - *at < Duration::from_secs(5));
            }
            *seen.entry(id.clone()).or_insert(now)
        });
        if now - first < Duration::from_millis(ms) {
            self.enter(ElementId::Name(id), kind, ms).into_any_element()
        } else {
            self.into_any_element()
        }
    }

    /// The same, after waiting, as `animation: <kind> <ms> <delay> both`.
    fn enter_after(self, id: impl Into<ElementId>, kind: Enter, delay_ms: u64, ms: u64) -> AnimationElement<Moving<Self>> {
        let easing: Box<dyn Fn(f32) -> f32> = if kind == Enter::Fade { Box::new(ease()) } else { Box::new(ease_out()) };
        // Reduce motion: as good as no time at all, as its 0.001ms.
        let (delay_ms, ms) = if reduced() { (0, 0) } else { (delay_ms, ms) };
        let total = (delay_ms + ms).max(1) as f32;
        let (delay, length) = (delay_ms as f32 / total, ms as f32 / total);
        // Started at once, its first frame is drawn a frame in (`ahead`).
        let head = if delay_ms == 0 { ahead(ms) } else { 0. };
        Moving::new(self).with_animation(id, Animation::new(Duration::from_millis((delay_ms + ms).max(1))), move |moving, t| {
            let progress = if length > 0. { ((t - delay) / length + head).clamp(0., 1.) } else { 1. };
            moving.at(kind, easing(progress))
        })
    }
}

impl<E: IntoElement + Styled + 'static> Motion for E {}

/// How far into an animation its first frame is drawn, as a part of it. A frame is seen about
/// one refresh after it's drawn, so one drawn at the very start would show nothing, and what
/// opens or lights up would show a frame later than it need be.
fn ahead(ms: u64) -> f32 {
    const FRAME_MS: f32 = 8.;
    if ms == 0 { 1. } else { FRAME_MS / ms as f32 }
}

struct Transition {
    from: f32,
    to: f32,
    started: Instant,
    length: Duration,
    generation: u64,
}

thread_local! {
    static TRANSITIONS: RefCell<HashMap<String, Transition>> = RefCell::new(HashMap::new());
}

fn value_at(transition: &Transition, now: Instant, easing: &dyn Fn(f32) -> f32) -> f32 {
    let t = if transition.length.is_zero() { 1. } else { (now - transition.started).as_secs_f32() / transition.length.as_secs_f32() };
    let t = easing(t.clamp(0., 1.));
    transition.from + (transition.to - transition.from) * t
}

/// A CSS transition on a number: drawn at `target`, except for `ms` after it changes, when
/// it moves there from where it was. The first time a key is seen it's simply there, as a
/// transition doesn't run when its element appears.
pub fn transition<E: IntoElement + 'static>(element: E, key: impl Into<String>, target: f32, ms: u64, easing: impl Fn(f32) -> f32 + Clone + 'static, apply: impl Fn(E, f32) -> E + 'static) -> AnyElement {
    let key = key.into();
    let now = Instant::now();
    let ms = if reduced() { 0 } else { ms };
    let running = TRANSITIONS.with(|transitions| {
        let mut transitions = transitions.borrow_mut();
        match transitions.get_mut(&key) {
            None => {
                transitions.insert(key.clone(), Transition { from: target, to: target, started: now, length: Duration::ZERO, generation: 0 });
                None
            }
            Some(transition) => {
                if transition.to != target {
                    let from = value_at(transition, now, &easing);
                    *transition = Transition { from, to: target, started: now, length: Duration::from_millis(ms), generation: transition.generation + 1 };
                }
                (now - transition.started < transition.length).then(|| (transition.from, transition.to, transition.generation, transition.length))
            }
        }
    });
    match running {
        None => apply(element, target).into_any_element(),
        // Keyed by which change it is, so it runs from the start of each.
        Some((from, to, generation, length)) => {
            let head = ahead(length.as_millis() as u64);
            element
                .with_animation(ElementId::Name(format!("{key}#{generation}").into()), Animation::new(length), move |element, t| apply(element, from + (to - from) * easing((t + head).min(1.))))
                .into_any_element()
        }
    }
}

/// A color between two, by how far along it is.
pub fn mix(from: gpui::Hsla, to: gpui::Hsla, t: f32) -> gpui::Hsla {
    let (a, b) = (gpui::Rgba::from(from), gpui::Rgba::from(to));
    gpui::Rgba { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t }.into()
}

thread_local! {
    /// Settings' Reduce motion, which stills everything, as `:root[data-motion="reduced"]`.
    static REDUCED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Windows's Animation effects turned off, which motion/react and the message list heed.
    static SYSTEM_REDUCED: std::cell::Cell<(bool, Option<Instant>)> = const { std::cell::Cell::new((false, None)) };
}

/// Follows Settings' Reduce motion, set as the window is drawn.
pub fn set_reduced(reduced: bool) {
    REDUCED.with(|cell| cell.set(reduced));
}

/// Whether Reduce motion is on: then nothing moves, not even a spinner.
pub fn reduced() -> bool {
    REDUCED.with(|cell| cell.get())
}

/// Whether either Reduce motion or Windows's own setting asks for less: dialogs, menus and
/// the message list's glide then simply appear, as motion/react's `reducedMotion: "user"`.
pub fn reduced_or_system() -> bool {
    reduced() || system_reduced()
}

fn system_reduced() -> bool {
    SYSTEM_REDUCED.with(|cell| {
        let (value, read) = cell.get();
        if read.is_some_and(|read| read.elapsed() < Duration::from_secs(2)) {
            return value;
        }
        let reduced = crate::platform::animations_off();
        cell.set((reduced, Some(Instant::now())));
        reduced
    })
}

struct Slide {
    from: f32,
    started: Instant,
}

thread_local! {
    /// Where each sliding row last was, in what it scrolls in, and a slide it's on.
    static ROWS: RefCell<HashMap<String, (f32, Option<Slide>)>> = RefCell::new(HashMap::new());
}

const SLIDE: Duration = Duration::from_millis(140);

/// A row that slides to its new place when the list's order changes, as the desktop's
/// conversation list moves its rows: from where it was, at most 120 px away, over 140 ms.
pub fn sliding(key: impl Into<String>, scroll: gpui::ScrollHandle, element: impl IntoElement) -> Sliding {
    Sliding { key: key.into(), scroll, child: Some(element.into_any_element()) }
}

pub struct Sliding {
    key: String,
    scroll: gpui::ScrollHandle,
    child: Option<AnyElement>,
}

impl IntoElement for Sliding {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for Sliding {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, AnyElement) {
        let mut child = self.child.take().expect("laid out once");
        (child.request_layout(window, cx), child)
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: gpui::Bounds<Pixels>, child: &mut AnyElement, window: &mut Window, cx: &mut App) {
        // Its place in the list, not on screen, so scrolling doesn't count as moving.
        let place = f32::from(bounds.top() - self.scroll.bounds().top() - self.scroll.offset().y);
        let now = Instant::now();
        let offset = ROWS.with(|rows| {
            let mut rows = rows.borrow_mut();
            let entry = rows.entry(self.key.clone()).or_insert((place, None));
            if (entry.0 - place).abs() > 0.5 {
                if !reduced() {
                    // Where it's drawn now, carried on from a slide it was already on.
                    let showing = entry.1.as_ref().map(|slide| slide.from * (1. - ease_out()((now - slide.started).as_secs_f32() / SLIDE.as_secs_f32()))).unwrap_or(0.);
                    entry.1 = Some(Slide { from: (entry.0 + showing - place).clamp(-120., 120.), started: now });
                }
                entry.0 = place;
            }
            match &entry.1 {
                Some(slide) if now - slide.started < SLIDE => Some(slide.from * (1. - ease_out()((now - slide.started).as_secs_f32() / SLIDE.as_secs_f32()))),
                _ => {
                    entry.1 = None;
                    None
                }
            }
        });
        match offset {
            Some(offset) => {
                window.request_animation_frame();
                window.with_element_offset(point(px(0.), px(offset)), |window| child.prepaint(window, cx));
            }
            None => {
                child.prepaint(window, cx);
            }
        }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: gpui::Bounds<Pixels>, child: &mut AnyElement, _: &mut (), window: &mut Window, cx: &mut App) {
        child.paint(window, cx);
    }
}

struct Dim {
    since: Option<Instant>,
    /// When it stopped, and how dim it was then.
    ended: Option<(Instant, f32)>,
}

thread_local! {
    static DIMS: RefCell<HashMap<String, Dim>> = RefCell::new(HashMap::new());
}

/// How opaque something is that dims while `active`, as `transition: opacity <ms> <delay>`:
/// at 1 for `delay_ms`, then down to `dim` over `ms`, and back over `back_ms` once it isn't.
/// Seen already active the first time, as a message loaded while still sending, it starts
/// from 1 as `@starting-style` has it.
pub fn delayed_dim(key: &str, active: bool, delay_ms: u64, ms: u64, dim: f32, back_ms: u64, window: &mut Window) -> f32 {
    if reduced() {
        return if active { dim } else { 1. };
    }
    let now = Instant::now();
    let showing = |dim_state: &Dim| -> f32 {
        match dim_state.since {
            Some(since) => {
                let t = (now - since).as_secs_f32() * 1000.;
                if t < delay_ms as f32 { 1. } else { 1. - (1. - dim) * ease()(((t - delay_ms as f32) / ms.max(1) as f32).min(1.)) }
            }
            None => match dim_state.ended {
                Some((ended, from)) => {
                    let t = (now - ended).as_secs_f32() * 1000. / back_ms.max(1) as f32;
                    if t >= 1. { 1. } else { from + (1. - from) * ease()(t) }
                }
                None => 1.,
            },
        }
    };
    let (value, moving) = DIMS.with(|dims| {
        let mut dims = dims.borrow_mut();
        let entry = dims.entry(key.to_string()).or_insert(Dim { since: None, ended: None });
        if active && entry.since.is_none() {
            entry.since = Some(now);
            entry.ended = None;
        } else if !active && entry.since.is_some() {
            let at = showing(entry);
            entry.since = None;
            entry.ended = Some((now, at));
        }
        let value = showing(entry);
        let moving = match (entry.since, entry.ended) {
            (Some(since), _) => (now - since) < Duration::from_millis(delay_ms + ms),
            (None, Some((ended, _))) => (now - ended) < Duration::from_millis(back_ms),
            _ => false,
        };
        if !active && !moving {
            dims.remove(key);
        }
        (value, moving)
    });
    if moving {
        window.request_animation_frame();
    }
    value
}

/// A repeating animation, such as a spinner or a pulse, which rests where it starts under
/// Reduce motion, as an animation cut to one 0.001ms run does.
pub fn pulse<E: IntoElement + Styled + 'static>(element: E, id: impl Into<ElementId>, ms: u64, animate: impl Fn(E, f32) -> E + 'static) -> AnyElement {
    if reduced() {
        animate(element, 0.).into_any_element()
    } else {
        element.with_animation(id, Animation::new(Duration::from_millis(ms)).repeat(), animate).into_any_element()
    }
}

thread_local! {
    /// What's under the pointer, by key, for hovers that fade.
    static HOVERED: RefCell<std::collections::HashSet<String>> = RefCell::new(std::collections::HashSet::new());
}

/// Whether the element tracked under this key has the pointer on it.
pub fn hovered(key: &str) -> bool {
    HOVERED.with(|hovered| hovered.borrow().contains(key))
}

/// Notes when the pointer is on this element, for `hover_layer` and other hover fades.
pub fn track_hover<E: gpui::StatefulInteractiveElement>(element: E, key: String) -> E {
    element.on_hover(move |over, window, _| {
        HOVERED.with(|hovered| {
            let mut hovered = hovered.borrow_mut();
            if *over {
                hovered.insert(key.clone());
            } else {
                hovered.remove(&key);
            }
        });
        window.refresh();
    })
}

/// A hover color under an element's content, fading in and out over `ms` as `transition:
/// background` does, for an element tracked by `track_hover` under the same key. It goes in
/// as the element's first child, which needs to be `relative`.
pub fn hover_layer(key: &str, color: gpui::Hsla, radius: Pixels, ms: u64) -> AnyElement {
    use gpui::prelude::*;
    transition(gpui::div().absolute().inset_0().rounded(radius).bg(color), format!("{key}-hover"), if hovered(key) { 1. } else { 0. }, ms, ease(), |el, t| el.opacity(t))
}

/// `hover_layer` with each corner rounded as given, for halves of a pill.
pub fn hover_layer_corners(key: &str, color: gpui::Hsla, corners: gpui::Corners<Pixels>, ms: u64) -> AnyElement {
    use gpui::prelude::*;
    let layer = gpui::div().absolute().inset_0().rounded_tl(corners.top_left).rounded_tr(corners.top_right).rounded_br(corners.bottom_right).rounded_bl(corners.bottom_left).bg(color);
    transition(layer, format!("{key}-hover"), if hovered(key) { 1. } else { 0. }, ms, ease(), |el, t| el.opacity(t))
}
