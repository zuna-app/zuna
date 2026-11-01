//! What happens to a captured frame: when to encode it, where the result goes, and
//! how the network's feedback reaches the encoder. The capture modules drive this.

use std::{
    fs::File,
    io::{BufWriter, Write},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    cpu,
    encoder::{Encoder, Input, Result},
    h264::Rewriter,
};

#[cfg(feature = "livekit")]
use livekit::webrtc::{
    video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame},
    video_source::{native::NativeVideoSource, VideoResolution},
};

/// A still screen gets this long at the full frame rate, for the encoder to sharpen
/// it, and then only a trickle of frames to keep the stream alive.
const REFINE_FOR: Duration = Duration::from_millis(500);
const STILL_INTERVAL: Duration = Duration::from_millis(200);

/// A browser asks again while a keyframe is on its way, so answer at this pace.
const KEYFRAME_MIN_GAP: Duration = Duration::from_millis(250);

/// How long to wait for an asynchronous encoder before moving on to the next frame.
const PACKET_WAIT: Duration = Duration::from_millis(40);

/// Every bitrate change costs a keyframe, because FFmpeg resets NVENC to make it and
/// the other encoders only take a bitrate when opened. libwebrtc revises its estimate
/// several times a second, so ignore small changes and pace the rest. Falling a long
/// way is the exception, since that means the network is already overloaded.
const BITRATE_MIN_GAP: Duration = Duration::from_secs(2);
const BITRATE_MIN_CHANGE: f64 = 1.25;
const BITRATE_URGENT_DROP: f64 = 0.6;
const BITRATE_FLOOR: u64 = 500_000;

/// libwebrtc starts low and probes upward, so a frame sized for the cap would only queue.
const BITRATE_START: u64 = 3_000_000;

pub fn starting_bitrate(cap: u64, publishing: bool) -> u64 {
    if publishing {
        cap.min(BITRATE_START)
    } else {
        cap
    }
}

pub enum Sink {
    File { prepared: BufWriter<File>, raw: Option<BufWriter<File>> },
    #[cfg(feature = "livekit")]
    LiveKit(NativeVideoSource),
}

#[derive(Default)]
struct Window {
    frames: u64,
    repeats: u64,
    bytes: u64,
    encode_time: Duration,
    encode_time_max: Duration,
    keys: u64,
    key_requests: u64,
    rejected: u64,
    bitrate_changes: u64,
}

pub struct Pipeline {
    encoder: Encoder,
    sink: Sink,
    rewriter: Rewriter,
    prepared: Vec<u8>,
    width: u32,
    height: u32,
    interval: Duration,
    started: Instant,
    started_wall_us: i64,
    last_encode: Option<Instant>,
    last_change: Instant,
    key_pending: bool,
    last_key: Option<Instant>,
    bitrate_cap: u64,
    bitrate_now: u64,
    bitrate_wanted: u64,
    last_bitrate_change: Instant,
    window: Window,
    window_started: Instant,
    cpu_at_window_start: Duration,
    totals: Window,
}

impl Pipeline {
    pub fn new(encoder: Encoder, sink: Sink, width: u32, height: u32, fps: u32, bitrate_now: u64, bitrate_cap: u64, fix_idr: bool) -> Self {
        let now = Instant::now();
        let wall = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
        Self {
            encoder,
            sink,
            rewriter: Rewriter::new(fix_idr),
            prepared: Vec::with_capacity(1 << 20),
            width,
            height,
            interval: Duration::from_secs_f64(1.0 / fps as f64),
            started: now,
            started_wall_us: wall.as_micros() as i64,
            last_encode: None,
            last_change: now,
            key_pending: false,
            last_key: None,
            bitrate_cap,
            bitrate_now,
            bitrate_wanted: bitrate_now,
            last_bitrate_change: now,
            window: Window::default(),
            window_started: now,
            cpu_at_window_start: cpu::time_used(),
            totals: Window::default(),
        }
    }

    /// The earliest a new frame should be encoded.
    pub fn next_due(&self) -> Instant {
        self.last_encode.map_or_else(Instant::now, |last| last + self.interval)
    }

    /// How long the capture can wait for a new frame before calling `on_idle`.
    pub fn idle_wait(&self) -> Duration {
        let now = Instant::now();
        let Some(last) = self.last_encode else { return self.interval };
        let gap = if self.key_pending || now.duration_since(self.last_change) < REFINE_FOR { self.interval } else { STILL_INTERVAL };
        (last + gap).saturating_duration_since(now)
    }

    pub fn on_frame(&mut self, input: Input) -> Result<()> {
        self.poll_feedback()?;
        let force_key = self.take_key_request();
        let pts = self.pts();
        let began = Instant::now();
        self.encoder.send(input, pts, force_key)?;
        self.last_change = began;
        self.after_encode(began, false)
    }

    pub fn on_idle(&mut self) -> Result<()> {
        self.poll_feedback()?;
        if self.idle_wait().is_zero() && self.last_encode.is_some() {
            let force_key = self.take_key_request();
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

    fn take_key_request(&mut self) -> bool {
        let now = Instant::now();
        if !self.key_pending || self.last_key.is_some_and(|last| now.duration_since(last) < KEYFRAME_MIN_GAP) {
            return false;
        }
        self.key_pending = false;
        self.last_key = Some(now);
        true
    }

    fn after_encode(&mut self, began: Instant, repeat: bool) -> Result<()> {
        self.drain(began)?;
        let took = began.elapsed();
        self.last_encode = Some(began);
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
                    self.rewriter.prepare(packet.data, &mut self.prepared);
                    self.window.bytes += self.prepared.len() as u64;
                    self.window.keys += packet.key as u64;
                    deliver(&mut self.sink, &self.prepared, packet.data, packet.key, self.started_wall_us + packet.pts, self.width, self.height, &mut self.window);
                }
                None if got_one || began.elapsed() >= PACKET_WAIT => return Ok(()),
                None => thread::sleep(Duration::from_micros(200)),
            }
        }
    }

    #[cfg(feature = "livekit")]
    fn poll_feedback(&mut self) -> Result<()> {
        if let Sink::LiveKit(source) = &self.sink {
            if source.take_keyframe_request() {
                self.key_pending = true;
                self.window.key_requests += 1;
            }
            // Zero means libwebrtc has paused sending, which isn't a bitrate to encode at.
            if let Some(request) = source.take_rate_control_request().filter(|request| request.target_bitrate_bps > 0) {
                self.bitrate_wanted = request.target_bitrate_bps.clamp(BITRATE_FLOOR, self.bitrate_cap);
            }
        }
        self.follow_bitrate()
    }

    #[cfg(not(feature = "livekit"))]
    fn poll_feedback(&mut self) -> Result<()> {
        Ok(())
    }

    #[cfg_attr(not(feature = "livekit"), allow(dead_code))]
    fn follow_bitrate(&mut self) -> Result<()> {
        let ratio = self.bitrate_wanted as f64 / self.bitrate_now as f64;
        let waited = self.last_bitrate_change.elapsed() >= BITRATE_MIN_GAP;
        let reached_the_cap = self.bitrate_wanted == self.bitrate_cap && self.bitrate_now != self.bitrate_cap && waited;
        let worth_it = ratio >= BITRATE_MIN_CHANGE || ratio <= 1.0 / BITRATE_MIN_CHANGE;
        if ratio <= BITRATE_URGENT_DROP || reached_the_cap || (worth_it && waited) {
            self.encoder.set_bitrate(self.bitrate_wanted)?;
            log::debug!("bitrate {} -> {}", self.bitrate_now, self.bitrate_wanted);
            self.bitrate_now = self.bitrate_wanted;
            self.last_bitrate_change = Instant::now();
            self.window.bitrate_changes += 1;
        }
        Ok(())
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
        println!(
            "{{\"type\":\"stats\",\"t\":{:.1},\"fps\":{:.1},\"repeatFps\":{:.1},\"kbps\":{:.0},\"targetKbps\":{},\"encoderKbps\":{},\"encodeMsAvg\":{:.2},\"encodeMsMax\":{:.2},\"keys\":{},\"keyRequests\":{},\"bitrateChanges\":{},\"rejected\":{},\"idrRewritten\":{},\"idrLeftAlone\":{},\"cpuCores\":{:.3}}}",
            self.started.elapsed().as_secs_f64(),
            window.frames as f64 / seconds,
            window.repeats as f64 / seconds,
            window.bytes as f64 * 8.0 / seconds / 1000.0,
            self.bitrate_wanted / 1000,
            self.bitrate_now / 1000,
            window.encode_time.as_secs_f64() * 1000.0 / encodes,
            window.encode_time_max.as_secs_f64() * 1000.0,
            window.keys,
            window.key_requests,
            window.bitrate_changes,
            window.rejected,
            self.rewriter.idr_rewritten,
            self.rewriter.idr_left_alone,
            (cpu_now - self.cpu_at_window_start).as_secs_f64() / seconds,
        );
        self.totals.frames += window.frames;
        self.window_started = Instant::now();
        self.cpu_at_window_start = cpu_now;
    }

    pub fn encoder_name(&self) -> &str {
        &self.encoder.codec
    }

    pub fn finish(&mut self) {
        if let Sink::File { prepared, raw } = &mut self.sink {
            let _ = prepared.flush();
            if let Some(raw) = raw {
                let _ = raw.flush();
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[cfg_attr(not(feature = "livekit"), allow(unused_variables))]
fn deliver(sink: &mut Sink, prepared: &[u8], raw_packet: &[u8], key: bool, timestamp_us: i64, width: u32, height: u32, window: &mut Window) {
    match sink {
        Sink::File { prepared: file, raw } => {
            let _ = file.write_all(prepared);
            if let Some(raw) = raw {
                let _ = raw.write_all(raw_packet);
            }
        }
        #[cfg(feature = "livekit")]
        Sink::LiveKit(source) => {
            let accepted = source.capture_encoded_frame(&EncodedVideoFrame {
                codec: EncodedVideoCodec::H264,
                payload: prepared,
                timestamp_us,
                frame_type: if key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                resolution: VideoResolution { width, height },
                frame_metadata: None,
            });
            window.rejected += !accepted as u64;
        }
    }
}
