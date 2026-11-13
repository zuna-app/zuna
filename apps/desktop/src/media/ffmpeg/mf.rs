//! Reading sound and pictures out of media files through FFmpeg: AAC or Opus, and H.264, in
//! MP4, as Media Foundation reads them on Windows, and whatever else its demuxers and decoders
//! take, for a soundboard's sound.

use std::path::Path;

use ffmpeg_next as ffmpeg;
use ffmpeg::format::sample::Type as Packing;
use ffmpeg::format::{Pixel, Sample};
use ffmpeg::software::{resampling, scaling};
use ffmpeg::{ChannelLayout, codec, frame, media};

pub use crate::media::{Details, Frame, poster};

/// Readies FFmpeg once, quiet but for its errors.
pub(super) fn init() {
    static READY: std::sync::Once = std::sync::Once::new();
    READY.call_once(|| {
        ffmpeg::init().ok();
        ffmpeg::log::set_level(ffmpeg::log::Level::Error);
    });
}

pub(super) fn text(error: ffmpeg::Error) -> String {
    error.to_string()
}

/// A video's length and picture size, or a sound's length.
pub fn details(path: &Path) -> Option<Details> {
    init();
    let input = ffmpeg::format::input(path).ok()?;
    let mut details = Details::default();
    if input.duration() > 0 {
        details.duration = Some(input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE));
    }
    if let Some(stream) = input.streams().best(media::Type::Video) {
        let decoder = codec::Context::from_parameters(stream.parameters()).ok()?.decoder().video().ok()?;
        details.width = Some(decoder.width());
        details.height = Some(decoder.height());
    }
    if details.duration.is_none() {
        details.duration = decode_audio(path).ok().filter(|(_, rate)| *rate > 0).map(|(samples, rate)| samples.len() as f64 / rate as f64);
    }
    Some(details)
}

/// The sound in one channel, and how many samples a second.
pub fn decode_audio(path: &Path) -> Result<(Vec<f32>, u32), String> {
    init();
    let mut input = ffmpeg::format::input(path).map_err(text)?;
    let stream = input.streams().best(media::Type::Audio).ok_or("It has no audio.")?;
    let index = stream.index();
    let mut decoder = codec::Context::from_parameters(stream.parameters()).map_err(text)?.decoder().audio().map_err(text)?;
    let mut mono = Vec::new();
    let mut resampler: Option<resampling::Context> = None;
    let mut rate = decoder.rate();
    let take = |decoder: &mut ffmpeg::decoder::Audio, mono: &mut Vec<f32>, resampler: &mut Option<resampling::Context>, rate: &mut u32| -> Result<(), String> {
        let mut decoded = frame::Audio::empty();
        while decoder.receive_frame(&mut decoded).is_ok() {
            // Many files don't say how their channels are laid out, only how many there are.
            let layout = if decoded.channel_layout().is_empty() { ChannelLayout::default(decoded.channels() as i32) } else { decoded.channel_layout() };
            decoded.set_channel_layout(layout);
            if resampler.is_none() {
                *rate = decoded.rate();
                *resampler = Some(resampling::Context::get(decoded.format(), layout, decoded.rate(), Sample::F32(Packing::Packed), ChannelLayout::MONO, decoded.rate()).map_err(text)?);
            }
            let mut out = frame::Audio::empty();
            resampler.as_mut().expect("made above").run(&decoded, &mut out).map_err(text)?;
            mono.extend_from_slice(&out.plane::<f32>(0)[..out.samples()]);
        }
        Ok(())
    };
    for (stream, packet) in input.packets() {
        if stream.index() == index && decoder.send_packet(&packet).is_ok() {
            take(&mut decoder, &mut mono, &mut resampler, &mut rate)?;
        }
    }
    decoder.send_eof().ok();
    take(&mut decoder, &mut mono, &mut resampler, &mut rate)?;
    if let Some(resampler) = resampler.as_mut() {
        let mut rest = frame::Audio::empty();
        if resampler.flush(&mut rest).is_ok() && rest.samples() > 0 {
            mono.extend_from_slice(&rest.plane::<f32>(0)[..rest.samples()]);
        }
    }
    Ok((mono, rate))
}

/// Reads a video's frames one at a time, as BGRA, for playing it.
pub struct VideoFrames {
    input: ffmpeg::format::context::Input,
    decoder: ffmpeg::decoder::Video,
    scaler: Option<scaling::Context>,
    index: usize,
    seconds_per_tick: f64,
    ended: bool,
    /// After a seek, the moment before which frames are decoded but not handed on.
    skip_until: Option<f64>,
    pub width: u32,
    pub height: u32,
}

impl VideoFrames {
    pub fn open(path: &Path) -> Result<VideoFrames, String> {
        init();
        let input = ffmpeg::format::input(path).map_err(text)?;
        let stream = input.streams().best(media::Type::Video).ok_or("It has no video.")?;
        let index = stream.index();
        let seconds_per_tick = f64::from(stream.time_base());
        let decoder = codec::Context::from_parameters(stream.parameters()).map_err(text)?.decoder().video().map_err(text)?;
        let (width, height) = (decoder.width(), decoder.height());
        Ok(VideoFrames { input, decoder, scaler: None, index, seconds_per_tick, ended: false, skip_until: None, width, height })
    }

    /// The next frame, or none at the end.
    pub fn next(&mut self) -> Result<Option<Frame>, String> {
        loop {
            let mut decoded = frame::Video::empty();
            if self.decoder.receive_frame(&mut decoded).is_ok() {
                let at = self.at(&decoded);
                if self.skip_until.is_some_and(|until| at + 0.001 < until) {
                    continue;
                }
                self.skip_until = None;
                return self.convert(&decoded, at).map(Some);
            }
            if self.ended {
                return Ok(None);
            }
            // The next packet of this stream, or the end of the file.
            let mut packet = ffmpeg::Packet::empty();
            loop {
                match packet.read(&mut self.input) {
                    Ok(()) if packet.stream() == self.index => {
                        self.decoder.send_packet(&packet).ok();
                        break;
                    }
                    Ok(()) => continue,
                    Err(ffmpeg::Error::Eof) => {
                        self.ended = true;
                        self.decoder.send_eof().ok();
                        break;
                    }
                    Err(error) => return Err(text(error)),
                }
            }
        }
    }

    /// When a frame shows, in seconds from the start.
    fn at(&self, decoded: &frame::Video) -> f64 {
        decoded.timestamp().or(decoded.pts()).map(|ticks| ticks as f64 * self.seconds_per_tick).unwrap_or(0.)
    }

    fn convert(&mut self, decoded: &frame::Video, at: f64) -> Result<Frame, String> {
        let (width, height) = (decoded.width(), decoded.height());
        let stale = self.scaler.as_ref().is_none_or(|scaler| scaler.input().width != width || scaler.input().height != height || scaler.input().format != decoded.format());
        if stale {
            self.scaler = Some(scaling::Context::get(decoded.format(), width, height, Pixel::BGRA, width, height, scaling::Flags::BILINEAR).map_err(text)?);
            (self.width, self.height) = (width, height);
        }
        let mut bgra = frame::Video::empty();
        self.scaler.as_mut().expect("made above").run(decoded, &mut bgra).map_err(text)?;
        let row = width as usize * 4;
        let stride = bgra.stride(0);
        let data = bgra.data(0);
        let mut pixels = vec![0u8; row * height as usize];
        for (y, line) in pixels.chunks_exact_mut(row).enumerate() {
            line.copy_from_slice(&data[y * stride..y * stride + row]);
        }
        Ok(Frame { at, bgra: pixels })
    }

    /// Moves to a moment, in seconds: to the keyframe before it, decoding on from there to the
    /// frame that shows then.
    pub fn seek(&mut self, seconds: f64) -> Result<(), String> {
        let at = (seconds.max(0.) * f64::from(ffmpeg::ffi::AV_TIME_BASE)) as i64;
        self.input.seek(at, ..at).map_err(text)?;
        self.decoder.flush();
        self.ended = false;
        self.skip_until = (seconds > 0.).then_some(seconds);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The iPhone's fixtures, from the app's crate, or from macOS's media library beside it.
    fn fixture(name: &str) -> std::path::PathBuf {
        let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        ["../ios", "../../ios"].iter().map(|apps| crate_dir.join(apps).join("ZunaKit/Tests/ZunaHostTests/Fixtures").join(name)).find(|path| path.exists()).unwrap_or_default()
    }

    #[test]
    fn decodes_the_desktops_voice_and_video_messages() {
        for name in ["chromium-opus.m4a", "firefox-opus.m4a", "chromium-round.mp4", "firefox-round.mp4"] {
            let (samples, rate) = decode_audio(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(rate > 0 && samples.len() > rate as usize / 10, "{name} has sound");
            let found = details(&fixture(name)).unwrap();
            assert!(found.duration.is_some_and(|seconds| seconds > 0.), "{name} has a length");
        }
        for name in ["chromium-round.mp4", "firefox-round.mp4"] {
            let mut frames = VideoFrames::open(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(frames.width > 0 && frames.height > 0);
            let first = frames.next().unwrap().unwrap_or_else(|| panic!("{name} has a picture"));
            assert_eq!(first.bgra.len(), (frames.width * frames.height * 4) as usize);
            frames.seek(0.5).unwrap();
            assert!(frames.next().unwrap().is_some_and(|frame| frame.at > 0.2), "{name} seeks");
            assert!(poster(&fixture(name), 0., 160, 50).is_some_and(|(jpeg, width, _)| jpeg.starts_with(&[0xff, 0xd8]) && width <= 160));
        }
    }
}
