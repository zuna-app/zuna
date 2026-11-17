//! The computer's sound shared into a Telegram call, which goes in the call's one sound, mixed
//! into the microphone's on its way out: Telegram's apps play one sound of the other side's, so a
//! stream of its own, as a room's share sends, would never be heard (docs/TELEGRAM_CALLS_PLAN.md).
//! It goes after the microphone's processing and gate, so neither takes it for noise, and while
//! muted too; with no microphone taking frames, it goes by itself.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::voice::audio::{FRAME, RATE};

/// The most held for the microphone to take, past which the oldest goes, as its clock and the
/// sound system's drift apart.
const MOST_HELD: usize = RATE as usize / 10;
/// A microphone that hasn't taken a frame for this long isn't there to carry the sound.
const MIC_GONE: Duration = Duration::from_millis(100);
/// How loud it goes against the voice: a little under, so that speaking over it doesn't clip.
const LEVEL: f32 = 0.7;

#[derive(Default)]
pub struct ShareMix {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    held: VecDeque<i16>,
    on: bool,
    taken_at: Option<Instant>,
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
impl ShareMix {
    /// Starts taking the computer's sound, or stops, forgetting what's held.
    pub fn set_on(&self, on: bool) {
        let mut inner = self.inner.lock();
        inner.on = on;
        inner.held.clear();
    }

    /// A piece of the computer's sound, stereo at 48 kHz, interleaved, made mono. What comes back
    /// is whole frames to send by themselves, while no microphone takes them.
    pub fn push(&self, stereo: &[f32]) -> Vec<Vec<i16>> {
        let mut inner = self.inner.lock();
        if !inner.on {
            return Vec::new();
        }
        for pair in stereo.chunks_exact(2) {
            let mono = (pair[0] + pair[1]) / 2. * LEVEL;
            inner.held.push_back((mono.clamp(-1., 1.) * 32767.) as i16);
        }
        let over = inner.held.len().saturating_sub(MOST_HELD);
        inner.held.drain(..over);
        if inner.taken_at.is_some_and(|at| at.elapsed() < MIC_GONE) {
            return Vec::new();
        }
        let mut frames = Vec::new();
        while inner.held.len() >= FRAME {
            frames.push(inner.held.drain(..FRAME).collect());
        }
        frames
    }

    /// Adds what's held to a frame of the microphone's, as it goes out.
    pub fn mix(&self, frame: &mut [i16]) {
        let mut inner = self.inner.lock();
        inner.taken_at = Some(Instant::now());
        if !inner.on {
            return;
        }
        for sample in frame.iter_mut() {
            let Some(shared) = inner.held.pop_front() else { break };
            *sample = sample.saturating_add(shared);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_sound_goes_in_the_microphones_frames_made_mono() {
        let mix = ShareMix::default();
        let mut quiet = vec![0i16; FRAME];
        mix.mix(&mut quiet);
        // Off, nothing's taken or added.
        assert!(mix.push(&[0.5; FRAME * 2]).is_empty());
        mix.mix(&mut quiet);
        assert!(quiet.iter().all(|sample| *sample == 0));
        mix.set_on(true);
        let stereo: Vec<f32> = (0..FRAME).flat_map(|_| [0.5, 0.]).collect();
        assert!(mix.push(&stereo).is_empty(), "the microphone takes it");
        let mut voice = vec![1000i16; FRAME];
        mix.mix(&mut voice);
        let expected = 1000 + (0.25 * LEVEL * 32767.) as i16;
        assert!(voice.iter().all(|sample| *sample == expected), "{voice:?}");
        // Loud over loud doesn't wrap around.
        mix.push(&[1.; FRAME * 2]);
        let mut loud = vec![i16::MAX - 10; FRAME];
        mix.mix(&mut loud);
        assert!(loud.iter().all(|sample| *sample == i16::MAX));
    }

    #[test]
    fn with_no_microphone_taking_frames_it_goes_by_itself_and_never_piles_up() {
        let mix = ShareMix::default();
        mix.set_on(true);
        let frames = mix.push(&vec![0.5; FRAME * 2 * 3 + 20]);
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|frame| frame.len() == FRAME));
        // A microphone that took a frame once, and stopped.
        mix.mix(&mut vec![0; FRAME]);
        assert!(mix.push(&vec![0.5; RATE as usize * 2]).is_empty(), "the microphone's still thought to be there");
        assert_eq!(mix.inner.lock().held.len(), MOST_HELD, "held to the most");
        mix.set_on(false);
        assert!(mix.inner.lock().held.is_empty());
    }
}
