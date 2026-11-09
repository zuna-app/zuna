//! Safe wrapper around native/encoder.c, which is a shared library loaded at runtime:
//! see encoder.h for why.

use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    ptr,
    sync::OnceLock,
};

use libloading::Library;

#[cfg(windows)]
pub const INPUT_D3D11: c_int = 0;
pub const INPUT_CPU: c_int = 1;
#[cfg(target_os = "linux")]
pub const INPUT_DMABUF: c_int = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pixel {
    Bgra = 0,
    #[cfg_attr(windows, allow(dead_code))]
    Rgba = 1,
    #[cfg_attr(windows, allow(dead_code))]
    Bgrx = 2,
    #[cfg_attr(windows, allow(dead_code))]
    Rgbx = 3,
}

/// How much work each frame gets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Quality {
    Speed = 0,
    #[default]
    Balanced = 1,
    Best = 2,
}

#[repr(C)]
struct RawConfig {
    codec: *const c_char,
    input: c_int,
    pixel: c_int,
    width: c_int,
    height: c_int,
    source_width: c_int,
    source_height: c_int,
    fps: c_int,
    gop: c_int,
    bitrate: i64,
    quality: c_int,
    d3d11_device: *mut c_void,
    render_node: *const c_char,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DmaBuf {
    pub fourcc: u32,
    pub modifier: u64,
    pub planes: c_int,
    pub fd: [c_int; 4],
    pub offset: [u32; 4],
    pub pitch: [u32; 4],
}

#[repr(C)]
struct RawEncoder {
    _private: [u8; 0],
}

struct Api {
    open: unsafe extern "C" fn(*const RawConfig, *mut *mut RawEncoder) -> c_int,
    close: unsafe extern "C" fn(*mut RawEncoder),
    send_d3d11: unsafe extern "C" fn(*mut RawEncoder, *mut c_void, c_int, c_int, i64, c_int) -> c_int,
    send_cpu: unsafe extern "C" fn(*mut RawEncoder, *const u8, c_int, i64, c_int) -> c_int,
    send_dmabuf: unsafe extern "C" fn(*mut RawEncoder, *const DmaBuf, i64, c_int) -> c_int,
    repeat: unsafe extern "C" fn(*mut RawEncoder, i64, c_int) -> c_int,
    receive: unsafe extern "C" fn(*mut RawEncoder, *mut *const u8, *mut c_int, *mut i64, *mut c_int) -> c_int,
    set_bitrate: unsafe extern "C" fn(*mut RawEncoder, i64) -> c_int,
    error: unsafe extern "C" fn(c_int, *mut c_char, c_int),
    #[cfg(target_os = "linux")]
    dmabuf_modifiers: unsafe extern "C" fn(*const c_char, u32, *mut u64, c_int) -> c_int,
    #[cfg(target_os = "linux")]
    dmabuf_check: unsafe extern "C" fn(*const c_char, *mut c_char, c_int) -> c_int,
}

#[cfg(windows)]
const LIBRARY: &str = "zuna_encoder.dll";
#[cfg(not(windows))]
const LIBRARY: &str = "libzuna_encoder.so";

/// FFmpeg's libraries are beside it, where Windows only looks when it's told to.
#[cfg(windows)]
fn open_library(path: &std::path::Path) -> std::result::Result<Library, libloading::Error> {
    use libloading::os::windows::{Library, LOAD_WITH_ALTERED_SEARCH_PATH};
    unsafe { Library::load_with_flags(path, LOAD_WITH_ALTERED_SEARCH_PATH) }.map(Into::into)
}

/// DEEPBIND has it look in its own FFmpeg first. Without that, libwebrtc's copy, linked
/// into the app, would win wherever the app exported it, and it's a different version.
#[cfg(target_os = "linux")]
fn open_library(path: &std::path::Path) -> std::result::Result<Library, libloading::Error> {
    let flags = libc::RTLD_NOW | libc::RTLD_LOCAL | libc::RTLD_DEEPBIND;
    unsafe { libloading::os::unix::Library::open(Some(path), flags) }.map(Library::from)
}

/// macOS has no encoder, as it doesn't capture screens natively.
#[cfg(target_os = "macos")]
fn open_library(path: &std::path::Path) -> std::result::Result<Library, libloading::Error> {
    unsafe { Library::new(path) }
}

/// Where the encoder is, with FFmpeg's libraries: in `lib` beside the app, where build.rs puts
/// them in a build, and where its packages carry them, or beside the folder above, as cargo's
/// examples and tests are in a folder below the app's.
fn library_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let beside = exe.parent()?.join("lib").join(LIBRARY);
    let above = exe.parent()?.parent().map(|dir| dir.join("lib").join(LIBRARY));
    Some(above.filter(|above| !beside.exists() && above.exists()).unwrap_or(beside))
}

fn load_api() -> Result<Api> {
    let path = library_path().ok_or("Couldn't find where the app is")?;
    let library = open_library(&path).map_err(|error| format!("Loading {}: {error}", path.display()))?;
    macro_rules! get {
        ($name:literal) => {
            *unsafe { library.get($name) }.map_err(|error| format!("{}: {error}", String::from_utf8_lossy($name)))?
        };
    }
    let api = Api {
        open: get!(b"zuna_encoder_open"),
        close: get!(b"zuna_encoder_close"),
        send_d3d11: get!(b"zuna_encoder_send_d3d11"),
        send_cpu: get!(b"zuna_encoder_send_cpu"),
        send_dmabuf: get!(b"zuna_encoder_send_dmabuf"),
        repeat: get!(b"zuna_encoder_repeat"),
        receive: get!(b"zuna_encoder_receive"),
        set_bitrate: get!(b"zuna_encoder_set_bitrate"),
        error: get!(b"zuna_encoder_error"),
        #[cfg(target_os = "linux")]
        dmabuf_modifiers: get!(b"zuna_dmabuf_modifiers"),
        #[cfg(target_os = "linux")]
        dmabuf_check: get!(b"zuna_dmabuf_check"),
    };
    // The function pointers above outlive this, so the library stays loaded for good.
    std::mem::forget(library);
    Ok(api)
}

fn api() -> Result<&'static Api> {
    static API: OnceLock<std::result::Result<Api, String>> = OnceLock::new();
    API.get_or_init(load_api).as_ref().map_err(Clone::clone)
}

pub type Result<T> = std::result::Result<T, String>;

fn check(api: &Api, code: c_int, doing: &str) -> Result<c_int> {
    if code >= 0 {
        return Ok(code);
    }
    let mut buffer = [0 as c_char; 256];
    unsafe { (api.error)(code, buffer.as_mut_ptr(), buffer.len() as c_int) };
    let message = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned();
    Err(format!("{doing}: {message}"))
}

/// The modifiers NVENC can take a DMA-BUF of this DRM format with, best first.
#[cfg(target_os = "linux")]
pub fn dmabuf_modifiers(render_node: &str, fourcc: u32) -> Result<Vec<u64>> {
    let api = api()?;
    let node = CString::new(render_node).unwrap();
    let mut modifiers = [0u64; 64];
    let code = unsafe { (api.dmabuf_modifiers)(node.as_ptr(), fourcc, modifiers.as_mut_ptr(), modifiers.len() as c_int) };
    let count = check(api, code, "Asking EGL which DMA-BUFs it can import")?;
    Ok(modifiers[..count as usize].to_vec())
}

/// Brings DMA-BUFs of every modifier into CUDA without a compositor, and says how
/// each went.
#[cfg(target_os = "linux")]
pub fn check_dmabuf(render_node: &str) -> Result<String> {
    let api = api()?;
    let node = CString::new(render_node).unwrap();
    let mut report = vec![0 as c_char; 8192];
    let code = unsafe { (api.dmabuf_check)(node.as_ptr(), report.as_mut_ptr(), report.len() as c_int) };
    let report = unsafe { CStr::from_ptr(report.as_ptr()) }.to_string_lossy().into_owned();
    check(api, code, &format!("{report}Bringing DMA-BUFs into CUDA")).map(|_| report)
}

/// What to make of the frames, whichever capture they come from.
#[derive(Clone, Copy, Debug)]
pub struct Stream {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub gop: u32,
    pub bitrate: u64,
    pub quality: Quality,
}

pub struct Config<'a> {
    pub codec: &'a str,
    pub input: c_int,
    pub pixel: Pixel,
    pub source_width: u32,
    pub source_height: u32,
    pub stream: Stream,
    pub d3d11_device: *mut c_void,
    pub render_node: Option<&'a str>,
}

/// A frame to encode, in whichever form the capture produced.
pub enum Input<'a> {
    #[cfg_attr(not(windows), allow(dead_code))]
    D3d11 { texture: *mut c_void, x: i32, y: i32 },
    Cpu { data: &'a [u8], stride: usize },
    #[cfg_attr(windows, allow(dead_code))]
    DmaBuf(&'a DmaBuf),
}

pub struct Packet<'a> {
    pub data: &'a [u8],
    pub pts: i64,
    pub key: bool,
}

pub struct Encoder {
    api: &'static Api,
    raw: *mut RawEncoder,
    pub codec: String,
}

impl Encoder {
    pub fn open(config: &Config) -> Result<Self> {
        let api = api()?;
        let stream = config.stream;
        let scaling = (stream.width, stream.height) != (config.source_width, config.source_height);
        if scaling && config.input == INPUT_CPU && config.codec != "h264_vaapi" {
            return Err("This encoder can only make the picture smaller on the GPU, and these frames are in CPU memory".into());
        }
        let codec = CString::new(config.codec).unwrap();
        let render_node = config.render_node.map(|node| CString::new(node).unwrap());
        let raw_config = RawConfig {
            codec: codec.as_ptr(),
            input: config.input,
            pixel: config.pixel as c_int,
            width: stream.width as c_int,
            height: stream.height as c_int,
            source_width: config.source_width as c_int,
            source_height: config.source_height as c_int,
            fps: stream.fps as c_int,
            gop: stream.gop as c_int,
            bitrate: stream.bitrate as i64,
            quality: stream.quality as c_int,
            d3d11_device: config.d3d11_device,
            render_node: render_node.as_ref().map_or(ptr::null(), |node| node.as_ptr()),
        };
        let mut raw = ptr::null_mut();
        check(api, unsafe { (api.open)(&raw_config, &mut raw) }, &format!("Opening {}", config.codec))?;
        Ok(Self { api, raw, codec: config.codec.to_owned() })
    }

    pub fn send(&mut self, input: Input, pts: i64, force_key: bool) -> Result<()> {
        let force_key = force_key as c_int;
        let code = unsafe {
            match input {
                Input::D3d11 { texture, x, y } => (self.api.send_d3d11)(self.raw, texture, x, y, pts, force_key),
                Input::Cpu { data, stride } => (self.api.send_cpu)(self.raw, data.as_ptr(), stride as c_int, pts, force_key),
                Input::DmaBuf(dmabuf) => (self.api.send_dmabuf)(self.raw, dmabuf, pts, force_key),
            }
        };
        check(self.api, code, "Encoding a frame").map(drop)
    }

    pub fn repeat(&mut self, pts: i64, force_key: bool) -> Result<()> {
        check(self.api, unsafe { (self.api.repeat)(self.raw, pts, force_key as c_int) }, "Repeating a frame").map(drop)
    }

    pub fn receive(&mut self) -> Result<Option<Packet<'_>>> {
        let (mut data, mut size, mut pts, mut key) = (ptr::null(), 0, 0, 0);
        let code = check(self.api, unsafe { (self.api.receive)(self.raw, &mut data, &mut size, &mut pts, &mut key) }, "Reading a packet")?;
        if code == 1 {
            return Ok(None);
        }
        Ok(Some(Packet { data: unsafe { std::slice::from_raw_parts(data, size as usize) }, pts, key: key != 0 }))
    }

    pub fn set_bitrate(&mut self, bitrate: u64) -> Result<()> {
        check(self.api, unsafe { (self.api.set_bitrate)(self.raw, bitrate as i64) }, "Changing the bitrate").map(drop)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { (self.api.close)(self.raw) };
    }
}
