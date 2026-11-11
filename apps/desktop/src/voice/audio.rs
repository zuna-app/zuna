//! The sound devices, through cpal on Windows (WASAPI) and macOS (Core Audio), and PipeWire on Linux
//! (`voice/pipewire.rs`): everyone's voices and the app's own sounds mixed onto one output,
//! and the microphone read at 48 kHz, as a browser's AudioContext does for the web.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::Duration;

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

/// The microphones or the speakers, with the default first, asking the system, which can be
/// slow: what's drawn reads them through `crate::devices`, which keeps them.
#[cfg(target_os = "linux")]
pub fn list(input: bool) -> Vec<Device> {
    super::pipewire::devices(input)
}

/// The microphones or the speakers, with the default first, asking the system, which can be
/// slow, or on macOS not answer at all while a driver hangs: what's drawn reads them through
/// `crate::devices`, which keeps them.
#[cfg(any(windows, target_os = "macos"))]
pub fn list(input: bool) -> Vec<Device> {
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
    /// How many are keeping the output open with nothing to play: a call, or a ring.
    held: usize,
    /// It's been opened since the output last looked, for something about to play.
    opened: bool,
    /// What something else in this app plays on its own, as a video watched together plays from
    /// WebKit's process: interleaved stereo at 48 kHz, which the echo canceller hears beside the
    /// mix, but which isn't played again.
    far_end: VecDeque<f32>,
}

/// The most of `far_end` kept waiting, past which the oldest goes: 200 ms.
const FAR_END_KEPT: usize = RATE as usize / 5 * 2;

impl MixerState {
    /// Whether anything still needs the output. The output asks every `IDLE_CHECK`, and asking
    /// forgets that it was opened.
    fn needed(&mut self) -> bool {
        let opened = std::mem::take(&mut self.opened);
        self.held > 0 || !self.sources.is_empty() || opened
    }
}

/// Everything played, mixed into one output on the chosen device, which is open only while
/// there's something to play, or a call that may have at any moment.
#[derive(Clone)]
pub struct Mixer {
    state: Arc<Mutex<MixerState>>,
    next: Arc<AtomicU64>,
    processing: SharedProcessing,
    output: Arc<Mutex<Option<OutputThread>>>,
}

/// Keeps the output open until it's dropped.
pub struct Hold(Arc<Mutex<MixerState>>);

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.lock().held -= 1;
    }
}

/// How often the output looks at whether anything still needs it. After two looks in a row
/// with nothing held and nothing left to play, it lets go of the device, which is at least
/// this long after the last of a sound. Left open, the system shows Zuna as playing, and
/// keeps the device awake for it, from the first sound on.
const IDLE_CHECK: Duration = Duration::from_millis(500);

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
    /// The output closes a moment after the last of what it plays, unless it's held, so this
    /// comes before each sound outside a call.
    pub fn open(&self, device: &str) {
        let mut output = self.output.lock();
        // Said under the state's lock, which the output closes under: either it sees this and
        // stays open, or it has closed already, which is seen here.
        self.state.lock().opened = true;
        if output.as_ref().is_some_and(|thread| thread.device == device && !thread.gone.load(Ordering::Relaxed)) {
            return;
        }
        *output = None;
        *output = OutputThread::start(device.to_string(), self.state.clone(), self.processing.clone());
    }

    /// Opens the output, and keeps it open until what this gives is dropped: for a call, where
    /// a voice may come at any moment, and a ring, which is quiet between its repeats.
    pub fn hold(&self, device: &str) -> Hold {
        let hold = self.held();
        self.open(device);
        hold
    }

    fn held(&self) -> Hold {
        self.state.lock().held += 1;
        Hold(self.state.clone())
    }

    /// A place to send live sound, such as a person's voice.
    pub fn live(&self, volume: f32) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.state.lock().sources.insert(id, Source { buffer: VecDeque::new(), volume, live: true, waiting: true, once: false });
        id
    }

    /// What's played by something else in this app, interleaved stereo at 48 kHz, for the echo
    /// canceller to hear with the mix: a video's sound from the system's web view.
    pub fn hear_far_end(&self, samples: &[f32]) {
        let mut state = self.state.lock();
        state.far_end.extend(samples.iter().copied());
        let over = state.far_end.len().saturating_sub(FAR_END_KEPT);
        state.far_end.drain(..over & !1);
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
}

struct OutputThread {
    device: String,
    stop: Sender<()>,
    /// The device failed, or the output closed with nothing left to play. Either way it's
    /// opened again the next time it's wanted.
    gone: Arc<AtomicBool>,
}

impl Drop for OutputThread {
    fn drop(&mut self) {
        self.stop.send(()).ok();
    }
}

impl OutputThread {
    fn start(device: String, state: Arc<Mutex<MixerState>>, processing: SharedProcessing) -> Option<OutputThread> {
        let (stop, stopped) = channel::<()>();
        let gone = Arc::new(AtomicBool::new(false));
        let going = gone.clone();
        let wanted = device.clone();
        std::thread::Builder::new()
            .name("zuna-sound-out".into())
            .spawn(move || {
                let Some(stream) = open_output(&wanted, state.clone(), processing, going.clone()) else {
                    going.store(true, Ordering::Relaxed);
                    return;
                };
                // A cpal stream stays on the thread that made it, which waits here to be
                // stopped, or for nothing to need the output any more.
                let mut idle = false;
                while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(IDLE_CHECK) {
                    let mut state = state.lock();
                    if state.needed() {
                        idle = false;
                    } else if !idle {
                        idle = true;
                    } else {
                        // Said under the state's lock, as `open` says it's wanted: either that
                        // came first and was seen above, or it sees this and opens it again.
                        going.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                drop(stream);
            })
            .ok()?;
        Some(OutputThread { device, stop, gone })
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
            // What's played goes to the echo canceller, in 10 ms of mono, with what the app's web
            // views play themselves, which the speakers play too.
            {
                let mut state = state.lock();
                for pair in mixed.chunks(2) {
                    let (left, right) = if state.far_end.len() >= 2 { (state.far_end.pop_front().unwrap_or(0.), state.far_end.pop_front().unwrap_or(0.)) } else { (0., 0.) };
                    reverse.push((((pair[0] + pair[1] + left + right) * 0.5).clamp(-1., 1.) * 32767.) as i16);
                }
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

    /// How much of what the speakers play the microphone's processing lets through, in dB, over
    /// the last two of eight seconds: a video's sound, played by the system's web view rather than
    /// the mixer, which the microphone hears 40 ms later at half the level, with that sound handed
    /// to the mixer as the far end (`hear_far_end`) or not.
    fn echo_left(far_end: bool) -> f64 {
        let processing: SharedProcessing = Arc::new(Mutex::new(Some(Processing(livekit::webrtc::native::apm::AudioProcessingModule::new(true, false, false, false)))));
        let mixer = Mixer::new(processing.clone());
        let mut fill = output_filler(RATE, 2, mixer.state.clone(), processing.clone());
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut random = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f32 / (1u64 << 53) as f32 * 2. - 1.
        };
        let delay = RATE as usize / 25;
        let mut room: VecDeque<f32> = std::iter::repeat_n(0., delay).collect();
        let (mut heard, mut left) = (0f64, 0f64);
        let frames = 8 * RATE as usize / FRAME;
        for index in 0..frames {
            let video: Vec<f32> = (0..FRAME).flat_map(|_| {
                let sample = random() * 0.3;
                [sample, sample]
            }).collect();
            if far_end {
                mixer.hear_far_end(&video);
            }
            fill(&mut |_, _| {}, FRAME);
            room.extend(video.chunks(2).map(|pair| pair[0]));
            let mut microphone: Vec<i16> = room.drain(..FRAME).map(|sample| (sample * 0.5 * 32767.) as i16).collect();
            let before: f64 = microphone.iter().map(|&sample| (sample as f64).powi(2)).sum();
            processing.lock().as_mut().unwrap().0.process_stream(&mut microphone, RATE as i32, 1).ok();
            if index >= frames - 2 * RATE as usize / FRAME {
                heard += before;
                left += microphone.iter().map(|&sample| (sample as f64).powi(2)).sum::<f64>();
            }
        }
        10. * (left.max(1.) / heard.max(1.)).log10()
    }

    #[test]
    fn a_videos_sound_handed_over_as_the_far_end_is_taken_out_of_the_microphone() {
        let (with, without) = (echo_left(true), echo_left(false));
        eprintln!("the video's echo: {with:.1} dB left with the far end, {without:.1} dB without");
        assert!(with < -20. && with < without - 15., "{with:.1} dB left with the far end, {without:.1} dB without");
    }

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
    fn needs_the_output_only_while_held_or_playing() {
        let mixer = Mixer::new(Arc::default());
        let needed = || mixer.state.lock().needed();
        assert!(!needed());
        // A call holds it, with nobody talking.
        let hold = mixer.held();
        assert!(needed());
        drop(hold);
        assert!(!needed());
        // A sound needs it until the last of it has been played.
        mixer.once(vec![0.5; 200], 1.);
        let mut out = Vec::new();
        mix(&mixer.state, 60, &mut out);
        assert!(needed());
        mix(&mixer.state, 60, &mut out);
        assert!(!needed());
        // Opened for a sound that hasn't come yet, it's needed for one look.
        mixer.state.lock().opened = true;
        assert!(needed());
        assert!(!needed());
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

// --- Media's own playing and recording ---

/// What a voice message, a sound file or a video's sound plays through, and a voice or video
/// message records from, until it's dropped.
#[cfg(target_os = "linux")]
pub type MediaStream = super::pipewire::Stream;
/// On macOS a cpal stream has to stay on the thread that made it, so it's made on one of its
/// own, which keeps it until this is dropped.
#[cfg(target_os = "macos")]
pub struct MediaStream {
    _stop: Sender<()>,
}

#[cfg(target_os = "macos")]
fn on_own_thread(make: impl FnOnce() -> Result<cpal::Stream, String> + Send + 'static) -> Result<MediaStream, String> {
    let (ready, started) = channel::<Result<(), String>>();
    let (stop, stopped) = channel::<()>();
    std::thread::Builder::new()
        .name("zuna-media-sound".into())
        .spawn(move || match make() {
            Ok(stream) => {
                ready.send(Ok(())).ok();
                // Until the handle's dropped.
                stopped.recv().ok();
                drop(stream);
            }
            Err(error) => {
                ready.send(Err(error)).ok();
            }
        })
        .map_err(|error| error.to_string())?;
    started.recv().map_err(|error| error.to_string())??;
    Ok(MediaStream { _stop: stop })
}

/// Plays stereo floats at `rate` from `fill` through the default output: PipeWire's on Linux,
/// which converts the rate itself.
#[cfg(target_os = "linux")]
pub fn play_media(rate: u32, fill: impl FnMut(&mut [f32], usize) + Send + 'static) -> Option<MediaStream> {
    super::pipewire::play("default", super::pipewire::Playing::Media, rate, fill, Arc::new(AtomicBool::new(false)))
}

/// Plays stereo floats at `rate` from `fill` through the default output: Core Audio's on macOS,
/// at the device's own rate, which this converts to, so the output's rate is left alone.
#[cfg(target_os = "macos")]
pub fn play_media(rate: u32, fill: impl FnMut(&mut [f32], usize) + Send + 'static) -> Option<MediaStream> {
    on_own_thread(move || open_media_output(rate, fill).ok_or_else(|| "no sound out".to_string())).inspect_err(|error| log::warn!("playing: {error}")).ok()
}

#[cfg(target_os = "macos")]
fn open_media_output(rate: u32, mut fill: impl FnMut(&mut [f32], usize) + Send + 'static) -> Option<cpal::Stream> {
    let device = find(false, "default")?;
    let config = device.default_output_config().ok()?;
    let (device_rate, channels, format) = (config.sample_rate().0, config.channels() as usize, config.sample_format());
    let config: cpal::StreamConfig = config.into();
    let step = rate as f64 / device_rate as f64;
    let mut pending: VecDeque<f32> = VecDeque::new();
    let mut position = 0f64;
    let mut chunk: Vec<f32> = Vec::new();
    let mut produce = move |out: &mut dyn FnMut(usize, f32), frames: usize| {
        // Enough of the clip's frames to cover this many at the device's rate, and one beyond for interpolating.
        let needed = ((position + frames as f64 * step).ceil() as usize + 2).saturating_sub(pending.len() / 2);
        if needed > 0 {
            chunk.clear();
            chunk.resize(needed * 2, 0.);
            fill(&mut chunk, needed);
            pending.extend(chunk.iter());
        }
        for frame in 0..frames {
            let at = position as usize;
            let fraction = (position - at as f64) as f32;
            let sample = |index: usize, channel: usize| pending.get(index * 2 + channel).copied().unwrap_or(0.);
            let left = sample(at, 0) + (sample(at + 1, 0) - sample(at, 0)) * fraction;
            let right = sample(at, 1) + (sample(at + 1, 1) - sample(at, 1)) * fraction;
            for channel in 0..channels {
                out(frame * channels + channel, match (channels, channel) {
                    (1, _) => (left + right) * 0.5,
                    (_, 0) => left,
                    (_, 1) => right,
                    _ => 0.,
                });
            }
            position += step;
        }
        let used = position as usize;
        let drop = (used * 2).min(pending.len());
        pending.drain(..drop);
        position -= used as f64;
    };
    let error = |error| log::warn!("playing: {error}");
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_output_stream(&config, move |data: &mut [f32], _| {
            let frames = data.len() / channels;
            produce(&mut |index, value| data[index] = value, frames);
        }, error, None),
        cpal::SampleFormat::I16 => device.build_output_stream(&config, move |data: &mut [i16], _| {
            let frames = data.len() / channels;
            produce(&mut |index, value| data[index] = (value.clamp(-1., 1.) * 32767.) as i16, frames);
        }, error, None),
        _ => return None,
    }
    .ok()?;
    stream.play().ok()?;
    Some(stream)
}

/// Records one channel at 48 kHz from the default microphone, handing what's heard to `take`.
#[cfg(target_os = "linux")]
pub fn record_media(take: impl FnMut(&[f32]) + Send + 'static) -> Result<MediaStream, String> {
    super::pipewire::record("default", take, Arc::new(AtomicBool::new(false))).map_err(|_| "There's no microphone Zuna can use.".to_string())
}

/// Records one channel at 48 kHz from the default microphone, handing what's heard to `take`,
/// as voice reads it, 10 ms at a time.
#[cfg(target_os = "macos")]
pub fn record_media(mut take: impl FnMut(&[f32]) + Send + 'static) -> Result<MediaStream, String> {
    let (frames, heard) = channel::<Vec<f32>>();
    let stream = on_own_thread(move || open_input("default", frames, Arc::new(AtomicBool::new(false))))?;
    // Ends as the stream is dropped, and with it what it sends through.
    std::thread::Builder::new()
        .name("zuna-recording".into())
        .spawn(move || {
            while let Ok(frame) = heard.recv() {
                take(&frame);
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(stream)
}
