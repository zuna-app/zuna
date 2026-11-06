//! Writing voice and video messages as the desktop sends them, through FFmpeg: AAC in MP4 for
//! a voice message, and H.264 Baseline (OpenH264) and AAC in MP4 for a video message, as
//! Windows writes them. Chromium on Linux writes Opus, as it has no AAC encoder, which costs
//! the iPhone a slice of each message.

use std::path::Path;

use ffmpeg_next as ffmpeg;
use ffmpeg::format::sample::Type as Packing;
use ffmpeg::format::{Pixel, Sample};
use ffmpeg::software::scaling;
use ffmpeg::{ChannelLayout, Rational, codec, encoder, frame};

use super::mf::{init, text};
pub use crate::media::{RATE, ROUND_FPS, ROUND_SIZE};

/// AAC at 96 kbit/s, as Windows writes it.
const AAC_BITS_PER_SECOND: usize = 96_000;
/// A video message's picture, as Windows writes it.
const H264_BITS_PER_SECOND: usize = 1_000_000;

/// Sound as AAC, a frame at a time, into a stream of the file.
struct AacStream {
    encoder: encoder::Audio,
    stream: usize,
    pending: Vec<f32>,
    written: i64,
}

impl AacStream {
    fn add(output: &mut ffmpeg::format::context::Output) -> Result<AacStream, String> {
        let codec = encoder::find(codec::Id::AAC).ok_or("There's no AAC encoder.")?;
        let global = output.format().flags().contains(ffmpeg::format::Flags::GLOBAL_HEADER);
        let mut stream = output.add_stream(codec).map_err(text)?;
        let mut context = codec::Context::new_with_codec(codec).encoder().audio().map_err(text)?;
        context.set_rate(RATE as i32);
        context.set_channel_layout(ChannelLayout::MONO);
        context.set_format(Sample::F32(Packing::Planar));
        context.set_bit_rate(AAC_BITS_PER_SECOND);
        context.set_time_base(Rational::new(1, RATE as i32));
        if global {
            context.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        let encoder = context.open_as(codec).map_err(text)?;
        stream.set_parameters(&encoder);
        stream.set_time_base(Rational::new(1, RATE as i32));
        Ok(AacStream { encoder, stream: stream.index(), pending: Vec::new(), written: 0 })
    }

    /// Takes samples, and writes each whole frame of them.
    fn take(&mut self, output: &mut ffmpeg::format::context::Output, samples: &[i16]) -> Result<(), String> {
        self.pending.extend(samples.iter().map(|sample| *sample as f32 / 32768.));
        let size = self.encoder.frame_size().max(1) as usize;
        while self.pending.len() >= size {
            let chunk: Vec<f32> = self.pending.drain(..size).collect();
            self.encode(output, &chunk)?;
        }
        Ok(())
    }

    fn encode(&mut self, output: &mut ffmpeg::format::context::Output, chunk: &[f32]) -> Result<(), String> {
        let mut audio = frame::Audio::new(Sample::F32(Packing::Planar), chunk.len(), ChannelLayout::MONO);
        audio.set_rate(RATE);
        audio.plane_mut::<f32>(0)[..chunk.len()].copy_from_slice(chunk);
        audio.set_pts(Some(self.written));
        self.written += chunk.len() as i64;
        self.encoder.send_frame(&audio).map_err(text)?;
        self.drain(output)
    }

    fn drain(&mut self, output: &mut ffmpeg::format::context::Output) -> Result<(), String> {
        let mut packet = ffmpeg::Packet::empty();
        while self.encoder.receive_packet(&mut packet).is_ok() {
            packet.set_stream(self.stream);
            packet.rescale_ts(Rational::new(1, RATE as i32), output.stream(self.stream).ok_or("no stream")?.time_base());
            packet.write_interleaved(output).map_err(text)?;
        }
        Ok(())
    }

    /// Writes what's left, the last frame shorter, as the encoder allows.
    fn finish(&mut self, output: &mut ffmpeg::format::context::Output) -> Result<(), String> {
        let rest = std::mem::take(&mut self.pending);
        if !rest.is_empty() {
            self.encode(output, &rest)?;
        }
        self.encoder.send_eof().map_err(text)?;
        self.drain(output)
    }
}

/// A voice message: one channel of sound, recorded at 48 kHz, as AAC in MP4.
pub fn write_voice(path: &Path, samples: &[i16]) -> Result<(), String> {
    init();
    let mut output = ffmpeg::format::output_as(path, "mp4").map_err(text)?;
    let mut sound = AacStream::add(&mut output)?;
    output.write_header().map_err(text)?;
    sound.take(&mut output, samples)?;
    sound.finish(&mut output)?;
    output.write_trailer().map_err(text)
}

/// A video message being written: square frames of ROUND_SIZE, BGRA, at ROUND_FPS, and the
/// sound beside them.
pub struct RoundWriter {
    output: ffmpeg::format::context::Output,
    video: encoder::Video,
    video_stream: usize,
    scaler: scaling::Context,
    sound: AacStream,
    frames: i64,
}

impl RoundWriter {
    pub fn create(path: &Path) -> Result<RoundWriter, String> {
        init();
        let mut output = ffmpeg::format::output_as(path, "mp4").map_err(text)?;
        let codec = encoder::find_by_name("libopenh264").ok_or("There's no H.264 encoder.")?;
        let global = output.format().flags().contains(ffmpeg::format::Flags::GLOBAL_HEADER);
        let mut stream = output.add_stream(codec).map_err(text)?;
        let mut context = codec::Context::new_with_codec(codec).encoder().video().map_err(text)?;
        context.set_width(ROUND_SIZE);
        context.set_height(ROUND_SIZE);
        context.set_format(Pixel::YUV420P);
        context.set_time_base(Rational::new(1, ROUND_FPS as i32));
        context.set_frame_rate(Some(Rational::new(ROUND_FPS as i32, 1)));
        context.set_bit_rate(H264_BITS_PER_SECOND);
        // A keyframe a second, so that the start of any second plays at once.
        context.set_gop(ROUND_FPS);
        if global {
            context.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        // Constrained Baseline, which OpenH264 writes unless told otherwise, and everything
        // plays, as the desktop's avc1.42E01E is.
        let video = context.open_as(codec).map_err(text)?;
        stream.set_parameters(&video);
        stream.set_time_base(Rational::new(1, ROUND_FPS as i32));
        let video_stream = stream.index();
        let sound = AacStream::add(&mut output)?;
        output.write_header().map_err(text)?;
        let scaler = scaling::Context::get(Pixel::BGRA, ROUND_SIZE, ROUND_SIZE, Pixel::YUV420P, ROUND_SIZE, ROUND_SIZE, scaling::Flags::BILINEAR).map_err(text)?;
        Ok(RoundWriter { output, video, video_stream, scaler, sound, frames: 0 })
    }

    /// One frame, BGRA, top row first.
    pub fn frame(&mut self, bgra: &[u8]) -> Result<(), String> {
        let mut picture = frame::Video::new(Pixel::BGRA, ROUND_SIZE, ROUND_SIZE);
        let row = ROUND_SIZE as usize * 4;
        let stride = picture.stride(0);
        for (y, line) in bgra.chunks_exact(row).take(ROUND_SIZE as usize).enumerate() {
            picture.data_mut(0)[y * stride..y * stride + row].copy_from_slice(line);
        }
        let mut yuv = frame::Video::empty();
        self.scaler.run(&picture, &mut yuv).map_err(text)?;
        yuv.set_pts(Some(self.frames));
        self.frames += 1;
        self.video.send_frame(&yuv).map_err(text)?;
        self.drain_video()
    }

    fn drain_video(&mut self) -> Result<(), String> {
        let mut packet = ffmpeg::Packet::empty();
        while self.video.receive_packet(&mut packet).is_ok() {
            packet.set_stream(self.video_stream);
            packet.rescale_ts(Rational::new(1, ROUND_FPS as i32), self.output.stream(self.video_stream).ok_or("no stream")?.time_base());
            packet.write_interleaved(&mut self.output).map_err(text)?;
        }
        Ok(())
    }

    /// Sound that goes with the frames, at 48 kHz in one channel.
    pub fn sound(&mut self, samples: &[i16]) -> Result<(), String> {
        self.sound.take(&mut self.output, samples)
    }

    /// How long it is so far, by its frames.
    pub fn seconds(&self) -> f64 {
        self.frames as f64 / ROUND_FPS as f64
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.video.send_eof().map_err(text)?;
        self.drain_video()?;
        self.sound.finish(&mut self.output)?;
        self.output.write_trailer().map_err(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f64) -> Vec<i16> {
        (0..(seconds * RATE as f64) as usize).map(|index| ((index as f64 * 440. * std::f64::consts::TAU / RATE as f64).sin() * 12_000.) as i16).collect()
    }

    #[test]
    fn writes_a_voice_message_that_reads_back() {
        let path = std::env::temp_dir().join(format!("zuna-voice-{}.m4a", std::process::id()));
        write_voice(&path, &tone(2.)).unwrap();
        let (samples, rate) = super::super::mf::decode_audio(&path).unwrap();
        std::fs::remove_file(&path).ok();
        let seconds = samples.len() as f64 / rate as f64;
        assert!((seconds - 2.).abs() < 0.2, "two seconds, not {seconds}");
        assert!(samples.iter().any(|sample| sample.abs() > 0.2), "the tone is in it");
    }

    #[test]
    fn writes_a_video_message_that_reads_back() {
        let path = std::env::temp_dir().join(format!("zuna-round-{}.mp4", std::process::id()));
        let mut writer = RoundWriter::create(&path).unwrap();
        for index in 0..ROUND_FPS {
            let shade = (index * 8) as u8;
            let picture: Vec<u8> = (0..ROUND_SIZE * ROUND_SIZE).flat_map(|_| [shade, 128, 255 - shade, 255]).collect();
            writer.frame(&picture).unwrap();
            let per_frame = RATE as usize / ROUND_FPS as usize;
            writer.sound(&tone(1.)[index as usize * per_frame..(index as usize + 1) * per_frame]).unwrap();
        }
        assert!((writer.seconds() - 1.).abs() < 0.01);
        writer.finish().unwrap();
        let details = super::super::mf::details(&path).unwrap();
        assert_eq!((details.width, details.height), (Some(ROUND_SIZE), Some(ROUND_SIZE)));
        assert!(details.duration.is_some_and(|seconds| (seconds - 1.).abs() < 0.2), "{:?}", details.duration);
        let mut frames = super::super::mf::VideoFrames::open(&path).unwrap();
        let first = frames.next().unwrap().unwrap();
        // Red, as the first frame's BGRA has it, within what H.264's colour allows.
        assert!(first.bgra[2] > 200 && first.bgra[0] < 60, "{:?}", &first.bgra[..4]);
        assert!(super::super::mf::decode_audio(&path).unwrap().0.len() > RATE as usize / 2);
        std::fs::remove_file(&path).ok();
    }
}
