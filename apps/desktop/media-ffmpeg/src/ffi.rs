//! What the app calls, through C: each call that can fail says why in a string it frees with
//! `zuna_media_free_string`, and what's handed back in memory of its own is freed here too.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::PathBuf;

use crate::encode::{self, RoundWriter};
use crate::mf::{self, VideoFrames};

fn path(raw: *const c_char) -> PathBuf {
    // SAFETY: the app passes a string that lives for the call.
    PathBuf::from(unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned())
}

/// Hands a failure back, if there's somewhere to put it.
fn failed(error: *mut *mut c_char, text: String) -> bool {
    if !error.is_null() {
        // SAFETY: the app passes somewhere to put one pointer.
        unsafe { *error = CString::new(text.replace('\0', " ")).unwrap_or_default().into_raw() };
    }
    false
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_free_string(text: *mut c_char) {
    if !text.is_null() {
        // SAFETY: made by CString::into_raw here.
        drop(unsafe { CString::from_raw(text) });
    }
}

/// A file's length and picture size: each written where it's known, NaN or 0 where it isn't.
#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_details(file: *const c_char, duration: *mut f64, width: *mut u32, height: *mut u32) -> bool {
    let Some(found) = mf::details(&path(file)) else { return false };
    // SAFETY: the app passes somewhere to put each.
    unsafe {
        *duration = found.duration.unwrap_or(f64::NAN);
        *width = found.width.unwrap_or(0);
        *height = found.height.unwrap_or(0);
    }
    true
}

/// The sound in one channel, in memory freed with `zuna_media_free_samples`.
#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_decode_audio(file: *const c_char, samples: *mut *mut f32, count: *mut usize, rate: *mut u32, error: *mut *mut c_char) -> bool {
    match mf::decode_audio(&path(file)) {
        Ok((decoded, decoded_rate)) => {
            let boxed = decoded.into_boxed_slice();
            // SAFETY: the app passes somewhere to put each.
            unsafe {
                *count = boxed.len();
                *rate = decoded_rate;
                *samples = Box::into_raw(boxed) as *mut f32;
            }
            true
        }
        Err(text) => failed(error, text),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_free_samples(samples: *mut f32, count: usize) {
    if !samples.is_null() {
        // SAFETY: made from a boxed slice of this length here.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(samples, count)) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_write_voice(file: *const c_char, samples: *const i16, count: usize, error: *mut *mut c_char) -> bool {
    // SAFETY: the app passes this many samples, which live for the call.
    let samples = unsafe { std::slice::from_raw_parts(samples, count) };
    encode::write_voice(&path(file), samples).map_or_else(|text| failed(error, text), |()| true)
}

// --- A video message being written ---

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_round_create(file: *const c_char, error: *mut *mut c_char) -> *mut c_void {
    match RoundWriter::create(&path(file)) {
        Ok(writer) => Box::into_raw(Box::new(writer)) as *mut c_void,
        Err(text) => {
            failed(error, text);
            std::ptr::null_mut()
        }
    }
}

fn writer<'a>(raw: *mut c_void) -> &'a mut RoundWriter {
    // SAFETY: made by zuna_media_round_create, and used by one thread at a time.
    unsafe { &mut *(raw as *mut RoundWriter) }
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_round_frame(raw: *mut c_void, bgra: *const u8, length: usize, error: *mut *mut c_char) -> bool {
    // SAFETY: the app passes this many bytes, which live for the call.
    let bgra = unsafe { std::slice::from_raw_parts(bgra, length) };
    writer(raw).frame(bgra).map_or_else(|text| failed(error, text), |()| true)
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_round_sound(raw: *mut c_void, samples: *const i16, count: usize, error: *mut *mut c_char) -> bool {
    // SAFETY: the app passes this many samples, which live for the call.
    let samples = unsafe { std::slice::from_raw_parts(samples, count) };
    writer(raw).sound(samples).map_or_else(|text| failed(error, text), |()| true)
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_round_seconds(raw: *mut c_void) -> f64 {
    writer(raw).seconds()
}

/// Finishes the file and frees the writer, either way.
#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_round_finish(raw: *mut c_void, error: *mut *mut c_char) -> bool {
    // SAFETY: made by zuna_media_round_create, and not used again.
    let writer = unsafe { Box::from_raw(raw as *mut RoundWriter) };
    writer.finish().map_or_else(|text| failed(error, text), |()| true)
}

// --- A video's frames ---

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_frames_open(file: *const c_char, width: *mut u32, height: *mut u32, error: *mut *mut c_char) -> *mut c_void {
    match VideoFrames::open(&path(file)) {
        Ok(frames) => {
            // SAFETY: the app passes somewhere to put each.
            unsafe {
                *width = frames.width;
                *height = frames.height;
            }
            Box::into_raw(Box::new(frames)) as *mut c_void
        }
        Err(text) => {
            failed(error, text);
            std::ptr::null_mut()
        }
    }
}

fn frames<'a>(raw: *mut c_void) -> &'a mut VideoFrames {
    // SAFETY: made by zuna_media_frames_open, and used by one thread at a time.
    unsafe { &mut *(raw as *mut VideoFrames) }
}

/// The next frame: 1 with it, BGRA, freed with `zuna_media_free_bytes`, 0 at the end, -1 on failure.
#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_frames_next(raw: *mut c_void, at: *mut f64, bgra: *mut *mut u8, length: *mut usize, error: *mut *mut c_char) -> i32 {
    match frames(raw).next() {
        Ok(Some(frame)) => {
            let boxed = frame.bgra.into_boxed_slice();
            // SAFETY: the app passes somewhere to put each.
            unsafe {
                *at = frame.at;
                *length = boxed.len();
                *bgra = Box::into_raw(boxed) as *mut u8;
            }
            1
        }
        Ok(None) => 0,
        Err(text) => {
            failed(error, text);
            -1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_frames_seek(raw: *mut c_void, seconds: f64, error: *mut *mut c_char) -> bool {
    frames(raw).seek(seconds).map_or_else(|text| failed(error, text), |()| true)
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_frames_close(raw: *mut c_void) {
    if !raw.is_null() {
        // SAFETY: made by zuna_media_frames_open, and not used again.
        drop(unsafe { Box::from_raw(raw as *mut VideoFrames) });
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn zuna_media_free_bytes(bytes: *mut u8, length: usize) {
    if !bytes.is_null() {
        // SAFETY: made from a boxed slice of this length here.
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(bytes, length)) });
    }
}
