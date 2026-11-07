//! The sound devices, through cpal on Windows (WASAPI) and macOS (Core Audio), and PipeWire on Linux
//! (`voice/pipewire.rs`): everyone's voices and the app's own sounds mixed onto one output,
//! and the microphone read at 48 kHz, as a browser's AudioContext does for the desktop.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};

#[cfg(any(windows, target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;

/// Everything here works at this rate, as WebRTC and RNNoise do.
pub const RATE: u32 = 48_000;
/// 10 ms, which WebRTC's processing and RNNoise each take at a time.
pub const FRAME: usize = 480;

/// A device the person can choose, by the name the system gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
}

#[cfg(any(windows, target_os = "macos"))]
fn find(input: bool, id: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if id != "default" {
        let found = if input { host.input_devices().ok() } else { host.output_devices().ok() }.and_then(|mut devices| devices.find(|device| device.name().ok().as_deref() == Some(id)));
        if found.is_some() {
            return found;
        }
    }
    if input { host.default_input_device() } else { host.default_output_device() }
}

/// The microphones or the speakers, with the default first.
#[cfg(target_os = "linux")]
pub fn devices(input: bool) -> Vec<Device> {
    super::pipewire::devices(input)
}

/// The microphones or the speakers, with the default first.
#[cfg(windows)]
pub fn devices(input: bool) -> Vec<Device> {
    listed(input)
}

/// The microphones or the speakers, with the default first, as Core Audio last listed them.
/// Core Audio can take a long while to answer, or not answer at all, while a device's driver
/// hangs, which would stop the window as it's drawn, so the list is read on a thread of its
/// own, again each time it's asked for and none is being read, and this gives the last one read.
#[cfg(target_os = "macos")]
pub fn devices(input: bool) -> Vec<Device> {
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};
    struct Lists {
        inputs: Vec<Device>,
        outputs: Vec<Device>,
        reading: bool,
        read_at: Option<Instant>,
    }
    static LISTS: OnceLock<Mutex<Lists>> = OnceLock::new();
    let lists = LISTS.get_or_init(|| Mutex::new(Lists { inputs: Vec::new(), outputs: Vec::new(), reading: false, read_at: None }));
    let mut current = lists.lock();
    let stale = current.read_at.is_none_or(|at| at.elapsed() > Duration::from_secs(2));
    if stale && !current.reading {
        current.reading = true;
        std::thread::Builder::new()
            .name("zuna-sound-devices".into())
            .spawn(move || {
                let (inputs, outputs) = (listed(true), listed(false));
                let mut current = lists.lock();
                (current.inputs, current.outputs, current.reading, current.read_at) = (inputs, outputs, false, Some(Instant::now()));
            })
            .ok();
    }
    let list = if input { &current.inputs } else { &current.outputs };
    if list.is_empty() { vec![Device { id: "default".into(), name: "Default".into() }] } else { list.clone() }
}

#[cfg(any(windows, target_os = "macos"))]
fn listed(input: bool) -> Vec<Device> {
    let host = cpal::default_host();
    let mut list = vec![Device { id: "default".into(), name: "Default".into() }];
    if let Ok(devices) = if input { host.input_devices() } else { host.output_devices() } {
        for device in devices {
            if let Ok(name) = device.name() {
                list.push(Device { id: name.clone(), name });
            }
        }
    }
    list
}

/// WebRTC's processing, shared by the microphone and what's played, which its echo cancelling compares.
pub struct Processing(pub livekit::webrtc::native::apm::AudioProcessingModule);
// WebRTC's audio processing is made to be given the capture and the render side from their own threads.
unsafe impl Send for Processing {}

pub type SharedProcessing = Arc<Mutex<Option<Processing>>>;

// --- Output ---

/// One thing being played: a person's voice, a share's sound, a sound from the soundboard.
struct Source {
    /// Interleaved stereo at 48 kHz.
    buffer: VecDeque<f32>,
    volume: f32,
    /// Live sound plays `LIVE_DELAY` behind what's arrived, and keeps to it.
    live: bool,
    /// Live sound that hasn't got `LIVE_DELAY` in hand yet, as it starts or after it ran out.
    waiting: bool,
    /// Gone once it's played out.
    once: bool,
}

#[derive(Default)]
struct MixerState {
    sources: HashMap<u64, Source>,
}

/// Everything played, mixed into one output on the chosen device.
#[derive(Clone)]
pub struct Mixer {
    state: Arc<Mutex<MixerState>>,
    next: Arc<AtomicU64>,
    processing: SharedProcessing,
    output: Arc<Mutex<Option<OutputThread>>>,
}

/// How far behind what's arrived live sound plays, in frames: 40 ms. LiveKit hands each 10 ms
/// of a voice over on a timer of its own, sometimes late, and the device takes it on its own
/// clock, so playing what's just arrived goes quiet whenever a piece is late.
const LIVE_DELAY: usize = RATE as usize / 25;
/// Live sound that falls further behind than this drops what's oldest: 200 ms, stereo. That's
/// only while nothing plays it, as playing keeps it near `LIVE_DELAY`.
const LIVE_LIMIT: usize = (RATE as usize / 5) * 2;

impl Mixer {
    pub fn new(processing: SharedProcessing) -> Mixer {
        Mixer { state: Arc::default(), next: Arc::new(AtomicU64::new(1)), processing, output: Arc::default() }
    }

    /// Plays on a device, by its ID, or the default one. It moves there if it's already playing.
    pub fn open(&self, device: &str) {
        let mut output = self.output.lock();
        if output.as_ref().is_some_and(|thread| thread.device == device && !thread.failed.load(Ordering::Relaxed)) {
            return;
        }
        *output = None;
        *output = OutputThread::start(device.to_string(), self.state.clone(), self.processing.clone());
    }

    /// A place to send live sound, such as a person's voice.
    pub fn live(&self, volume: f32) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.state.lock().sources.insert(id, Source { buffer: VecDeque::new(), volume, live: true, waiting: true, once: false });
        id
    }

    /// Plays a sound once, interleaved stereo at 48 kHz.
    pub fn once(&self, samples: Vec<f32>, volume: f32) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.state.lock().sources.insert(id, Source { buffer: samples.into(), volume, live: false, waiting: false, once: true });
    }

    /// More of a live sound, mono or stereo at 48 kHz.
    pub fn push(&self, id: u64, samples: &[i16], channels: u32) {
        let mut state = self.state.lock();
        let Some(source) = state.sources.get_mut(&id) else { return };
        if channels >= 2 {
            source.buffer.extend(samples.iter().map(|sample| *sample as f32 / 32768.));
        } else {
            for sample in samples {
                let value = *sample as f32 / 32768.;
                source.buffer.push_back(value);
                source.buffer.push_back(value);
            }
        }
        if source.live && source.buffer.len() > LIVE_LIMIT {
            let extra = source.buffer.len() - LIVE_DELAY * 2;
            source.buffer.drain(..extra);
        }
    }

    pub fn set_volume(&self, id: u64, volume: f32) {
        if let Some(source) = self.state.lock().sources.get_mut(&id) {
            source.volume = volume;
        }
    }

    pub fn remove(&self, id: u64) {
        self.state.lock().sources.remove(&id);
    }

    /// Stops playing, and lets go of the device.
    pub fn close(&self) {
        *self.output.lock() = None;
        self.state.lock().sources.retain(|_, source| source.once);
    }
}

struct OutputThread {
    device: String,
    stop: Sender<()>,
    failed: Arc<AtomicBool>,
}

impl Drop for OutputThread {
    fn drop(&mut self) {
        self.stop.send(()).ok();
    }
}

impl OutputThread {
    fn start(device: String, state: Arc<Mutex<MixerState>>, processing: SharedProcessing) -> Option<OutputThread> {
        let (stop, stopped) = channel::<()>();
        let failed = Arc::new(AtomicBool::new(false));
        let failing = failed.clone();
        let wanted = device.clone();
        std::thread::Builder::new()
            .name("zuna-sound-out".into())
            .spawn(move || {
                let Some(stream) = open_output(&wanted, state, processing, failing.clone()) else {
                    failing.store(true, Ordering::Relaxed);
                    return;
                };
                // A cpal stream stays on the thread that made it.
                let _ = stopped.recv();
                drop(stream);
            })
            .ok()?;
        Some(OutputThread { device, stop, failed })
    }
}

/// Mixes 48 kHz stereo from every source, `frames` at a time.
fn mix(state: &Mutex<MixerState>, frames: usize, out: &mut Vec<f32>) {
    out.clear();
    out.resize(frames * 2, 0.);
    let mut state = state.lock();
    for source in state.sources.values_mut() {
        if source.live {
            let held = source.buffer.len() / 2;
            if source.waiting && held < LIVE_DELAY {
                continue;
            }
            source.waiting = false;
            // LiveKit's timer and the device's clock drift apart, which a frame dropped or played
            // twice now and then makes up for, so that the delay neither grows nor runs out.
            if held > LIVE_DELAY * 3 / 2 {
                source.buffer.drain(..2);
            } else if held < LIVE_DELAY * 3 / 4 && held > 0 {
                let (left, right) = (source.buffer[0], source.buffer[1]);
                source.buffer.push_front(right);
                source.buffer.push_front(left);
            }
            // Run out, it waits for the whole delay again, rather than stutter on what trickles in.
            source.waiting = source.buffer.len() < frames * 2;
        }
        let available = source.buffer.len().min(frames * 2);
        for (index, sample) in source.buffer.drain(..available).enumerate() {
            out[index] += sample * source.volume;
        }
    }
    state.sources.retain(|_, source| !(source.once && source.buffer.is_empty()));
}

/// What the output plays, at a device's rate and on its channels: `fill` is given a place to
/// put each sample and how many frames it wants.
fn output_filler(rate: u32, channels: usize, state: Arc<Mutex<MixerState>>, processing: SharedProcessing) -> impl FnMut(&mut dyn FnMut(usize, f32), usize) + Send + 'static {
    // What's been mixed at 48 kHz and not yet played, and how far into it the device is.
    let mut pending: VecDeque<f32> = VecDeque::new();
    let mut position = 0f64;
    let step = RATE as f64 / rate as f64;
    let mut mixed = Vec::new();
    let mut reverse: Vec<i16> = Vec::new();
    move |data: &mut dyn FnMut(usize, f32), frames: usize| {
        // Enough 48 kHz frames to cover this many at the device's rate, and one beyond for interpolating.
        let needed = ((position + frames as f64 * step).ceil() as usize + 2).saturating_sub(pending.len() / 2);
        if needed > 0 {
            mix(&state, needed, &mut mixed);
            pending.extend(mixed.iter());
            // What's played goes to the echo canceller, in 10 ms of mono.
            for pair in mixed.chunks(2) {
                reverse.push((((pair[0] + pair[1]) * 0.5).clamp(-1., 1.) * 32767.) as i16);
            }
            if reverse.len() >= FRAME {
                let whole = reverse.len() / FRAME * FRAME;
                if let Some(processing) = processing.lock().as_mut() {
                    processing.0.process_reverse_stream(&mut reverse[..whole], RATE as i32, 1).ok();
                }
                reverse.drain(..whole);
            }
        }
        for frame in 0..frames {
            let at = position as usize;
            let fraction = (position - at as f64) as f32;
            let sample = |index: usize, channel: usize| pending.get(index * 2 + channel).copied().unwrap_or(0.);
            let left = sample(at, 0) + (sample(at + 1, 0) - sample(at, 0)) * fraction;
            let right = sample(at, 1) + (sample(at + 1, 1) - sample(at, 1)) * fraction;
            for channel in 0..channels {
                let value = if channels == 1 { (left + right) * 0.5 } else if channel % 2 == 0 { left } else { right };
                data(frame * channels + channel, value.clamp(-1., 1.));
            }
            position += step;
        }
        let used = position as usize;
        let drop = (used * 2).min(pending.len());
        pending.drain(..drop);
        position -= used as f64;
    }
}

#[cfg(target_os = "linux")]
fn open_output(device: &str, state: Arc<Mutex<MixerState>>, processing: SharedProcessing, failed: Arc<AtomicBool>) -> Option<super::pipewire::Stream> {
    // PipeWire takes 48 kHz stereo and converts it for the device.
    let mut fill = output_filler(RATE, 2, state, processing);
    super::pipewire::play(device, super::pipewire::Playing::Voice, RATE, move |data, frames| fill(&mut |index, value| data[index] = value, frames), failed)
}

#[cfg(any(windows, target_os = "macos"))]
fn open_output(device: &str, state: Arc<Mutex<MixerState>>, processing: SharedProcessing, failed: Arc<AtomicBool>) -> Option<cpal::Stream> {
    let device = find(false, device)?;
    let config = device.default_output_config().ok()?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let mut fill = output_filler(rate, channels, state, processing);
    let error = move |_| failed.store(true, Ordering::Relaxed);
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_output_stream(&config, move |data: &mut [f32], _| {
            let frames = data.len() / channels;
            fill(&mut |index, value| data[index] = value, frames);
        }, error, None),
        cpal::SampleFormat::I16 => device.build_output_stream(&config, move |data: &mut [i16], _| {
            let frames = data.len() / channels;
            fill(&mut |index, value| data[index] = (value * 32767.) as i16, frames);
        }, error, None),
        _ => return None,
    }
    .ok()?;
    stream.play().ok()?;
    Some(stream)
}

// --- Input ---

/// The microphone, read as 48 kHz mono in 10 ms frames.
pub struct Input {
    stop: Sender<()>,
    /// The device went away, such as a headset being unplugged.
    pub lost: Arc<AtomicBool>,
}

impl Drop for Input {
    fn drop(&mut self) {
        self.stop.send(()).ok();
    }
}

impl Input {
    /// Opens a microphone by its ID, or the default one, or says why it can't.
    pub fn open(device: &str) -> Result<(Input, Receiver<Vec<f32>>), String> {
        let (frames, receiver) = channel::<Vec<f32>>();
        let (stop, stopped) = channel::<()>();
        let (ready, started) = channel::<Result<(), String>>();
        let lost = Arc::new(AtomicBool::new(false));
        let losing = lost.clone();
        let wanted = device.to_string();
        std::thread::Builder::new()
            .name("zuna-sound-in".into())
            .spawn(move || match open_input(&wanted, frames, losing) {
                Ok(stream) => {
                    ready.send(Ok(())).ok();
                    let _ = stopped.recv();
                    drop(stream);
                }
                Err(error) => {
                    ready.send(Err(error)).ok();
                }
            })
            .map_err(|_| "The microphone couldn't be used.".to_string())?;
        started.recv().map_err(|_| "The microphone couldn't be used.".to_string())??;
        Ok((Input { stop, lost }, receiver))
    }
}

/// What reads the microphone, at a device's rate and on its channels, into 10 ms frames of
/// 48 kHz mono: `take` is given a way to read each sample and how many there are.
fn input_taker(rate: u32, channels: usize, frames: Sender<Vec<f32>>) -> impl FnMut(&mut dyn FnMut(usize) -> f32, usize) + Send + 'static {
    let step = rate as f64 / RATE as f64;
    let mut source: Vec<f32> = Vec::new();
    let mut position = 0f64;
    let mut frame: Vec<f32> = Vec::with_capacity(FRAME);
    move |read: &mut dyn FnMut(usize) -> f32, count: usize| {
        for index in 0..count / channels {
            let mut sum = 0.;
            for channel in 0..channels {
                sum += read(index * channels + channel);
            }
            source.push(sum / channels as f32);
        }
        // To 48 kHz, by interpolating.
        while (position as usize) + 1 < source.len() {
            let at = position as usize;
            let fraction = (position - at as f64) as f32;
            frame.push(source[at] + (source[at + 1] - source[at]) * fraction);
            if frame.len() == FRAME {
                frames.send(std::mem::replace(&mut frame, Vec::with_capacity(FRAME))).ok();
            }
            position += step;
        }
        let used = (position as usize).min(source.len());
        source.drain(..used);
        position -= used as f64;
    }
}

#[cfg(target_os = "linux")]
fn open_input(device: &str, frames: Sender<Vec<f32>>, lost: Arc<AtomicBool>) -> Result<super::pipewire::Stream, String> {
    // PipeWire hands over 48 kHz mono, converted from the device.
    let mut take = input_taker(RATE, 1, frames);
    super::pipewire::record(device, move |samples| take(&mut |index| samples[index], samples.len()), lost).map_err(|error| {
        log::warn!("the microphone: {error}");
        "There's no microphone Zuna can use.".to_string()
    })
}

#[cfg(any(windows, target_os = "macos"))]
fn open_input(device: &str, frames: Sender<Vec<f32>>, lost: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
    let none = || "There's no microphone Zuna can use.".to_string();
    let device = find(true, device).ok_or_else(none)?;
    let config = device.default_input_config().map_err(|_| none())?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let mut take = input_taker(rate, channels, frames);
    let error = move |_| lost.store(true, Ordering::Relaxed);
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(&config, move |data: &[f32], _| take(&mut |index| data[index], data.len()), error, None),
        cpal::SampleFormat::I16 => device.build_input_stream(&config, move |data: &[i16], _| take(&mut |index| data[index] as f32 / 32768., data.len()), error, None),
        cpal::SampleFormat::U16 => device.build_input_stream(&config, move |data: &[u16], _| take(&mut |index| (data[index] as f32 - 32768.) / 32768., data.len()), error, None),
        _ => return Err(none()),
    }
    .map_err(|error| match error {
        cpal::BuildStreamError::DeviceNotAvailable => none(),
        _ => "Zuna can't use the microphone. Allow it in your system's privacy settings.".to_string(),
    })?;
    stream.play().map_err(|_| none())?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How often a steady voice goes quiet over ten minutes, handed over 10 ms at a time on
    /// LiveKit's own timer, usually up to 2 ms late and now and then up to `late` seconds, and
    /// played 256 frames at a time by a device whose clock runs `fast` parts per million ahead.
    /// Also, how far behind the voice is by the end, in frames.
    fn gaps(late: f64, fast: f64) -> (usize, usize) {
        let mixer = Mixer::new(Arc::default());
        let id = mixer.live(1.);
        let mut fill = output_filler(RATE, 2, mixer.state.clone(), mixer.processing.clone());
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let period = 256. / RATE as f64 / (1. + fast / 1e6);
        let voice = [8192i16; FRAME];
        let mut out = vec![0f32; 512];
        let (mut tick, mut next) = (0u64, 0f64);
        let (mut sounding, mut gaps) = (false, 0);
        for callback in 0..(600. / period) as u64 {
            while next <= callback as f64 * period {
                mixer.push(id, &voice, 1);
                tick += 1;
                let lateness = if random() < 0.02 { random() * late } else { random() * 0.002 };
                // LiveKit's timer keeps to its schedule, so a late frame doesn't hold up later ones.
                next = next.max(tick as f64 * 0.010 + lateness);
            }
            fill(&mut |index, value| out[index] = value, 256);
            for frame in out.chunks(2) {
                if sounding && frame[0] == 0. {
                    gaps += 1;
                }
                sounding = frame[0] != 0.;
            }
        }
        let behind = mixer.state.lock().sources[&id].buffer.len() / 2;
        (gaps, behind)
    }

    #[test]
    fn plays_voices_through_late_frames_and_a_drifting_clock() {
        for fast in [100., 0., -100.] {
            let (gaps, behind) = gaps(0.015, fast);
            assert_eq!(gaps, 0, "a device {fast} ppm fast");
            assert!(behind < RATE as usize / 10, "a device {fast} ppm fast ends {behind} frames behind");
        }
    }
}
