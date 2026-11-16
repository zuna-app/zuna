//! What happens to the microphone before anyone hears it (packages/ui/src/voice/mic.worklet.ts):
//! WebRTC's echo cancelling, gain and noise suppression where they're chosen, as Chromium
//! applies them, then RNNoise, then a gate that only lets speech through.
//!
//! RNNoise takes 10 ms at a time and says how likely each piece is to be speech, which is
//! what opens the gate. What leaves is held back by a further 20 ms, so that the gate has
//! already opened by the time the first sound of a word gets to it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

use super::audio::{FRAME, Input, SharedProcessing};
use super::settings::VoiceSettings;
use crate::i18n::t;

/// How far ahead of what's being sent the gate looks, in frames.
const LOOKAHEAD_FRAMES: usize = 2;
/// How long the gate stays open after the last speech, in frames. Sentences have gaps in them.
const HOLD_SPEECH: u32 = 40;
const HOLD_LOUD: u32 = 25;
/// Over this, a frame is speech by itself. Otherwise it takes a few in a row.
const VAD_SURE: f32 = 0.85;
const VAD_LIKELY: f32 = 0.5;
/// While the gate is open, this much keeps it open.
const VAD_KEEP: f32 = 0.25;
/// How quickly the gate moves, per sample. About 3 ms to open, 40 ms to close.
const ATTACK: f32 = 1. / (0.003 * 48000.);
const RELEASE: f32 = 1. / (0.04 * 48000.);
/// How often how loud it is gets reported, in frames.
const REPORT_EVERY: u32 = 5;

#[derive(Clone, Debug)]
struct MicSettings {
    ptt: bool,
    /// Whether RNNoise's cleaned audio goes out, or only its opinion is used.
    suppress: bool,
    auto: bool,
    threshold: f32,
    gain: f32,
    muted: bool,
    /// How long the gate stays open after the key is let go, in frames.
    ptt_release: u32,
}

impl MicSettings {
    fn from(settings: &VoiceSettings, muted: bool) -> MicSettings {
        MicSettings {
            ptt: settings.input_mode == "ptt",
            suppress: settings.noise_suppression == "zuna",
            auto: settings.auto_sensitivity,
            threshold: settings.sensitivity,
            gain: settings.input_volume,
            muted,
            ptt_release: (settings.ptt_release / 10.).ceil() as u32,
        }
    }
}

/// How loud the microphone is, and whether sound's going through.
#[derive(Clone, Copy, Debug)]
pub struct Reading {
    /// After noise suppression, in dB.
    pub level: f32,
    /// How likely it is that this is speech, from 0 to 1.
    pub vad: f32,
    pub open: bool,
}

impl Default for Reading {
    fn default() -> Self {
        Reading { level: -100., vad: 0., open: false }
    }
}

/// The microphone, from the device to what's sent, 10 ms at a time.
pub struct Microphone {
    _input: Option<Input>,
    settings: Arc<Mutex<MicSettings>>,
    key: Arc<AtomicBool>,
    pub reading: Arc<Mutex<Reading>>,
    pub lost: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl Drop for Microphone {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Microphone {
    /// Opens the microphone, or says why it can't, and hands each processed frame to `sink`.
    pub fn open(settings: &VoiceSettings, muted: bool, processing: SharedProcessing, mut sink: impl FnMut(Vec<i16>) + Send + 'static) -> Result<Microphone, String> {
        let shared = Arc::new(Mutex::new(MicSettings::from(settings, muted)));
        let key = Arc::new(AtomicBool::new(false));
        let reading = Arc::new(Mutex::new(Reading::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (input, frames, lost) = match fake_microphone(stop.clone()) {
            Some(frames) => (None, frames, Arc::new(AtomicBool::new(false))),
            None => {
                let (input, frames) = Input::open(&settings.input_device)?;
                let lost = input.lost.clone();
                (Some(input), frames, lost)
            }
        };
        let mut gate = Gate::new(shared.clone(), key.clone(), reading.clone());
        let stopping = stop.clone();
        std::thread::Builder::new()
            .name("zuna-microphone".into())
            .spawn(move || {
                while !stopping.load(Ordering::Relaxed) {
                    let Ok(frame) = frames.recv_timeout(Duration::from_millis(200)) else { continue };
                    let mut samples: Vec<i16> = frame.iter().map(|sample| (sample.clamp(-1., 1.) * 32767.) as i16).collect();
                    if let Some(processing) = processing.lock().as_mut() {
                        processing.0.process_stream(&mut samples, super::audio::RATE as i32, 1).ok();
                    }
                    if let Some(out) = gate.process(&samples) {
                        sink(out);
                    }
                }
            })
            .map_err(|_| t("voice.mic.failed").to_string())?;
        Ok(Microphone { _input: input, settings: shared, key, reading, lost, stop })
    }

    /// Takes on what doesn't need the device opened again.
    pub fn apply(&self, settings: &VoiceSettings) {
        let mut current = self.settings.lock();
        let muted = current.muted;
        *current = MicSettings::from(settings, muted);
    }

    pub fn set_muted(&self, muted: bool) {
        self.settings.lock().muted = muted;
    }

    /// The push to talk key went down or up.
    pub fn set_key(&self, down: bool) {
        self.key.store(down, Ordering::Relaxed);
    }
}

/// A tone in bursts in place of a microphone, for checking voice on a machine without one.
/// Only development builds listen for it.
fn fake_microphone(stop: Arc<AtomicBool>) -> Option<std::sync::mpsc::Receiver<Vec<f32>>> {
    if !cfg!(debug_assertions) || std::env::var_os("ZUNA_FAKE_MIC").is_none() {
        return None;
    }
    let (frames, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut index = 0u64;
        while !stop.load(Ordering::Relaxed) {
            let mut frame = Vec::with_capacity(FRAME);
            for _ in 0..FRAME {
                let seconds = index as f64 / 48000.;
                // A second of sound, then a second of quiet.
                let on = (seconds as u64) % 2 == 0;
                frame.push(if on { ((seconds * 440. * std::f64::consts::TAU).sin() * 0.3) as f32 } else { 0. });
                index += 1;
            }
            if frames.send(frame).is_err() {
                break;
            }
            let due = Duration::from_secs_f64(index as f64 / 48000.);
            if let Some(wait) = due.checked_sub(started.elapsed()) {
                std::thread::sleep(wait);
            }
        }
    });
    Some(receiver)
}

/// RNNoise and the gate, as the worklet has them.
struct Gate {
    settings: Arc<Mutex<MicSettings>>,
    key: Arc<AtomicBool>,
    reading: Arc<Mutex<Reading>>,
    rnnoise: Box<nnnoiseless::DenoiseState<'static>>,
    lookahead: Vec<Vec<f32>>,
    lookahead_at: usize,
    filled: usize,
    hold: u32,
    likely_run: u32,
    gate: f32,
    open: bool,
    loudest: f32,
    to_report: u32,
}

impl Gate {
    fn new(settings: Arc<Mutex<MicSettings>>, key: Arc<AtomicBool>, reading: Arc<Mutex<Reading>>) -> Gate {
        Gate {
            settings,
            key,
            reading,
            rnnoise: nnnoiseless::DenoiseState::new(),
            lookahead: vec![vec![0.; FRAME]; LOOKAHEAD_FRAMES],
            lookahead_at: 0,
            filled: 0,
            hold: 0,
            likely_run: 0,
            gate: 0.,
            open: false,
            loudest: -100.,
            to_report: REPORT_EVERY,
        }
    }

    fn decide(&mut self, settings: &MicSettings, vad: f32, level: f32) -> bool {
        if settings.muted {
            self.hold = 0;
            self.likely_run = 0;
            return false;
        }
        if settings.ptt {
            let down = self.key.load(Ordering::Relaxed);
            if down {
                self.hold = settings.ptt_release;
            } else if self.hold > 0 {
                self.hold -= 1;
            }
            return down || self.hold > 0;
        }
        if !settings.auto {
            if level >= settings.threshold {
                self.hold = HOLD_LOUD;
            } else if self.hold > 0 {
                self.hold -= 1;
            }
            return self.hold > 0;
        }
        self.likely_run = if vad >= VAD_LIKELY { self.likely_run + 1 } else { 0 };
        // A click or a cough can look like speech for a moment, which isn't enough by itself.
        if vad >= VAD_SURE || self.likely_run >= 3 || (self.open && vad >= VAD_KEEP) {
            self.hold = HOLD_SPEECH;
        } else if self.hold > 0 {
            self.hold -= 1;
        }
        self.hold > 0
    }

    /// One frame in, and the oldest held frame out once the lookahead is full.
    fn process(&mut self, samples: &[i16]) -> Option<Vec<i16>> {
        let settings = self.settings.lock().clone();
        // RNNoise works on samples scaled as 16-bit audio.
        let input: Vec<f32> = samples.iter().map(|sample| *sample as f32 * settings.gain).collect();
        let mut cleaned = vec![0f32; FRAME];
        let vad = self.rnnoise.process_frame(&mut cleaned, &input[..FRAME.min(input.len())]);
        let frame: Vec<f32> = if settings.suppress { cleaned } else { input };
        let sum: f32 = frame.iter().map(|sample| (sample / 32768.).powi(2)).sum();
        let level = if sum > 0. { 10. * (sum / FRAME as f32).log10() } else { -100. };
        self.loudest = self.loudest.max(level);
        let open = self.decide(&settings, vad, level);
        if open != self.open {
            self.open = open;
            *self.reading.lock() = Reading { level, vad, open };
        }
        self.to_report -= 1;
        if self.to_report == 0 {
            self.to_report = REPORT_EVERY;
            *self.reading.lock() = Reading { level: self.loudest, vad, open: self.open };
            self.loudest = -100.;
        }
        // What leaves is the oldest frame held, through the gate as it is now.
        let held = std::mem::replace(&mut self.lookahead[self.lookahead_at], frame);
        self.lookahead_at = (self.lookahead_at + 1) % LOOKAHEAD_FRAMES;
        if self.filled < LOOKAHEAD_FRAMES {
            self.filled += 1;
            return None;
        }
        let target = if open { 1. } else { 0. };
        let mut gate = self.gate;
        let out = held
            .iter()
            .map(|sample| {
                gate = if gate < target { (gate + ATTACK).min(target) } else { (gate - RELEASE).max(target) };
                (sample * gate).clamp(-32768., 32767.) as i16
            })
            .collect();
        self.gate = gate;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(change: impl FnOnce(&mut VoiceSettings)) -> MicSettings {
        let mut voice = VoiceSettings::default();
        change(&mut voice);
        MicSettings::from(&voice, false)
    }

    fn gate(settings: MicSettings) -> (Gate, Arc<AtomicBool>, Arc<Mutex<Reading>>) {
        let key = Arc::new(AtomicBool::new(false));
        let reading = Arc::new(Mutex::new(Reading::default()));
        (Gate::new(Arc::new(Mutex::new(settings)), key.clone(), reading.clone()), key, reading)
    }

    /// A frame of 440 Hz, from 0 to 1 as loud as it can be.
    fn tone(loudness: f32) -> Vec<i16> {
        (0..FRAME).map(|i| ((i as f32 * 440. * std::f32::consts::TAU / 48000.).sin() * loudness * 32767.) as i16).collect()
    }

    #[test]
    fn the_settings_are_read_as_the_gate_takes_them() {
        let read = settings(|s| {
            s.input_mode = "ptt".into();
            s.noise_suppression = "zuna".into();
            s.auto_sensitivity = false;
            s.sensitivity = -40.;
            s.input_volume = 1.5;
            s.ptt_release = 95.;
        });
        assert!(read.ptt && read.suppress && !read.auto && !read.muted);
        assert_eq!((read.threshold, read.gain, read.ptt_release), (-40., 1.5, 10));
        let read = settings(|s| {
            s.input_mode = "voice".into();
            s.noise_suppression = "standard".into();
        });
        assert!(!read.ptt && !read.suppress);
        let quiet = Reading::default();
        assert!(!quiet.open && quiet.level == -100.);
    }

    #[test]
    fn muted_nothing_goes_through_and_nothing_is_held_for_after() {
        let (mut gate, _, _) = gate(settings(|_| {}));
        let mut now = gate.settings.lock().clone();
        assert!(gate.decide(&now, 0.9, -20.));
        now.muted = true;
        assert!(!gate.decide(&now, 0.9, -20.), "speech went through muted");
        now.muted = false;
        assert!(!gate.decide(&now, 0., -100.), "what was held from before being muted went through after it");
    }

    #[test]
    fn push_to_talk_goes_through_while_the_key_is_down_and_for_its_release_after() {
        let (mut gate, key, _) = gate(settings(|s| {
            s.input_mode = "ptt".into();
            s.ptt_release = 30.;
        }));
        let now = gate.settings.lock().clone();
        assert!(!gate.decide(&now, 1., 0.), "speech went through with the key up");
        key.store(true, Ordering::Relaxed);
        assert!(gate.decide(&now, 0., -100.), "quiet didn't go through with the key down");
        key.store(false, Ordering::Relaxed);
        let after: Vec<bool> = (0..4).map(|_| gate.decide(&now, 0., -100.)).collect();
        assert!(after[0], "it closed as soon as the key went up");
        assert!(!after[3], "it was open 40 ms after the key went up, with 30 ms of release");
    }

    #[test]
    fn by_its_level_what_is_louder_than_the_sensitivity_goes_through_and_is_held_in_pauses() {
        let (mut gate, _, _) = gate(settings(|s| {
            s.auto_sensitivity = false;
            s.sensitivity = -50.;
        }));
        let now = gate.settings.lock().clone();
        assert!(!gate.decide(&now, 1., -60.), "quiet speech went through");
        assert!(gate.decide(&now, 0., -40.));
        assert!((0..20).all(|_| gate.decide(&now, 0., -60.)), "it closed in a pause of 200 ms");
        assert!((0..HOLD_LOUD).any(|_| !gate.decide(&now, 0., -60.)), "it never closed");
    }

    #[test]
    fn by_itself_it_takes_sure_speech_or_a_few_likely_frames_and_less_keeps_it_open() {
        let (mut gate, _, _) = gate(settings(|_| {}));
        let now = gate.settings.lock().clone();
        assert!(!gate.decide(&now, 0.6, -20.), "one frame that might be speech, a click, went through");
        assert!(!gate.decide(&now, 0.1, -20.));
        assert!(!gate.decide(&now, 0.6, -20.));
        assert!(!gate.decide(&now, 0.6, -20.));
        assert!(gate.decide(&now, 0.6, -20.), "three frames in a row that might be speech didn't go through");

        let (mut sure, _, _) = self::gate(now.clone());
        assert!(sure.decide(&now, 0.9, -20.), "what's surely speech didn't go through at once");
        // Once open, what's less likely keeps it open, as the ends of words are.
        sure.open = true;
        assert!((0..HOLD_SPEECH * 2).all(|_| sure.decide(&now, 0.3, -30.)), "it closed on the end of a word");
        sure.open = false;
        assert!((0..HOLD_SPEECH).any(|_| !sure.decide(&now, 0.3, -30.)), "it never closed");
    }

    #[test]
    fn what_leaves_is_held_back_so_the_gate_is_open_by_the_first_sound_of_a_word() {
        let (mut gate, _, reading) = gate(settings(|s| {
            s.auto_sensitivity = false;
            s.sensitivity = -60.;
            s.noise_suppression = "off".into();
        }));
        let quiet = vec![0i16; FRAME];
        let loud = tone(0.5);
        assert!(gate.process(&quiet).is_none() && gate.process(&quiet).is_none(), "something left before the lookahead was full");
        // The word comes in: the quiet held before it leaves, while the gate opens.
        for _ in 0..2 {
            assert!(gate.process(&loud).unwrap().iter().all(|sample| *sample == 0));
        }
        assert!(reading.lock().open);
        assert_eq!(gate.process(&loud).unwrap(), loud, "the word's first sound was faded");
        for _ in 0..2 {
            gate.process(&loud);
        }
        assert!(reading.lock().level > -20., "how loud it is wasn't reported: {:?}", reading.lock());

        // Muted in the middle of a word, it fades out rather than cutting it off.
        gate.settings.lock().muted = true;
        let fading = gate.process(&loud).unwrap();
        assert!(!reading.lock().open, "it stayed open muted");
        assert!(fading.iter().any(|sample| *sample != 0), "the word was cut off");
        let mut last = Vec::new();
        for _ in 0..6 {
            last = gate.process(&loud).unwrap();
        }
        assert!(last.iter().all(|sample| *sample == 0), "it went on muted");
    }

    #[test]
    fn with_rnnoise_what_leaves_is_what_it_cleaned() {
        let (mut gate, _, reading) = gate(settings(|s| {
            s.noise_suppression = "zuna".into();
            s.auto_sensitivity = false;
            s.sensitivity = -100.;
        }));
        let loud = tone(0.5);
        let out: Vec<Vec<i16>> = (0..10).filter_map(|_| gate.process(&loud)).collect();
        assert_eq!(out.len(), 10 - LOOKAHEAD_FRAMES);
        assert!(reading.lock().open);
        assert_ne!(out.last().unwrap(), &loud, "RNNoise's cleaning wasn't what left");
    }
}
