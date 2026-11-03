//! The xdg portal asks the person what to share, and works the same on Wayland's
//! compositors and on X11. PipeWire then delivers the frames: as DMA-BUFs that stay on
//! the GPU when the encoder can take them, or in shared memory.

use std::{
    ffi::{c_char, c_int, c_void},
    os::fd::{AsRawFd, OwnedFd},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    PersistMode,
};

use super::{
    even, fitted,
    pipewire::{self, c_string, Api, CoreMethods, Opaque, PwBuffer, RegistryEvents, RegistryMethods, SpaHook, StreamEvents},
    pod::{self, Value},
    Options, Source,
};
use crate::{
    encoder::{self, Config, DmaBuf, Encoder, Input, Pixel, Result, Stream, INPUT_CPU, INPUT_DMABUF},
    pipeline::Pipeline,
};

// From spa/param/param.h, spa/param/format.h, spa/utils/type.h and spa/param/video/raw.h.
const PARAM_ENUM_FORMAT: u32 = 3;
const PARAM_FORMAT: u32 = 4;
const PARAM_BUFFERS: u32 = 5;
const OBJECT_FORMAT: u32 = 0x40003;
const OBJECT_PARAM_BUFFERS: u32 = 0x40004;
const FORMAT_MEDIA_TYPE: u32 = 1;
const FORMAT_MEDIA_SUBTYPE: u32 = 2;
const FORMAT_VIDEO_FORMAT: u32 = 0x20001;
const FORMAT_VIDEO_MODIFIER: u32 = 0x20002;
const FORMAT_VIDEO_SIZE: u32 = 0x20003;
const FORMAT_VIDEO_FRAMERATE: u32 = 0x20004;
const FORMAT_VIDEO_MAX_FRAMERATE: u32 = 0x20005;
const MEDIA_TYPE_VIDEO: u32 = 2;
const MEDIA_SUBTYPE_RAW: u32 = 1;
const BUFFERS_DATA_TYPE: u32 = 6;
const VIDEO_RGBX: u32 = 7;
const VIDEO_BGRX: u32 = 8;
const VIDEO_RGBA: u32 = 11;
const VIDEO_BGRA: u32 = 12;

const DRM_FORMAT_MOD_LINEAR: u64 = 0;

const fn fourcc(code: &[u8; 4]) -> u32 {
    (code[0] as u32) | (code[1] as u32) << 8 | (code[2] as u32) << 16 | (code[3] as u32) << 24
}

/// What each format is called elsewhere: this encoder's name, and DRM's.
fn describe_format(format: u32) -> Option<(Pixel, u32)> {
    Some(match format {
        VIDEO_BGRX => (Pixel::Bgrx, fourcc(b"XR24")),
        VIDEO_BGRA => (Pixel::Bgra, fourcc(b"AR24")),
        VIDEO_RGBX => (Pixel::Rgbx, fourcc(b"XB24")),
        VIDEO_RGBA => (Pixel::Rgba, fourcc(b"AB24")),
        _ => return None,
    })
}

const FORMATS: [u32; 4] = [VIDEO_BGRX, VIDEO_BGRA, VIDEO_RGBX, VIDEO_RGBA];

/// Shared memory with no modifiers, and DMA-BUFs with them, the first preferred.
fn format_param(format: u32, fps: u32, modifiers: &[u64]) -> Vec<u64> {
    let mut properties = vec![
        (FORMAT_MEDIA_TYPE, 0, Value::Id(MEDIA_TYPE_VIDEO)),
        (FORMAT_MEDIA_SUBTYPE, 0, Value::Id(MEDIA_SUBTYPE_RAW)),
        (FORMAT_VIDEO_FORMAT, 0, Value::Id(format)),
    ];
    if let Some(&preferred) = modifiers.first() {
        // Offering a modifier at all is what says DMA-BUFs are welcome. An enum's
        // first value is its default, and the rest are the choices.
        let choices = std::iter::once(preferred).chain(modifiers.iter().copied()).map(|modifier| Value::Long(modifier as i64));
        properties.push((
            FORMAT_VIDEO_MODIFIER,
            pod::PROP_MANDATORY | pod::PROP_DONT_FIXATE,
            Value::Choice(pod::CHOICE_ENUM, choices.collect()),
        ));
    }
    // No size, so the compositor sends its own. KWin offers any size from 200x200 to
    // 10000x10000 and scales to it, and PipeWire takes this side's default when the
    // range allows it, so a default here would squeeze every screen into that.
    // A framerate of nothing means as frames come, and the maximum is what the
    // compositor should keep to. KWin keeps to it with a timer, frames 27.0 ms apart
    // within 0.1 for 37 fps on 165 and 360 Hz screens, so it's the frame rate itself.
    // Asking for a quarter more, against compositors that might skip a frame coming
    // slightly early, made `encode_buffer` trim those 27 ms frames to 27 or 54 ms apart
    // for 30 fps, which whoever watched saw as a stutter. It still trims what comes early.
    let most = fps;
    properties.push((FORMAT_VIDEO_FRAMERATE, 0, Value::Fraction(0, 1)));
    properties.push((
        FORMAT_VIDEO_MAX_FRAMERATE,
        0,
        Value::Choice(pod::CHOICE_RANGE, vec![Value::Fraction(most, 1), Value::Fraction(1, 1), Value::Fraction(most, 1)]),
    ));
    pod::object(OBJECT_FORMAT, PARAM_ENUM_FORMAT, &properties)
}

#[derive(Clone, Copy, Debug)]
struct Negotiated {
    format: u32,
    width: u32,
    height: u32,
    modifier: Option<u64>,
}

/// What the encoder was opened for, so that another can be opened when the picture
/// changes size, as a window does.
struct Encoding {
    from: (u32, u32),
    stream: Stream,
    max_height: Option<u32>,
    codec: String,
    render_node: String,
}

/// Everything the callbacks touch. PipeWire holds the thread loop's lock around them,
/// and the other thread takes the same lock.
struct Shared {
    api: &'static Api,
    stream: *mut Opaque,
    node: u32,
    negotiated: Option<Negotiated>,
    encoding: Option<Encoding>,
    pipeline: *mut Pipeline,
    interval: Duration,
    failure: Option<String>,
    /// What was shared has gone, such as a window that closed.
    ended: bool,
}

unsafe extern "C" fn on_global_remove(data: *mut c_void, id: u32) {
    let shared = unsafe { &mut *(data as *mut Shared) };
    // The compositor takes its node away when what's shared goes. That's the same on
    // every compositor, where the stream itself only says it lost its link.
    if id == shared.node {
        shared.ended = true;
    }
}

static REGISTRY_EVENTS: RegistryEvents = RegistryEvents { version: 0, global: None, global_remove: Some(on_global_remove) };

unsafe extern "C" fn on_state_changed(data: *mut c_void, _old: c_int, state: c_int, error: *const c_char) {
    let shared = unsafe { &mut *(data as *mut Shared) };
    if state == pipewire::STATE_ERROR {
        let message = if error.is_null() { "unknown".into() } else { unsafe { std::ffi::CStr::from_ptr(error) }.to_string_lossy().into_owned() };
        shared.failure = Some(format!("PipeWire stream failed: {message}"));
    }
    log::debug!("stream state {state}");
}

unsafe extern "C" fn on_param_changed(data: *mut c_void, id: u32, param: *const c_void) {
    let shared = unsafe { &mut *(data as *mut Shared) };
    if id != PARAM_FORMAT || param.is_null() {
        return;
    }
    // The size in a POD's header says how much there is to read.
    let header = unsafe { std::slice::from_raw_parts(param as *const u8, 8) };
    let size = u32::from_ne_bytes(header[..4].try_into().unwrap()) as usize + 8;
    let bytes = unsafe { std::slice::from_raw_parts(param as *const u8, size) };

    let (Some(Value::Id(format)), Some(Value::Rectangle(width, height))) = (pod::find(bytes, FORMAT_VIDEO_FORMAT), pod::find(bytes, FORMAT_VIDEO_SIZE)) else {
        shared.failure = Some("PipeWire settled on a format this can't read".into());
        return;
    };
    let modifier = match pod::find(bytes, FORMAT_VIDEO_MODIFIER) {
        Some(Value::Long(modifier)) => Some(modifier as u64),
        _ => None,
    };
    shared.negotiated = Some(Negotiated { format, width, height, modifier });
    log::info!("negotiated format {format}, {width}x{height}, modifier {modifier:?}");

    let data_types = if modifier.is_some() { 1 << pipewire::DATA_DMA_BUF } else { (1 << pipewire::DATA_MEM_FD) | (1 << pipewire::DATA_MEM_PTR) };
    let buffers = pod::object(OBJECT_PARAM_BUFFERS, PARAM_BUFFERS, &[(BUFFERS_DATA_TYPE, 0, Value::Int(data_types))]);
    let mut params = [buffers.as_ptr() as *const c_void];
    unsafe { (shared.api.stream_update_params)(shared.stream, params.as_mut_ptr(), 1) };
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    let shared = unsafe { &mut *(data as *mut Shared) };
    // Only the newest matters, and older ones go back for the compositor to reuse.
    let mut newest: *mut PwBuffer = ptr::null_mut();
    loop {
        let next = unsafe { (shared.api.stream_dequeue_buffer)(shared.stream) };
        if next.is_null() {
            break;
        }
        if !newest.is_null() {
            unsafe { (shared.api.stream_queue_buffer)(shared.stream, newest) };
        }
        newest = next;
    }
    if newest.is_null() {
        return;
    }
    if let Err(message) = unsafe { encode_buffer(shared, newest) } {
        shared.failure = Some(message);
    }
    unsafe { (shared.api.stream_queue_buffer)(shared.stream, newest) };
}

unsafe fn encode_buffer(shared: &mut Shared, buffer: *mut PwBuffer) -> Result<()> {
    let (Some(negotiated), Some(pipeline)) = (shared.negotiated, unsafe { shared.pipeline.as_mut() }) else {
        return Ok(());
    };
    let spa = unsafe { &*(*buffer).buffer };
    if spa.n_datas == 0 {
        return Ok(());
    }
    let datas = unsafe { std::slice::from_raw_parts(spa.datas, spa.n_datas as usize) };
    let chunk = unsafe { &*datas[0].chunk };
    // An empty chunk is the compositor saying only the cursor moved, or nothing did.
    if chunk.flags & pipewire::CHUNK_FLAG_CORRUPTED != 0 || chunk.size == 0 {
        return Ok(());
    }

    // A window can change size, and PipeWire then settles on the new one. The encoder
    // starts again at that size, with a keyframe, keeping to the tallest that was asked.
    let size = (even(negotiated.width), even(negotiated.height));
    if let Some(encoding) = shared.encoding.as_mut().filter(|encoding| encoding.from != size) {
        let (width, height) = fitted(size, encoding.max_height);
        let stream = Stream { width, height, bitrate: pipeline.bitrate(), ..encoding.stream };
        let encoder = open_encoder_for(negotiated, &encoding.codec, &encoding.render_node, stream)?;
        pipeline.restart(encoder, width, height);
        encoding.from = size;
        log::info!("the picture is now {}x{}, encoded at {width}x{height}", size.0, size.1);
    }

    // Frames can come a little faster than the frame rate, so this trims those that are
    // well ahead of their turn. It can't wait for the turn, as the Windows capture does,
    // without holding on to the compositor's buffer.
    pipeline.note_arrival(None);
    if Instant::now() + shared.interval / 4 < pipeline.next_due() {
        pipeline.note_early();
        return Ok(());
    }

    match datas[0].data_type {
        pipewire::DATA_DMA_BUF => {
            let (_, drm_format) = describe_format(negotiated.format).ok_or("PipeWire settled on a format this can't encode")?;
            let mut dmabuf = DmaBuf { fourcc: drm_format, modifier: negotiated.modifier.unwrap_or(0), planes: datas.len().min(4) as c_int, ..DmaBuf::default() };
            for (plane, data) in datas.iter().take(4).enumerate() {
                let chunk = unsafe { &*data.chunk };
                dmabuf.fd[plane] = data.fd as c_int;
                dmabuf.offset[plane] = chunk.offset;
                dmabuf.pitch[plane] = chunk.stride as u32;
            }
            pipeline.on_frame(Input::DmaBuf(&dmabuf))
        }
        pipewire::DATA_MEM_FD | pipewire::DATA_MEM_PTR => {
            if datas[0].data.is_null() {
                return Err("PipeWire gave a buffer it hadn't mapped".into());
            }
            let row = negotiated.width as usize * 4;
            let stride = if chunk.stride > 0 { chunk.stride as usize } else { row };
            let offset = (chunk.offset % datas[0].maxsize.max(1)) as usize;
            let available = (datas[0].maxsize as usize).saturating_sub(offset);
            let needed = stride * negotiated.height as usize;
            if available < needed {
                return Err(format!("A frame needs {needed} bytes, and PipeWire's buffer holds {available}"));
            }
            let pixels = unsafe { std::slice::from_raw_parts((datas[0].data as *const u8).add(offset), needed) };
            pipeline.on_frame(Input::Cpu { data: pixels, stride })
        }
        other => Err(format!("PipeWire gave a buffer of type {other}")),
    }
}

static STREAM_EVENTS: StreamEvents = StreamEvents {
    version: 2,
    destroy: None,
    state_changed: Some(on_state_changed),
    control_info: None,
    io_changed: None,
    param_changed: Some(on_param_changed),
    add_buffer: None,
    remove_buffer: None,
    process: Some(on_process),
    drained: None,
    command: None,
    trigger_done: None,
};

// It's only function pointers, which is safe to share, though the compiler can't tell.
unsafe impl Sync for StreamEvents {}

/// NVENC when the NVIDIA driver is here, and otherwise VA-API.
fn choose_encoder(requested: &str) -> Result<String> {
    match requested {
        "auto" => {
            let nvidia = unsafe { libloading::Library::new("libnvidia-encode.so.1") }.is_ok();
            Ok(if nvidia { "h264_nvenc" } else { "h264_vaapi" }.to_owned())
        }
        "h264_nvenc" | "h264_vaapi" => Ok(requested.to_owned()),
        other => Err(format!("This proof of concept doesn't do {other} on Linux: use h264_nvenc or h264_vaapi")),
    }
}

/// VA-API maps linear DMA-BUFs straight onto its surfaces. NVENC takes whatever EGL can
/// import, which dmabuf_cuda.c copies into CUDA memory without leaving the GPU.
fn dmabuf_modifiers(codec: &str, render_node: &str, format: u32) -> Vec<u64> {
    if codec == "h264_vaapi" {
        return vec![DRM_FORMAT_MOD_LINEAR];
    }
    let Some((_, drm_format)) = describe_format(format) else { return Vec::new() };
    encoder::dmabuf_modifiers(render_node, drm_format).unwrap_or_else(|error| {
        log::warn!("Using shared memory, since DMA-BUFs can't reach NVENC: {error}");
        Vec::new()
    })
}

/// What the person picks in the portal's dialog, kept alive for as long as it's shared.
struct PortalShare {
    proxy: Screencast,
    session: ashpd::desktop::Session<Screencast>,
    remote: OwnedFd,
    node: u32,
    /// A screen or a window, which is all the portal says about it.
    kind: &'static str,
}

async fn ask_the_portal(show_cursor: bool, source: Source) -> ashpd::Result<PortalShare> {
    let proxy = Screencast::new().await?;
    let session = proxy.create_session(Default::default()).await?;
    let cursor = if show_cursor && proxy.available_cursor_modes().await?.contains(CursorMode::Embedded) { CursorMode::Embedded } else { CursorMode::Hidden };
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(cursor)
                .set_sources(match source {
                    Source::Any => SourceType::Monitor | SourceType::Window,
                    Source::Screen => SourceType::Monitor.into(),
                    Source::Window => SourceType::Window.into(),
                })
                .set_multiple(false)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await?;
    let response = proxy.start(&session, None, Default::default()).await?.response()?;
    let stream = response.streams().first().ok_or(ashpd::Error::NoResponse)?;
    let node = stream.pipe_wire_node_id();
    let kind = if stream.source_type() == Some(SourceType::Window) { "window" } else { "screen" };
    let remote = proxy.open_pipe_wire_remote(&session, Default::default()).await?;
    Ok(PortalShare { proxy, session, remote, node, kind })
}

pub fn list_monitors() {
    println!("{{\"type\":\"note\",\"message\":\"On Linux the portal's dialog asks what to share.\"}}");
}

/// Whether there's a portal to share through, and whether it shares screens and windows.
pub fn portal_sources(runtime: &tokio::runtime::Runtime) -> Result<()> {
    let available = runtime
        .block_on(async { Screencast::new().await?.available_source_types().await })
        .map_err(|error| format!("Asking the portal what it shares: {error}"))?;
    println!(
        "{{\"type\":\"portal\",\"screen\":{},\"window\":{}}}",
        available.contains(SourceType::Monitor),
        available.contains(SourceType::Window)
    );
    Ok(())
}

fn open_encoder_for(negotiated: Negotiated, codec: &str, render_node: &str, stream: Stream) -> Result<Encoder> {
    let (pixel, _) = describe_format(negotiated.format).ok_or("PipeWire settled on a format this can't encode")?;
    Encoder::open(&Config {
        codec,
        input: if negotiated.modifier.is_some() { INPUT_DMABUF } else { INPUT_CPU },
        pixel,
        source_width: even(negotiated.width),
        source_height: even(negotiated.height),
        stream,
        d3d11_device: ptr::null_mut(),
        render_node: Some(render_node),
    })
}

pub struct Capture {
    api: &'static Api,
    portal: PortalShare,
    thread_loop: *mut Opaque,
    context: *mut Opaque,
    core: *mut Opaque,
    stream: *mut Opaque,
    shared: Box<Shared>,
    _hook: Box<SpaHook>,
    _registry_hook: Box<SpaHook>,
    negotiated: Negotiated,
    codec: String,
    render_node: String,
    max_height: Option<u32>,
    pub description: String,
    /// `screen` or `window`.
    pub source: &'static str,
}

impl Capture {
    pub fn open(options: &Options, runtime: &tokio::runtime::Runtime) -> Result<Self> {
        let codec = choose_encoder(&options.encoder)?;
        let api = pipewire::load()?;
        let portal = runtime.block_on(ask_the_portal(options.cursor, options.source)).map_err(|error| format!("Asking the portal for the screen: {error}"))?;
        unsafe { (api.init)(ptr::null_mut(), ptr::null_mut()) };

        let name = c_string("zuna-capture");
        let thread_loop = unsafe { (api.thread_loop_new)(name.as_ptr(), ptr::null()) };
        if thread_loop.is_null() {
            return Err("Couldn't create PipeWire's thread".into());
        }
        let context = unsafe { (api.context_new)((api.thread_loop_get_loop)(thread_loop), ptr::null_mut(), 0) };
        if context.is_null() {
            return Err("Couldn't create PipeWire's context".into());
        }
        if unsafe { (api.thread_loop_start)(thread_loop) } < 0 {
            return Err("Couldn't start PipeWire's thread".into());
        }

        unsafe { (api.thread_loop_lock)(thread_loop) };
        let duplicate = portal.remote.try_clone().map_err(|error| format!("Copying PipeWire's connection: {error}"))?;
        let core = unsafe { (api.context_connect_fd)(context, duplicate.as_raw_fd(), ptr::null_mut(), 0) };
        // PipeWire owns the descriptor from here.
        std::mem::forget(duplicate);
        if core.is_null() {
            unsafe { (api.thread_loop_unlock)(thread_loop) };
            return Err("Couldn't connect to PipeWire".into());
        }

        let properties = c_string("media.type=Video media.category=Capture media.role=Screen");
        let stream = unsafe { (api.stream_new)(core, name.as_ptr(), (api.properties_new_string)(properties.as_ptr())) };
        if stream.is_null() {
            unsafe { (api.thread_loop_unlock)(thread_loop) };
            return Err("Couldn't create a PipeWire stream".into());
        }

        let mut shared = Box::new(Shared {
            api,
            stream,
            node: portal.node,
            negotiated: None,
            encoding: None,
            pipeline: ptr::null_mut(),
            interval: Duration::from_secs_f64(1.0 / options.fps as f64),
            failure: None,
            ended: false,
        });
        let mut hook = Box::new(SpaHook::zeroed());
        unsafe { (api.stream_add_listener)(stream, &mut *hook, &STREAM_EVENTS, &mut *shared as *mut Shared as *mut c_void) };

        let mut registry_hook = Box::new(SpaHook::zeroed());
        let registry = unsafe {
            let (methods, object) = pipewire::methods::<CoreMethods>(core);
            (methods.get_registry)(object, pipewire::VERSION_REGISTRY, 0)
        };
        if registry.is_null() {
            unsafe { (api.thread_loop_unlock)(thread_loop) };
            return Err("Couldn't ask PipeWire what there is".into());
        }
        unsafe {
            let (methods, object) = pipewire::methods::<RegistryMethods>(registry);
            (methods.add_listener)(object, &mut *registry_hook, &REGISTRY_EVENTS, &mut *shared as *mut Shared as *mut c_void);
        }

        // Best first: DMA-BUFs, then shared memory for a compositor that can't share those.
        let mut offers: Vec<Vec<u64>> = Vec::new();
        if !options.cpu_input {
            for format in FORMATS {
                let modifiers = dmabuf_modifiers(&codec, &options.render_node, format);
                if modifiers.is_empty() {
                    break;
                }
                offers.push(format_param(format, options.fps, &modifiers));
            }
        }
        offers.extend(FORMATS.iter().map(|&format| format_param(format, options.fps, &[])));
        let mut params: Vec<*const c_void> = offers.iter().map(|offer| offer.as_ptr() as *const c_void).collect();

        let connected = unsafe {
            (api.stream_connect)(
                stream,
                pipewire::DIRECTION_INPUT,
                portal.node,
                pipewire::STREAM_FLAG_AUTOCONNECT | pipewire::STREAM_FLAG_MAP_BUFFERS,
                params.as_mut_ptr(),
                params.len() as u32,
            )
        };
        unsafe { (api.thread_loop_unlock)(thread_loop) };
        if connected < 0 {
            return Err(format!("Couldn't connect the PipeWire stream: error {connected}"));
        }

        let deadline = Instant::now() + Duration::from_secs(10);
        let negotiated = loop {
            unsafe { (api.thread_loop_lock)(thread_loop) };
            let negotiated = shared.negotiated;
            let failure = shared.failure.take();
            unsafe { (api.thread_loop_unlock)(thread_loop) };
            if let Some(message) = failure {
                return Err(message);
            }
            if let Some(negotiated) = negotiated {
                break negotiated;
            }
            if Instant::now() > deadline {
                return Err("PipeWire didn't settle on a format within 10 seconds".into());
            }
            thread::sleep(Duration::from_millis(20));
        };

        let from = match negotiated.modifier {
            Some(modifier) => format!("DMA-BUF with modifier {modifier:#x}"),
            None => "shared memory".into(),
        };
        Ok(Self {
            api,
            description: format!("portal {} node {} at {}x{}, {codec} from {from}", portal.kind, portal.node, negotiated.width, negotiated.height),
            source: portal.kind,
            portal,
            thread_loop,
            context,
            core,
            stream,
            shared,
            _hook: hook,
            _registry_hook: registry_hook,
            negotiated,
            codec,
            render_node: options.render_node.clone(),
            max_height: options.max_height,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (even(self.negotiated.width), even(self.negotiated.height))
    }

    pub fn open_encoder(&mut self, stream: Stream) -> Result<Encoder> {
        let encoder = open_encoder_for(self.negotiated, &self.codec, &self.render_node, stream)?;
        let encoding = Encoding { from: self.size(), stream, max_height: self.max_height, codec: self.codec.clone(), render_node: self.render_node.clone() };
        unsafe { (self.api.thread_loop_lock)(self.thread_loop) };
        self.shared.encoding = Some(encoding);
        unsafe { (self.api.thread_loop_unlock)(self.thread_loop) };
        Ok(encoder)
    }

    pub fn run(&mut self, pipeline: &mut Pipeline, stop: &AtomicBool) -> Result<()> {
        let api = self.api;
        unsafe { (api.thread_loop_lock)(self.thread_loop) };
        self.shared.pipeline = pipeline;
        unsafe { (api.thread_loop_unlock)(self.thread_loop) };

        // Frames arrive on PipeWire's thread. This one covers what happens without them:
        // keyframes wanted on a still screen, and keeping the stream alive.
        let mut result = Ok(());
        while result.is_ok() && !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(2));
            unsafe { (api.thread_loop_lock)(self.thread_loop) };
            let ended = self.shared.ended;
            result = match self.shared.failure.take() {
                // Losing its node can fail the stream as well, which isn't worth telling anyone.
                _ if ended => Ok(()),
                Some(message) => Err(message),
                None => unsafe { &mut *self.shared.pipeline }.on_idle(),
            };
            unsafe { (api.thread_loop_unlock)(self.thread_loop) };
            if ended {
                log::info!("what was shared has gone");
                break;
            }
        }

        unsafe { (api.thread_loop_lock)(self.thread_loop) };
        self.shared.pipeline = ptr::null_mut();
        unsafe { (api.thread_loop_unlock)(self.thread_loop) };
        result
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let api = self.api;
        unsafe {
            (api.thread_loop_stop)(self.thread_loop);
            (api.stream_destroy)(self.stream);
            (api.core_disconnect)(self.core);
            (api.context_destroy)(self.context);
            (api.thread_loop_destroy)(self.thread_loop);
        }
        // Keeps these alive to here, since the portal ends the share when they go.
        let _ = (&self.portal.proxy, &self.portal.session);
    }
}
