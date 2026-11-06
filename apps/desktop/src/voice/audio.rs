//! The sound devices, through cpal (WASAPI): everyone's voices and the app's own sounds
//! mixed onto one output, and the microphone read at 48 kHz, as a browser's AudioContext
//! does for the desktop.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;

/// Everything here works at this rate, as WebRTC and RNNoise do.
pub const RATE: u32 = 48_000;
/// 10 ms, which WebRTC's processing and RNNoise each take at a time.
pub const FRAME: usize = 480;

/// A device the person can choose, by the name Windows gives it.
#[derive(Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
}

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
pub fn devices(input: bool) -> Vec<Device> {
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
    /// Live sound keeps no more than this many samples behind, so a slow device doesn't drift.
    live: bool,
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

/// Live sound that falls further behind than this drops what's oldest: 200 ms, stereo.
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
        self.state.lock().sources.insert(id, Source { buffer: VecDeque::new(), volume, live: true, once: false });
        id
    }

    /// Plays a sound once, interleaved stereo at 48 kHz.
    pub fn once(&self, samples: Vec<f32>, volume: f32) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.state.lock().sources.insert(id, Source { buffer: samples.into(), volume, live: false, once: true });
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
            let extra = source.buffer.len() - LIVE_LIMIT / 2;
            source.buffer.drain(..extra & !1);
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
        let available = source.buffer.len().min(frames * 2);
        for (index, sample) in source.buffer.drain(..available).enumerate() {
            out[index] += sample * source.volume;
        }
    }
    state.sources.retain(|_, source| !(source.once && source.buffer.is_empty()));
}

fn open_output(device: &str, state: Arc<Mutex<MixerState>>, processing: SharedProcessing, failed: Arc<AtomicBool>) -> Option<cpal::Stream> {
    let device = find(false, device)?;
    let config = device.default_output_config().ok()?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    // What's been mixed at 48 kHz and not yet played, and how far into it the device is.
    let mut pending: VecDeque<f32> = VecDeque::new();
    let mut position = 0f64;
    let step = RATE as f64 / rate as f64;
    let mut mixed = Vec::new();
    let mut reverse: Vec<i16> = Vec::new();
    let mut fill = move |data: &mut dyn FnMut(usize, f32), frames: usize| {
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
    };
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

fn open_input(device: &str, frames: Sender<Vec<f32>>, lost: Arc<AtomicBool>) -> Result<cpal::Stream, String> {
    let none = || "There's no microphone Zuna can use.".to_string();
    let device = find(true, device).ok_or_else(none)?;
    let config = device.default_input_config().map_err(|_| none())?;
    let rate = config.sample_rate().0;
    let channels = config.channels() as usize;
    let format = config.sample_format();
    let config: cpal::StreamConfig = config.into();
    let step = rate as f64 / RATE as f64;
    let mut source: Vec<f32> = Vec::new();
    let mut position = 0f64;
    let mut frame: Vec<f32> = Vec::with_capacity(FRAME);
    let mut take = move |read: &mut dyn FnMut(usize) -> f32, count: usize| {
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
    };
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
