//! The small sounds a voice channel makes, and a call's ringing, synthesized as the desktop's
//! are (packages/ui/src/voice/sounds.ts), so no audio files are bundled.

use super::audio::RATE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceSound {
    Join,
    Leave,
    SelfJoin,
    SelfLeave,
    Mute,
    Unmute,
    Deafen,
    Undeafen,
    PttDown,
    PttUp,
}

type Note = (f64, f64, f64);

fn notes(sound: VoiceSound) -> &'static [Note] {
    match sound {
        VoiceSound::Join => &[(0., 523.25, 0.1), (0.08, 783.99, 0.16)],
        VoiceSound::Leave => &[(0., 783.99, 0.1), (0.08, 523.25, 0.16)],
        VoiceSound::SelfJoin => &[(0., 587.33, 0.09), (0.07, 739.99, 0.09), (0.14, 987.77, 0.18)],
        VoiceSound::SelfLeave => &[(0., 987.77, 0.09), (0.07, 739.99, 0.09), (0.14, 587.33, 0.18)],
        VoiceSound::Mute => &[(0., 493.88, 0.09)],
        VoiceSound::Unmute => &[(0., 659.25, 0.09)],
        VoiceSound::Deafen => &[(0., 493.88, 0.08), (0.07, 392., 0.1)],
        VoiceSound::Undeafen => &[(0., 493.88, 0.08), (0.07, 659.25, 0.1)],
        VoiceSound::PttDown => &[(0., 880., 0.03)],
        VoiceSound::PttUp => &[(0., 660., 0.03)],
    }
}

/// Sine notes, each rising in 10 ms and falling away exponentially, as interleaved stereo.
pub fn render_notes(notes: &[Note], volume: f32) -> Vec<f32> {
    let end = notes.iter().map(|(offset, _, length)| offset + length + 0.02).fold(0., f64::max);
    let total = (end * RATE as f64) as usize;
    let mut out = vec![0f32; total * 2];
    let peak = (0.08 * volume as f64).max(0.0002);
    for &(offset, frequency, length) in notes {
        let start = (offset * RATE as f64) as usize;
        let samples = ((length + 0.02) * RATE as f64) as usize;
        for index in 0..samples {
            let t = index as f64 / RATE as f64;
            // From 0.0001 up to the peak in 10 ms, then down to 0.0001 by the note's end.
            let gain = if t < 0.01 {
                0.0001 * (peak / 0.0001).powf(t / 0.01)
            } else if t < length {
                peak * (0.0001 / peak).powf((t - 0.01) / (length - 0.01))
            } else {
                0.
            };
            let value = ((t * frequency * std::f64::consts::TAU).sin() * gain) as f32;
            if let Some(slot) = out.get_mut((start + index) * 2..(start + index) * 2 + 2) {
                slot[0] += value;
                slot[1] += value;
            }
        }
    }
    out
}

pub fn render(sound: VoiceSound, volume: f32) -> Vec<f32> {
    render_notes(notes(sound), volume)
}

/// "Incoming" rings for a call coming in. "Outgoing" is what the one calling hears while it rings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ringing {
    Incoming,
    Outgoing,
}

/// How often a ring repeats, in ms, and the ring itself.
pub fn ring(kind: Ringing, volume: f32) -> (u64, Vec<f32>) {
    match kind {
        Ringing::Incoming => (2600, render_notes(&[(0., 659.25, 0.16), (0.18, 830.61, 0.16), (0.36, 987.77, 0.3), (0.9, 659.25, 0.16), (1.08, 830.61, 0.16), (1.26, 987.77, 0.3)], 2.5 * volume)),
        Ringing::Outgoing => (3000, render_notes(&[(0., 440., 1.1)], 0.8 * volume)),
    }
}
