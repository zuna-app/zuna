//! Whether this system's GStreamer, which WebKitGTK plays video through, can decode what YouTube
//! sends: VP9 or AV1 with Opus in WebM, or H.264 or AV1 with AAC in MP4, and somewhere to play its
//! sound, which WebKit looks for as `autoaudiosink`, a plugin as good as any. WebKit only tells YouTube
//! it plays what it finds decoders for, so where it finds none the player says only that the video
//! can't be played, and the app says instead what to install. Asked of GStreamer's own registry,
//! loaded as WebKitGTK loads it, by the caps each decoder or demuxer takes, as WebKit looks.

use std::ffi::{CString, c_char, c_int, c_void};
use std::ptr::null_mut;

use libloading::{Library, Symbol};

/// GstElementFactoryListType's decoders and demuxers, GstRank's marginal and GstPadDirection's sink.
const DECODER: u64 = 1 << 0;
const DEMUXER: u64 = 1 << 5;
const MARGINAL: c_int = 64;
const SINK: c_int = 2;

/// Whether there's a way to decode YouTube's video, and its sound, or nothing if GStreamer can't be asked.
pub fn check() -> Option<(bool, bool)> {
    // SAFETY: GStreamer's own functions, by their C signatures, on lists and caps they made, each
    // freed once. The library stays loaded, as GStreamer can't be unloaded once it's started.
    unsafe {
        let library = Library::new("libgstreamer-1.0.so.0").ok()?;
        let init: Symbol<unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char, *mut *mut c_void) -> c_int> = library.get(b"gst_init_check\0").ok()?;
        let elements: Symbol<unsafe extern "C" fn(u64, c_int) -> *mut c_void> = library.get(b"gst_element_factory_list_get_elements\0").ok()?;
        let filter: Symbol<unsafe extern "C" fn(*mut c_void, *const c_void, c_int, c_int) -> *mut c_void> = library.get(b"gst_element_factory_list_filter\0").ok()?;
        let caps_from: Symbol<unsafe extern "C" fn(*const c_char) -> *mut c_void> = library.get(b"gst_caps_from_string\0").ok()?;
        let unref: Symbol<unsafe extern "C" fn(*mut c_void)> = library.get(b"gst_mini_object_unref\0").ok()?;
        let free: Symbol<unsafe extern "C" fn(*mut c_void)> = library.get(b"gst_plugin_feature_list_free\0").ok()?;
        let find: Symbol<unsafe extern "C" fn(*const c_char) -> *mut c_void> = library.get(b"gst_element_factory_find\0").ok()?;
        let unref_object: Symbol<unsafe extern "C" fn(*mut c_void)> = library.get(b"gst_object_unref\0").ok()?;
        if init(null_mut(), null_mut(), null_mut()) == 0 {
            return None;
        }
        let decoders = elements(DECODER, MARGINAL);
        let demuxers = elements(DEMUXER, MARGINAL);
        let takes = |list: *mut c_void, caps: &str| {
            let Ok(caps) = CString::new(caps) else { return false };
            let caps = caps_from(caps.as_ptr());
            if caps.is_null() {
                return false;
            }
            let found = filter(list, caps, SINK, 0);
            let any = !found.is_null();
            free(found);
            unref(caps);
            any
        };
        let (webm, mp4) = (takes(demuxers, "video/webm"), takes(demuxers, "video/quicktime"));
        let (vp9, av1, h264) = (takes(decoders, "video/x-vp9"), takes(decoders, "video/x-av1"), takes(decoders, "video/x-h264"));
        let (opus, aac) = (takes(decoders, "audio/x-opus"), takes(decoders, "audio/mpeg, mpegversion=(int)4"));
        let sink = find(c"autoaudiosink".as_ptr());
        let speakers = !sink.is_null();
        if speakers {
            unref_object(sink);
        }
        free(decoders);
        free(demuxers);
        std::mem::forget(library);
        eprintln!("zuna-watch: GStreamer has WebM {webm}, MP4 {mp4}, VP9 {vp9}, AV1 {av1}, H.264 {h264}, Opus {opus}, AAC {aac}, a sound sink {speakers}");
        Some(((webm && (vp9 || av1)) || (mp4 && (h264 || av1)), speakers && ((webm && opus) || (mp4 && aac))))
    }
}
