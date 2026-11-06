//! Zuna: smooth scrolling for a mouse wheel's notches, as Chromium's: each notch moves the
//! same distance as there, eased out over about 150 ms, and notches that come while it moves
//! add to where it's going. A touchpad's pixels still move at once, as they do there.

use crate::{Pixels, Point, ScrollDelta, point, px};
use std::time::{Duration, Instant};

/// How far a line of a notch goes: Chromium's 100 px for Windows's three lines.
pub(crate) const PIXELS_PER_LINE: f32 = 100. / 3.;

/// How quickly what's left of a glide is covered: most of it in three of these.
const EASE: Duration = Duration::from_millis(45);

/// A glide under way: how far is left to go, and when it last moved.
#[derive(Default)]
pub(crate) struct Glide {
    left: Point<Pixels>,
    moved: Option<Instant>,
}

impl Glide {
    /// Whether this delta is a wheel's notches, to glide, rather than a touchpad's pixels.
    pub(crate) fn takes(delta: &ScrollDelta) -> bool {
        matches!(delta, ScrollDelta::Lines(_))
    }

    /// Adds a notch's distance. True if the glide was at rest, so its frames need starting.
    pub(crate) fn add(&mut self, delta: Point<Pixels>) -> bool {
        let resting = self.moved.is_none();
        self.left = self.left + delta;
        resting
    }

    /// How far to move for this frame, and whether there's more after it.
    pub(crate) fn step(&mut self) -> (Point<Pixels>, bool) {
        let now = Instant::now();
        // A glide's first frame moves as a frame's worth, as it's seen a frame later.
        let elapsed = self.moved.map_or(Duration::from_millis(8), |at| now - at).clamp(Duration::from_millis(1), Duration::from_millis(50));
        self.moved = Some(now);
        let part = 1. - (-elapsed.as_secs_f32() / EASE.as_secs_f32()).exp();
        let mut step = point(self.left.x * part, self.left.y * part);
        if self.left.x.abs() < px(0.5) {
            step.x = self.left.x;
        }
        if self.left.y.abs() < px(0.5) {
            step.y = self.left.y;
        }
        self.left = self.left - step;
        let more = self.left.x.abs() >= px(0.5) || self.left.y.abs() >= px(0.5);
        if !more {
            self.left = Point::default();
            self.moved = None;
        }
        (step, more)
    }

    /// Stops where it is, as when it reached an end.
    pub(crate) fn stop(&mut self) {
        self.left = Point::default();
        self.moved = None;
    }
}
