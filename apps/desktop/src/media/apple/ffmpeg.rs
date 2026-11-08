//! FFmpeg on macOS, from the library beside the app (`media-ffmpeg`): the same `encode` and
//! `mf` as Linux builds into the app, called through C. libwebrtc, linked into the app for
//! LiveKit, carries Chromium's own copy of FFmpeg, whose symbols the linker would otherwise
//! take for the app's calls, so FFmpeg's are kept to a library of their own, which only
//! reaches the FFmpeg it was linked to.

use std::ffi::{CString, c_char};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use libloading::{Library, Symbol};

/// The library, from the bundle's Frameworks, or where a development build made it.
fn library() -> Result<&'static Library, String> {
    static LOADED: OnceLock<Result<Library, String>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            let mut candidates: Vec<PathBuf> = Vec::new();
            if let Some(path) = std::env::var_os("ZUNA_MEDIA_LIBRARY") {
                candidates.push(path.into());
            }
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    candidates.push(dir.join("../Frameworks/libzuna_media_ffmpeg.dylib"));
                    candidates.push(dir.join("libzuna_media_ffmpeg.dylib"));
                }
            }
            let found = candidates.into_iter().find(|path| path.exists()).ok_or("This build has no media library.")?;
            // SAFETY: the library is the app's own, whose loading runs nothing of note.
            unsafe { Library::new(&found) }.map_err(|error| format!("The media library didn't load: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn function<T>(name: &[u8]) -> Result<Symbol<'static, T>, String> {
    // SAFETY: each name is called with the signature ffi.rs gives it.
    unsafe { library()?.get::<T>(name) }.map_err(|error| error.to_string())
}

fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "That file's name can't be read.".to_string())
}

/// What a failed call said, freed after it's read.
fn said(error: *mut c_char) -> String {
    if error.is_null() {
        return "It didn't work.".into();
    }
    // SAFETY: made by the library, and freed by it after this copy.
    let text = unsafe { std::ffi::CStr::from_ptr(error) }.to_string_lossy().into_owned();
    if let Ok(free) = function::<unsafe extern "C" fn(*mut c_char)>(b"zuna_media_free_string") {
        unsafe { free(error) };
    }
    text
}

pub mod encode {
    use std::ffi::{c_char, c_void};
    use std::path::Path;

    pub use crate::media::{RATE, ROUND_FPS, ROUND_SIZE};

    use super::{c_path, function, said};

    pub fn write_voice(path: &Path, samples: &[i16]) -> Result<(), String> {
        let write = function::<unsafe extern "C" fn(*const c_char, *const i16, usize, *mut *mut c_char) -> bool>(b"zuna_media_write_voice")?;
        let path = c_path(path)?;
        let mut error = std::ptr::null_mut();
        // SAFETY: the samples live for the call.
        if unsafe { write(path.as_ptr(), samples.as_ptr(), samples.len(), &mut error) } { Ok(()) } else { Err(said(error)) }
    }

    /// A video message being written.
    pub struct RoundWriter(*mut c_void);

    // SAFETY: the writer is used by one thread at a time, which may be any.
    unsafe impl Send for RoundWriter {}

    impl RoundWriter {
        pub fn create(path: &Path) -> Result<RoundWriter, String> {
            let create = function::<unsafe extern "C" fn(*const c_char, *mut *mut c_char) -> *mut c_void>(b"zuna_media_round_create")?;
            let path = c_path(path)?;
            let mut error = std::ptr::null_mut();
            let writer = unsafe { create(path.as_ptr(), &mut error) };
            if writer.is_null() { Err(said(error)) } else { Ok(RoundWriter(writer)) }
        }

        pub fn frame(&mut self, bgra: &[u8]) -> Result<(), String> {
            let frame = function::<unsafe extern "C" fn(*mut c_void, *const u8, usize, *mut *mut c_char) -> bool>(b"zuna_media_round_frame")?;
            let mut error = std::ptr::null_mut();
            if unsafe { frame(self.0, bgra.as_ptr(), bgra.len(), &mut error) } { Ok(()) } else { Err(said(error)) }
        }

        pub fn sound(&mut self, samples: &[i16]) -> Result<(), String> {
            let sound = function::<unsafe extern "C" fn(*mut c_void, *const i16, usize, *mut *mut c_char) -> bool>(b"zuna_media_round_sound")?;
            let mut error = std::ptr::null_mut();
            if unsafe { sound(self.0, samples.as_ptr(), samples.len(), &mut error) } { Ok(()) } else { Err(said(error)) }
        }

        pub fn seconds(&self) -> f64 {
            function::<unsafe extern "C" fn(*mut c_void) -> f64>(b"zuna_media_round_seconds").map(|seconds| unsafe { seconds(self.0) }).unwrap_or(0.)
        }

        pub fn finish(self) -> Result<(), String> {
            let finish = function::<unsafe extern "C" fn(*mut c_void, *mut *mut c_char) -> bool>(b"zuna_media_round_finish")?;
            // The library frees the writer, either way, so dropping it mustn't free it again.
            let raw = self.0;
            std::mem::forget(self);
            let mut error = std::ptr::null_mut();
            if unsafe { finish(raw, &mut error) } { Ok(()) } else { Err(said(error)) }
        }
    }

    impl Drop for RoundWriter {
        /// Given up part way, as when recording fails: the library lets it go without writing more.
        fn drop(&mut self) {
            if let Ok(free) = function::<unsafe extern "C" fn(*mut c_void)>(b"zuna_media_round_free") {
                // SAFETY: made by zuna_media_round_create, and not used again.
                unsafe { free(self.0) };
            }
        }
    }
}

pub mod mf {
    use std::ffi::{c_char, c_void};
    use std::path::Path;

    pub use crate::media::{Details, Frame, poster};

    use super::{c_path, function, said};

    pub fn details(path: &Path) -> Option<Details> {
        let details = function::<unsafe extern "C" fn(*const c_char, *mut f64, *mut u32, *mut u32) -> bool>(b"zuna_media_details").ok()?;
        let path = c_path(path).ok()?;
        let (mut duration, mut width, mut height) = (f64::NAN, 0u32, 0u32);
        if !unsafe { details(path.as_ptr(), &mut duration, &mut width, &mut height) } {
            return None;
        }
        Some(Details { duration: (!duration.is_nan()).then_some(duration), width: (width > 0).then_some(width), height: (height > 0).then_some(height) })
    }

    pub fn decode_audio(path: &Path) -> Result<(Vec<f32>, u32), String> {
        let decode = function::<unsafe extern "C" fn(*const c_char, *mut *mut f32, *mut usize, *mut u32, *mut *mut c_char) -> bool>(b"zuna_media_decode_audio")?;
        let free = function::<unsafe extern "C" fn(*mut f32, usize)>(b"zuna_media_free_samples")?;
        let path = c_path(path)?;
        let (mut samples, mut count, mut rate, mut error) = (std::ptr::null_mut(), 0usize, 0u32, std::ptr::null_mut());
        if !unsafe { decode(path.as_ptr(), &mut samples, &mut count, &mut rate, &mut error) } {
            return Err(said(error));
        }
        // SAFETY: the library gave this many samples, which it frees after this copy.
        let copied = unsafe { std::slice::from_raw_parts(samples, count) }.to_vec();
        unsafe { free(samples, count) };
        Ok((copied, rate))
    }

    /// A video's frames, BGRA, top row first, in order.
    pub struct VideoFrames {
        raw: *mut c_void,
        pub width: u32,
        pub height: u32,
    }

    // SAFETY: the frames are read by one thread at a time, which may be any.
    unsafe impl Send for VideoFrames {}

    impl VideoFrames {
        pub fn open(path: &Path) -> Result<VideoFrames, String> {
            let open = function::<unsafe extern "C" fn(*const c_char, *mut u32, *mut u32, *mut *mut c_char) -> *mut c_void>(b"zuna_media_frames_open")?;
            let path = c_path(path)?;
            let (mut width, mut height, mut error) = (0u32, 0u32, std::ptr::null_mut());
            let raw = unsafe { open(path.as_ptr(), &mut width, &mut height, &mut error) };
            if raw.is_null() { Err(said(error)) } else { Ok(VideoFrames { raw, width, height }) }
        }

        pub fn next(&mut self) -> Result<Option<Frame>, String> {
            let next = function::<unsafe extern "C" fn(*mut c_void, *mut f64, *mut *mut u8, *mut usize, *mut *mut c_char) -> i32>(b"zuna_media_frames_next")?;
            let free = function::<unsafe extern "C" fn(*mut u8, usize)>(b"zuna_media_free_bytes")?;
            let (mut at, mut bgra, mut length, mut error) = (0f64, std::ptr::null_mut(), 0usize, std::ptr::null_mut());
            match unsafe { next(self.raw, &mut at, &mut bgra, &mut length, &mut error) } {
                1 => {
                    // SAFETY: the library gave this many bytes, which it frees after this copy.
                    let copied = unsafe { std::slice::from_raw_parts(bgra, length) }.to_vec();
                    unsafe { free(bgra, length) };
                    Ok(Some(Frame { at, bgra: copied }))
                }
                0 => Ok(None),
                _ => Err(said(error)),
            }
        }

        pub fn seek(&mut self, seconds: f64) -> Result<(), String> {
            let seek = function::<unsafe extern "C" fn(*mut c_void, f64, *mut *mut c_char) -> bool>(b"zuna_media_frames_seek")?;
            let mut error = std::ptr::null_mut();
            if unsafe { seek(self.raw, seconds, &mut error) } { Ok(()) } else { Err(said(error)) }
        }
    }

    impl Drop for VideoFrames {
        fn drop(&mut self) {
            if let Ok(close) = function::<unsafe extern "C" fn(*mut c_void)>(b"zuna_media_frames_close") {
                unsafe { close(self.raw) };
            }
        }
    }
}
