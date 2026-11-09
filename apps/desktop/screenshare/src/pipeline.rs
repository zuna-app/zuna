//! What happens to a captured frame: when to encode it, where the result goes, and
//! how the network's feedback reaches the encoder. The capture modules drive this.

use std::{
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    capture::Codec,
    cpu,
    encoder::{Encoder, Input, Result},
    h264::Rewriter,
};

/// An encoded frame, ready to go out.
pub struct EncodedFrame<'a> {
    pub codec: Codec,
    pub data: &'a [u8],
    /// On the wall clock, in microseconds.
    pub timestamp_us: i64,
    pub key: bool,
    pub width: u32,
    pub height: u32,
}

/// Where encoded frames go, and what the network says back: LiveKit, in the app.
pub trait Output: Send {
    /// Sends a frame, and says whether it was taken.
    fn send(&mut self, frame: &EncodedFrame) -> bool;
    /// Someone asked for a keyframe since this was last asked.
    fn take_keyframe_request(&mut self) -> bool;
    /// The bitrate the network wants now, in bits a second, if it's said since this was last asked.
    fn take_target_bitrate(&mut self) -> Option<u64>;
}

/// A still screen gets this long at the full frame rate, for the encoder to sharpen
/// it, and then only a trickle of frames to keep the stream alive. libwebrtc counts a
/// freeze where a frame comes 150 ms later than they've been coming, so a trickle of one
/// every 200 ms made each still moment five freezes in the stats of whoever's watching.
const REFINE_FOR: Duration = Duration::from_millis(500);
const STILL_INTERVAL: Duration = Duration::from_millis(120);

/// A browser asks again while a keyframe is on its way, so answer at this pace.
const KEYFRAME_MIN_GAP: Duration = Duration::from_millis(250);

/// How long to wait for an asynchronous encoder before moving on to the next frame.
const PACKET_WAIT: Duration = Duration::from_millis(40);

/// Every bitrate change costs a keyframe, because FFmpeg resets NVENC to make it and
/// the other encoders only take a bitrate when opened, and a keyframe is a burst that
/// someone watching waits for. libwebrtc revises its estimate several times a second,
/// so small changes are ignored. A fall goes after a pause, or at once if it's a long
/// way, since then the network is already overloaded. A rise goes after the pause while
/// the bitrate is first climbing, since libwebrtc only raises its estimate a little past
/// what's sent.
const BITRATE_MIN_GAP: Duration = Duration::from_secs(2);
const BITRATE_MIN_CHANGE: f64 = 1.25;
const BITRATE_URGENT_DROP: f64 = 0.6;

/// Once the bitrate has had to fall, a rise is a guess. libwebrtc lets its estimate run
/// to half as much again as what's sent, so it goes on wanting more than the link took
/// just before: a share from Windows that had fallen to 32 Mbit/s was told 47 were there.
/// So a rise waits this long after the last change, and twice as long again after each
/// that had to fall back soon after, up to the most. While a rise went with each regular
/// keyframe, every 10 s, someone watching that share saw it stop for half a second, often.
const BITRATE_RISE_GAP: Duration = Duration::from_secs(30);
const BITRATE_RISE_GAP_MOST: Duration = Duration::from_secs(240);
const BITRATE_FLOOR: u64 = 500_000;

/// libwebrtc starts low and probes upward, so a frame sized for the cap would only queue.
const BITRATE_START: u64 = 3_000_000;

pub fn starting_bitrate(cap: u64) -> u64 {
    cap.min(BITRATE_START)
}

/// Whether a frame should be a keyframe: one someone asked for, though not straight after
/// another, or a regular one, where those were asked for, counted from the last of any kind.
/// Nothing needs a regular one, as one is asked for whenever someone joins or can't
/// decode, and each is a burst that someone watching waits for.
fn keyframe_due(since_last: Option<Duration>, asked: bool, every: Option<Duration>) -> bool {
    match since_last {
        None => asked,
        Some(since) => (asked && since >= KEYFRAME_MIN_GAP) || every.is_some_and(|every| since >= every),
    }
}

/// The bitrate the encoder is set to, and when it follows libwebrtc's estimate.
struct Bitrate {
    now: u64,
    cap: u64,
    /// It hasn't had to fall since the start.
    climbing: bool,
    /// The last change was a rise.
    rose: bool,
    /// How long a rise waits after the last change, once it's had to fall.
    rise_gap: Duration,
}

impl Bitrate {
    fn new(now: u64, cap: u64) -> Self {
        Self { now, cap, climbing: true, rose: false, rise_gap: BITRATE_RISE_GAP }
    }

    /// Goes to `wanted`, `since` the last change, if that's worth its keyframe, and says
    /// whether it did.
    fn follow(&mut self, wanted: u64, since: Duration) -> bool {
        // A rise that's held this long was what the link takes.
        if self.rose && since >= BITRATE_RISE_GAP {
            self.rise_gap = BITRATE_RISE_GAP;
        }
        let ratio = wanted as f64 / self.now as f64;
        let go = if wanted < self.now {
            ratio <= BITRATE_URGENT_DROP || (ratio <= 1.0 / BITRATE_MIN_CHANGE && since >= BITRATE_MIN_GAP)
        } else if wanted > self.now {
            // Only a little short of the cap is still worth reaching it.
            let far_enough = ratio >= BITRATE_MIN_CHANGE || wanted == self.cap;
            far_enough && since >= if self.climbing { BITRATE_MIN_GAP } else { self.rise_gap }
        } else {
            false
        };
        if !go {
            return false;
        }
        let rising = wanted > self.now;
        // A fall soon after a rise says it was more than the link takes.
        if !self.climbing && self.rose && !rising && since < BITRATE_RISE_GAP {
            self.rise_gap = (self.rise_gap * 2).min(BITRATE_RISE_GAP_MOST);
        }
        self.climbing &= rising;
        self.rose = rising;
        self.now = wanted;
        true
    }
}

/// How far apart things happened, for the mean and how much they wander from it.
#[derive(Default)]
struct Gaps {
    count: u64,
    sum: f64,
    squares: f64,
}

impl Gaps {
    /// The time since the last, of which there's none for the first.
    fn add(&mut self, gap: Option<Duration>) {
        if let Some(gap) = gap {
            let ms = gap.as_secs_f64() * 1000.0;
            self.count += 1;
            self.sum += ms;
            self.squares += ms * ms;
        }
    }

    fn mean_and_deviation(&self) -> (f64, f64) {
        if self.count == 0 {
            return (0.0, 0.0);
        }
        let mean = self.sum / self.count as f64;
        (mean, (self.squares / self.count as f64 - mean * mean).max(0.0).sqrt())
    }
}

#[derive(Default)]
struct Window {
    frames: u64,
    repeats: u64,
    /// Frames the compositor sent too far ahead of their turn, which were left out.
    early: u64,
    /// Between frames as the compositor sends them, and as new ones go to the encoder.
    arrivals: Gaps,
    spacing: Gaps,
    bytes: u64,
    encode_time: Duration,
    encode_time_max: Duration,
    keys: u64,
    key_requests: u64,
    rejected: u64,
    bitrate_changes: u64,
}

impl Window {
    /// Adds what went on in another window to the totals.
    fn add_to(&self, totals: &mut Window) {
        totals.frames += self.frames;
        totals.keys += self.keys;
        totals.key_requests += self.key_requests;
        totals.bitrate_changes += self.bitrate_changes;
    }
}

pub struct Pipeline {
    encoder: Encoder,
    output: Box<dyn Output>,
    /// Hears how it's going, once a second.
    report: Box<dyn FnMut(serde_json::Value) + Send>,
    codec: Codec,
    /// H.264's alone: AV1 goes out as the encoder made it, as LiveKit takes it.
    rewriter: Rewriter,
    prepared: Vec<u8>,
    width: u32,
    height: u32,
    interval: Duration,
    started: Instant,
    started_wall_us: i64,
    last_encode: Option<Instant>,
    frame_due: Instant,
    last_change: Instant,
    key_pending: bool,
    /// When the last keyframe was asked for or went out, whatever it was for.
    last_key: Option<Instant>,
    keyframe_every: Option<Duration>,
    bitrate: Bitrate,
    bitrate_wanted: u64,
    last_bitrate_change: Instant,
    window: Window,
    window_started: Instant,
    cpu_at_window_start: Duration,
    totals: Window,
    last_arrival: Option<Duration>,
    last_new_frame: Option<Instant>,
}

impl Pipeline {
    /// A regular keyframe, where there's to be one, is asked for `keyframe_every` after the
    /// last of any kind.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        encoder: Encoder,
        codec: Codec,
        output: Box<dyn Output>,
        report: Box<dyn FnMut(serde_json::Value) + Send>,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_now: u64,
        bitrate_cap: u64,
        keyframe_every: Option<Duration>,
    ) -> Self {
        let now = Instant::now();
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        Self {
            encoder,
            output,
            report,
            codec,
            // Keyframes are rewritten for LiveKit's frame cryptor (h264.rs).
            rewriter: Rewriter::new(true),
            prepared: Vec::with_capacity(1 << 20),
            width,
            height,
            interval: Duration::from_secs_f64(1.0 / fps as f64),
            started: now,
            started_wall_us: wall.as_micros() as i64,
            last_encode: None,
            frame_due: now,
            last_change: now,
            key_pending: false,
            last_key: None,
            keyframe_every,
            bitrate: Bitrate::new(bitrate_now, bitrate_cap),
            bitrate_wanted: bitrate_now,
            last_bitrate_change: now,
            window: Window::default(),
            window_started: now,
            cpu_at_window_start: cpu::time_used(),
            totals: Window::default(),
            last_arrival: None,
            last_new_frame: None,
        }
    }

    /// The earliest a new frame should be encoded.
    pub fn next_due(&self) -> Instant {
        self.frame_due
    }

    /// A frame came from the compositor, whether or not it's encoded: at a time on a clock of
    /// the capture's own, where it says, and otherwise now.
    pub fn note_arrival(&mut self, at: Option<Duration>) {
        let at = at.unwrap_or_else(|| self.started.elapsed());
        self.window.arrivals.add(self.last_arrival.map(|last| at.saturating_sub(last)));
        self.last_arrival = Some(at);
    }

    /// A frame came too far ahead of its turn and was left out.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn note_early(&mut self) {
        self.window.early += 1;
    }

    /// What the encoder is set to send now.
    pub fn bitrate(&self) -> u64 {
        self.bitrate.now
    }

    /// Goes on with another encoder, for a picture that changed size. Its first frame is
    /// a keyframe at the new size, and is encoded as soon as it comes.
    pub fn restart(&mut self, encoder: Encoder, width: u32, height: u32) {
        self.encoder = encoder;
        self.width = width;
        self.height = height;
        // The new encoder has nothing to repeat until it's had a frame.
        self.last_encode = None;
        self.frame_due = Instant::now();
    }

    /// How long the capture can wait for a new frame before calling `on_idle`.
    pub fn idle_wait(&self) -> Duration {
        let now = Instant::now();
        let Some(last) = self.last_encode else { return self.interval };
        let mut gap = if self.key_pending || now.duration_since(self.last_change) < REFINE_FOR { self.interval } else { STILL_INTERVAL };
        // The last encode was a new frame, and the next may only be running late. The
        // compositor sends frames at its own pace and a little unevenly, so a repeat on
        // the interval would go out just before each late frame. On Linux that made more
        // frames than the frame rate, and more bits than the bitrate, since the encoder
        // budgets for the frame rate. On Windows the late frame then waited for the next
        // turn, by which time a newer one had taken its place: a video at 60 fps went out
        // as 30 new frames and 30 repeats.
        if last == self.last_change {
            gap += self.interval;
        }
        (last + gap).saturating_duration_since(now)
    }

    pub fn on_frame(&mut self, input: Input) -> Result<()> {
        self.poll_feedback();
        let force_key = self.before_encode()?;
        let pts = self.pts();
        let began = Instant::now();
        self.window.spacing.add(self.last_new_frame.map(|last| began.duration_since(last)));
        self.last_new_frame = Some(began);
        self.encoder.send(input, pts, force_key)?;
        self.last_change = began;
        self.after_encode(began, false)
    }

    pub fn on_idle(&mut self) -> Result<()> {
        self.poll_feedback();
        if self.idle_wait().is_zero() && self.last_encode.is_some() {
            let force_key = self.before_encode()?;
            let pts = self.pts();
            let began = Instant::now();
            self.encoder.repeat(pts, force_key)?;
            self.after_encode(began, true)?;
        }
        self.report_if_due();
        Ok(())
    }

    fn pts(&self) -> i64 {
        self.started.elapsed().as_micros() as i64
    }

    /// Settles what the next encode is: whether it's a keyframe, and at what bitrate.
    fn before_encode(&mut self) -> Result<bool> {
        let now = Instant::now();
        let key = keyframe_due(self.last_key.map(|last| now.duration_since(last)), self.key_pending, self.keyframe_every);
        let changed = self.follow_bitrate(now)?;
        // A new bitrate comes with a keyframe, which answers anyone who asked for one.
        if key || changed {
            self.key_pending = false;
            self.last_key = Some(now);
        }
        Ok(key || changed)
    }

    fn after_encode(&mut self, began: Instant, repeat: bool) -> Result<()> {
        self.drain(began)?;
        let took = began.elapsed();
        self.last_encode = Some(began);
        // Counted from when the last frame was due and not from when it went, or waking
        // a little late each time would add up to a lower frame rate.
        let next = self.frame_due + self.interval;
        self.frame_due = if next > began { next } else { began + self.interval };
        self.window.encode_time += took;
        self.window.encode_time_max = self.window.encode_time_max.max(took);
        if repeat {
            self.window.repeats += 1;
        } else {
            self.window.frames += 1;
        }
        self.report_if_due();
        Ok(())
    }

    fn drain(&mut self, began: Instant) -> Result<()> {
        let mut got_one = false;
        loop {
            match self.encoder.receive()? {
                Some(packet) => {
                    got_one = true;
                    self.prepared.clear();
                    match self.codec {
                        Codec::H264 => self.rewriter.prepare(packet.data, &mut self.prepared),
                        Codec::Av1 => self.prepared.extend_from_slice(packet.data),
                    }
                    self.window.bytes += self.prepared.len() as u64;
                    self.window.keys += packet.key as u64;
                    // Asked for or not, as an encoder's first frame is.
                    if packet.key {
                        self.last_key = Some(Instant::now());
                    }
                    let frame = EncodedFrame { codec: self.codec, data: &self.prepared, timestamp_us: self.started_wall_us + packet.pts, key: packet.key, width: self.width, height: self.height };
                    self.window.rejected += !self.output.send(&frame) as u64;
                }
                None if got_one || began.elapsed() >= PACKET_WAIT => return Ok(()),
                None => thread::sleep(Duration::from_micros(200)),
            }
        }
    }

    fn poll_feedback(&mut self) {
        if self.output.take_keyframe_request() {
            self.key_pending = true;
            self.window.key_requests += 1;
        }
        // Zero means libwebrtc has paused sending, which isn't a bitrate to encode at.
        if let Some(target) = self.output.take_target_bitrate().filter(|&target| target > 0) {
            self.bitrate_wanted = target.clamp(BITRATE_FLOOR.min(self.bitrate.cap), self.bitrate.cap);
        }
    }

    /// Gives the encoder the bitrate libwebrtc wants if that's worth a keyframe, and
    /// says whether it did.
    fn follow_bitrate(&mut self, now: Instant) -> Result<bool> {
        let was = self.bitrate.now;
        if !self.bitrate.follow(self.bitrate_wanted, now.duration_since(self.last_bitrate_change)) {
            return Ok(false);
        }
        self.encoder.set_bitrate(self.bitrate.now)?;
        log::debug!("bitrate {was} -> {}", self.bitrate.now);
        self.last_bitrate_change = now;
        self.window.bitrate_changes += 1;
        Ok(true)
    }

    fn report_if_due(&mut self) {
        let elapsed = self.window_started.elapsed();
        if elapsed < Duration::from_secs(1) {
            return;
        }
        let window = std::mem::take(&mut self.window);
        let seconds = elapsed.as_secs_f64();
        let encodes = (window.frames + window.repeats).max(1) as f64;
        let cpu_now = cpu::time_used();
        let (arrival_ms, arrival_jitter) = window.arrivals.mean_and_deviation();
        let (spacing_ms, spacing_jitter) = window.spacing.mean_and_deviation();
        (self.report)(serde_json::json!({
            "t": self.started.elapsed().as_secs_f64(),
            "width": self.width,
            "height": self.height,
            "fps": window.frames as f64 / seconds,
            "repeatFps": window.repeats as f64 / seconds,
            "earlyFps": window.early as f64 / seconds,
            "arrivalMs": arrival_ms,
            "arrivalJitterMs": arrival_jitter,
            "spacingMs": spacing_ms,
            "spacingJitterMs": spacing_jitter,
            "kbps": window.bytes as f64 * 8.0 / seconds / 1000.0,
            "targetKbps": self.bitrate_wanted / 1000,
            "encoderKbps": self.bitrate.now / 1000,
            "encodeMsAvg": window.encode_time.as_secs_f64() * 1000.0 / encodes,
            "encodeMsMax": window.encode_time_max.as_secs_f64() * 1000.0,
            "keys": window.keys,
            "keyRequests": window.key_requests,
            "bitrateChanges": window.bitrate_changes,
            "allKeys": self.totals.keys + window.keys,
            "allKeyRequests": self.totals.key_requests + window.key_requests,
            "allBitrateChanges": self.totals.bitrate_changes + window.bitrate_changes,
            "rejected": window.rejected,
            "codec": self.codec.name(),
            "idrRewritten": self.rewriter.idr_rewritten,
            "idrLeftAlone": self.rewriter.idr_left_alone,
            "cpuCores": (cpu_now - self.cpu_at_window_start).as_secs_f64() / seconds,
        }));
        window.add_to(&mut self.totals);
        self.window_started = Instant::now();
        self.cpu_at_window_start = cpu_now;
    }

    pub fn encoder_name(&self) -> &str {
        &self.encoder.codec
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MBIT: u64 = 1_000_000;
    const EVERY: Duration = Duration::from_secs(10);
    const SECOND: Duration = Duration::from_secs(1);

    /// The rule before this one: a regular keyframe every 10 s, which a rise waited for once
    /// the bitrate had had to fall.
    struct Before {
        now: u64,
        cap: u64,
        climbing: bool,
    }

    impl Before {
        fn follow(&mut self, wanted: u64, waited: bool, key: bool) -> bool {
            let ratio = wanted as f64 / self.now as f64;
            let go = if wanted < self.now {
                ratio <= BITRATE_URGENT_DROP || (ratio <= 1.0 / BITRATE_MIN_CHANGE && waited)
            } else if wanted > self.now {
                (ratio >= BITRATE_MIN_CHANGE || wanted == self.cap) && (key || (self.climbing && waited))
            } else {
                false
            };
            if go {
                self.climbing &= wanted > self.now;
                self.now = wanted;
            }
            go
        }
    }

    /// What a share did: its keyframes and bitrate changes, when it first reached the cap,
    /// the seconds it sent more than the link takes, and the bitrate it ended at.
    #[derive(Debug, Default)]
    struct Share {
        keys: u32,
        changes: u32,
        reached_cap: Option<f64>,
        overloaded: f64,
        end: u64,
    }

    /// Makes the decisions `before_encode` makes, a frame at a time at 60 fps, by the rule
    /// before this one or by this one, with libwebrtc wanting what `wanted` says at each
    /// moment from what's sent, and the link taking what `link` says.
    fn run(before: bool, start: u64, cap: u64, seconds: f64, link: impl Fn(f64) -> u64, wanted: impl Fn(f64, u64) -> u64) -> Share {
        let mut old = Before { now: start, cap, climbing: true };
        let mut new = Bitrate::new(start, cap);
        let every = before.then_some(EVERY);
        let (mut last_change, mut last_key) = (0.0, 0.0);
        let mut share = Share { keys: 1, ..Share::default() };
        let step = 1.0 / 60.0;
        let mut t = 0.0;
        while t < seconds {
            t += step;
            let key = keyframe_due(Some(Duration::from_secs_f64(t - last_key)), false, every);
            let wanted = wanted(t, if before { old.now } else { new.now });
            let since = Duration::from_secs_f64(t - last_change);
            let changed = if before { old.follow(wanted, since >= BITRATE_MIN_GAP, key) } else { new.follow(wanted, since) };
            if changed {
                last_change = t;
                share.changes += 1;
            }
            if key || changed {
                last_key = t;
                share.keys += 1;
            }
            share.end = if before { old.now } else { new.now };
            if share.end == cap && share.reached_cap.is_none() {
                share.reached_cap = Some(t);
            }
            if share.end > link(t) {
                share.overloaded += step;
            }
        }
        share
    }

    /// libwebrtc's estimate as it was in a call: half as much again as what's sent while the
    /// link takes that, up to the cap, and 85% of the link once more is sent than it takes.
    fn estimate(cap: u64, link: impl Fn(f64) -> u64) -> impl Fn(f64, u64) -> u64 {
        move |t, sent| if sent > link(t) { link(t) / 100 * 85 } else { (sent / 2 * 3).min(cap) }
    }

    #[test]
    fn a_keyframe_is_asked_for_at_most_every_quarter_second_and_regularly_only_where_asked() {
        assert!(keyframe_due(None, true, None));
        assert!(!keyframe_due(None, false, None));
        assert!(!keyframe_due(Some(Duration::from_millis(100)), true, None));
        assert!(keyframe_due(Some(KEYFRAME_MIN_GAP), true, None));
        assert!(!keyframe_due(Some(Duration::from_secs(3600)), false, None));
        assert!(!keyframe_due(Some(Duration::from_millis(9_999)), false, Some(EVERY)));
        assert!(keyframe_due(Some(EVERY), false, Some(EVERY)));
    }

    #[test]
    fn a_fall_goes_after_the_pause_or_at_once_when_it_is_a_long_way() {
        let falls = |wanted: u64, since: Duration| {
            let mut bitrate = Bitrate::new(40 * MBIT, 40 * MBIT);
            bitrate.climbing = false;
            bitrate.follow(wanted, since)
        };
        assert!(falls(30 * MBIT, BITRATE_MIN_GAP));
        assert!(!falls(30 * MBIT, SECOND));
        assert!(falls(20 * MBIT, Duration::ZERO));
        assert!(!falls(35 * MBIT, BITRATE_RISE_GAP));
    }

    #[test]
    fn a_rise_after_a_fall_waits_half_a_minute_and_twice_as_long_after_one_that_was_too_much() {
        let mut bitrate = Bitrate::new(40 * MBIT, 100 * MBIT);
        assert!(bitrate.follow(30 * MBIT, BITRATE_MIN_GAP));
        assert!(!bitrate.climbing);
        assert!(!bitrate.follow(45 * MBIT, BITRATE_RISE_GAP - SECOND));
        assert!(!bitrate.follow(33 * MBIT, BITRATE_RISE_GAP));
        assert!(bitrate.follow(45 * MBIT, BITRATE_RISE_GAP));
        // Back down soon after, so the next waits twice as long, and again up to the most.
        assert!(bitrate.follow(30 * MBIT, BITRATE_MIN_GAP));
        assert!(!bitrate.follow(45 * MBIT, BITRATE_RISE_GAP));
        assert!(bitrate.follow(45 * MBIT, BITRATE_RISE_GAP * 2));
        for _ in 0..5 {
            assert!(bitrate.follow(30 * MBIT, BITRATE_MIN_GAP));
            assert!(bitrate.follow(45 * MBIT, BITRATE_RISE_GAP_MOST));
        }
        assert_eq!(bitrate.rise_gap, BITRATE_RISE_GAP_MOST);
        // A rise that held for half a minute was what the link takes, so the next goes as soon.
        assert!(bitrate.follow(60 * MBIT, BITRATE_RISE_GAP));
        assert_eq!(bitrate.rise_gap, BITRATE_RISE_GAP);
        assert!(bitrate.follow(30 * MBIT, BITRATE_RISE_GAP));
        assert_eq!(bitrate.rise_gap, BITRATE_RISE_GAP);
    }

    #[test]
    fn the_first_climb_is_as_quick_as_before() {
        let mut bitrate = Bitrate::new(3 * MBIT, 40 * MBIT);
        assert!(!bitrate.follow(4 * MBIT, SECOND));
        assert!(bitrate.follow(4 * MBIT, BITRATE_MIN_GAP));
        // About 1 Mbit/s a second, as measured, since libwebrtc only raises its estimate a little
        // past what's sent, so a climb held back would only climb slower.
        let climb = |t: f64, _: u64| ((3.0 + t) * MBIT as f64).min(40.0 * MBIT as f64) as u64;
        let before = run(true, 3 * MBIT, 40 * MBIT, 60.0, |_| u64::MAX, climb);
        let now = run(false, 3 * MBIT, 40 * MBIT, 60.0, |_| u64::MAX, climb);
        assert!(now.reached_cap.is_some() && now.reached_cap == before.reached_cap, "{now:?} against {before:?}");
    }

    #[test]
    fn an_estimate_going_back_and_forth_costs_far_fewer_keyframes() {
        // Between the cap and three quarters of it, every 4 seconds, for two minutes.
        let back_and_forth = |t: f64, _: u64| if (t / 4.0) as u64 % 2 == 0 { 40 * MBIT } else { 30 * MBIT };
        let before = run(true, 40 * MBIT, 40 * MBIT, 120.0, |_| u64::MAX, back_and_forth);
        let now = run(false, 40 * MBIT, 40 * MBIT, 120.0, |_| u64::MAX, back_and_forth);
        assert!(now.keys * 2 <= before.keys && now.changes <= before.changes, "{now:?} against {before:?}");
    }

    #[test]
    fn an_estimate_past_what_the_link_takes_is_tried_less_and_less() {
        // As in a call from Windows: a 100 Mbit/s cap, and a link that took about 40.
        let link = |_| 40 * MBIT;
        let before = run(true, 3 * MBIT, 100 * MBIT, 600.0, link, estimate(100 * MBIT, link));
        let now = run(false, 3 * MBIT, 100 * MBIT, 600.0, link, estimate(100 * MBIT, link));
        let report = format!("{now:?} against {before:?}");
        assert!(now.keys * 4 <= before.keys && now.overloaded * 4.0 <= before.overloaded, "{report}");
        assert!(now.end <= 40 * MBIT && now.end >= 30 * MBIT, "{report}");
    }

    #[test]
    fn a_link_that_takes_more_later_is_found() {
        // 40 Mbit/s for two minutes, and 80 after.
        let link = |t: f64| if t < 120.0 { 40 * MBIT } else { 80 * MBIT };
        let now = run(false, 3 * MBIT, 100 * MBIT, 600.0, link, estimate(100 * MBIT, link));
        assert!(now.end > 60 * MBIT && now.end <= 80 * MBIT, "{now:?}");
    }
}
