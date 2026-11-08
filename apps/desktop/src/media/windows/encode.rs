//! Writing voice and video messages as the web sends them, with Windows's own
//! encoders: AAC in MP4 for a voice message, H.264 and AAC in MP4 for a video message.

use std::path::Path;

use windows::Win32::Media::MediaFoundation::*;
use windows::core::HSTRING;

use super::mf::start;

pub use crate::media::RATE;
/// AAC at 96 kbit/s, the least Windows's encoder takes for one channel.
const AAC_BYTES_PER_SECOND: u32 = 12_000;

fn audio_types() -> windows::core::Result<(IMFMediaType, IMFMediaType)> {
    unsafe {
        let output = MFCreateMediaType()?;
        output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        output.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
        output.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        output.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE)?;
        output.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)?;
        output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
        let input = MFCreateMediaType()?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
        input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE)?;
        input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)?;
        input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2)?;
        input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE * 2)?;
        Ok((output, input))
    }
}

fn sample(bytes: &[u8], at: i64, duration: i64) -> windows::core::Result<IMFSample> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(bytes.len() as u32)?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None)?;
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(bytes.len() as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(at)?;
        sample.SetSampleDuration(duration)?;
        Ok(sample)
    }
}

/// Writes PCM, as recorded, into the writer's sound stream from a moment, in samples.
fn write_audio(writer: &IMFSinkWriter, stream: u32, samples: &[i16], first: u64) -> windows::core::Result<()> {
    for (index, chunk) in samples.chunks(1024).enumerate() {
        let start = first + index as u64 * 1024;
        let bytes: Vec<u8> = chunk.iter().flat_map(|sample| sample.to_le_bytes()).collect();
        let at = (start as i64 * 10_000_000) / RATE as i64;
        let duration = (chunk.len() as i64 * 10_000_000) / RATE as i64;
        unsafe { writer.WriteSample(stream, &sample(&bytes, at, duration)?)? };
    }
    Ok(())
}

/// A voice message: one channel of sound, recorded at 48 kHz, as AAC in MP4.
pub fn write_voice(path: &Path, samples: &[i16]) -> windows::core::Result<()> {
    start();
    unsafe {
        let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.to_string_lossy().as_ref()), None, None)?;
        let (output, input) = audio_types()?;
        let stream = writer.AddStream(&output)?;
        writer.SetInputMediaType(stream, &input, None)?;
        writer.BeginWriting()?;
        write_audio(&writer, stream, samples, 0)?;
        writer.Finalize()
    }
}

pub use crate::media::{ROUND_FPS, ROUND_SIZE};

/// Writes a video message as it's recorded: square frames and the sound beside them.
pub struct RoundWriter {
    writer: IMFSinkWriter,
    video: u32,
    audio: u32,
    audio_written: u64,
    frames: i64,
}

impl RoundWriter {
    pub fn create(path: &Path) -> windows::core::Result<RoundWriter> {
        start();
        unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1)?;
            let attributes = attributes.unwrap();
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.to_string_lossy().as_ref()), None, &attributes)?;
            let size = ((ROUND_SIZE as u64) << 32) | ROUND_SIZE as u64;
            let rate = ((ROUND_FPS as u64) << 32) | 1;
            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            output.SetUINT32(&MF_MT_AVG_BITRATE, 1_000_000)?;
            output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            output.SetUINT64(&MF_MT_FRAME_SIZE, size)?;
            output.SetUINT64(&MF_MT_FRAME_RATE, rate)?;
            output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            // Baseline, which everything plays, as the web's avc1.42E01E is.
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
            let video = writer.AddStream(&output)?;
            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            input.SetUINT64(&MF_MT_FRAME_SIZE, size)?;
            input.SetUINT64(&MF_MT_FRAME_RATE, rate)?;
            input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
            // Rows top first.
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, ROUND_SIZE * 4)?;
            writer.SetInputMediaType(video, &input, None)?;
            let (audio_output, audio_input) = audio_types()?;
            let audio = writer.AddStream(&audio_output)?;
            writer.SetInputMediaType(audio, &audio_input, None)?;
            writer.BeginWriting()?;
            Ok(RoundWriter { writer, video, audio, audio_written: 0, frames: 0 })
        }
    }

    /// The next frame: ROUND_SIZE square, BGRA, top row first.
    pub fn frame(&mut self, bgra: &[u8]) -> windows::core::Result<()> {
        let duration = 10_000_000 / ROUND_FPS as i64;
        let at = self.frames * duration;
        self.frames += 1;
        unsafe { self.writer.WriteSample(self.video, &sample(bgra, at, duration)?) }
    }

    /// More of the sound, as recorded.
    pub fn sound(&mut self, samples: &[i16]) -> windows::core::Result<()> {
        write_audio(&self.writer, self.audio, samples, self.audio_written)?;
        self.audio_written += samples.len() as u64;
        Ok(())
    }

    pub fn seconds(&self) -> f64 {
        self.frames as f64 / ROUND_FPS as f64
    }

    pub fn finish(self) -> windows::core::Result<()> {
        unsafe { self.writer.Finalize() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f64) -> Vec<i16> {
        (0..(seconds * RATE as f64) as usize).map(|index| ((index as f64 * 440. * std::f64::consts::TAU / RATE as f64).sin() * 12_000.) as i16).collect()
    }

    #[test]
    fn writes_a_voice_message_windows_and_the_others_can_read() {
        let path = std::env::temp_dir().join(format!("zuna-voice-test-{}.m4a", std::process::id()));
        write_voice(&path, &tone(2.)).unwrap();
        let (samples, rate) = crate::media::mf::decode_audio(&path).unwrap();
        let seconds = samples.len() as f64 / rate as f64;
        assert!((seconds - 2.).abs() < 0.2, "two seconds, not {seconds}");
        assert!(samples.iter().any(|sample| sample.abs() > 0.2), "it has the tone");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn writes_a_video_message() {
        let path = std::env::temp_dir().join(format!("zuna-round-test-{}.mp4", std::process::id()));
        let mut writer = RoundWriter::create(&path).unwrap();
        let sound = tone(1.);
        for index in 0..ROUND_FPS {
            let shade = (index * 8) as u8;
            let frame: Vec<u8> = (0..ROUND_SIZE * ROUND_SIZE).flat_map(|_| [shade, 128, 255 - shade, 255]).collect();
            writer.frame(&frame).unwrap();
            let per_frame = RATE as usize / ROUND_FPS as usize;
            writer.sound(&sound[index as usize * per_frame..(index as usize + 1) * per_frame]).unwrap();
        }
        writer.finish().unwrap();
        let mut frames = crate::media::mf::VideoFrames::open(&path).unwrap();
        assert_eq!((frames.width, frames.height), (ROUND_SIZE, ROUND_SIZE));
        assert!(frames.next().unwrap().is_some());
        let (samples, _) = crate::media::mf::decode_audio(&path).unwrap();
        assert!(!samples.is_empty());
        std::fs::remove_file(path).ok();
    }
}
