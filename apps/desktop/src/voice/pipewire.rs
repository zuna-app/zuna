//! The sound devices on Linux, through PipeWire itself: listed by the names it gives them, and
//! played and recorded through streams aimed at the one chosen. ALSA's own list, which cpal
//! reads, holds the cards themselves, and playing on one takes it away from PipeWire.
//! Streams are 32-bit floats, at 48 kHz but for a clip played at its own rate, which PipeWire
//! converts for the device.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use pipewire as pw;
use pw::properties::properties;
use pw::spa;

use super::audio::{Device, RATE};

unsafe extern "C" {
    /// libwebrtc, linked in for LiveKit, carries stand-ins for 37 of PipeWire's functions,
    /// weak symbols the linker takes over libpipewire's own, which call through pointers it
    /// only fills when it loads PipeWire itself. Until then calling `pw_init` jumps to null.
    #[link_name = "_ZN6webrtc18InitializePipeWireEv"]
    fn webrtc_initialize_pipewire() -> bool;
}

/// Loads PipeWire, through libwebrtc's stand-ins and for the rest of its functions, once.
/// False where there's no PipeWire to load, and then nothing here touches it.
fn init() -> bool {
    static LOADED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *LOADED.get_or_init(|| {
        // SAFETY: it loads libpipewire with dlopen and fills its own pointers, once.
        let loaded = unsafe { webrtc_initialize_pipewire() };
        if loaded {
            pw::init();
        } else {
            log::warn!("PipeWire isn't there to play or record through");
        }
        loaded
    })
}

/// The microphones or the speakers, by the names PipeWire gives them, with the default first.
pub fn devices(input: bool) -> Vec<Device> {
    let mut list = vec![Device { id: "default".into(), name: "Default".into() }];
    // A virtual microphone, such as a noise filter's, is one to choose too.
    let classes: &'static [&'static str] = if input { &["Audio/Source", "Audio/Source/Virtual"] } else { &["Audio/Sink"] };
    list.extend(nodes(classes).unwrap_or_default());
    list
}

/// Each node of these classes, by its name and its description.
fn nodes(classes: &'static [&'static str]) -> Result<Vec<Device>, pw::Error> {
    if !init() {
        return Ok(Vec::new());
    }
    let mainloop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_rc(None)?;
    let registry = core.get_registry_rc()?;
    let found: Rc<RefCell<Vec<Device>>> = Rc::default();
    let done = Rc::new(Cell::new(false));
    let pending = core.sync(0)?;
    let _core_listener = core
        .add_listener_local()
        .done({
            let done = done.clone();
            let mainloop = mainloop.clone();
            move |id, seq| {
                if id == pw::core::PW_ID_CORE && seq == pending {
                    done.set(true);
                    mainloop.quit();
                }
            }
        })
        .register();
    let _registry_listener = registry
        .add_listener_local()
        .global({
            let found = found.clone();
            move |global| {
                if global.type_ != pw::types::ObjectType::Node {
                    return;
                }
                let Some(props) = global.props else { return };
                if !props.get(*pw::keys::MEDIA_CLASS).is_some_and(|class| classes.contains(&class)) {
                    return;
                }
                let Some(name) = props.get(*pw::keys::NODE_NAME) else { return };
                let label = props.get(*pw::keys::NODE_DESCRIPTION).or(props.get(*pw::keys::NODE_NICK)).unwrap_or(name);
                found.borrow_mut().push(Device { id: name.to_string(), name: label.to_string() });
            }
        })
        .register();
    while !done.get() {
        mainloop.run();
    }
    Ok(found.take())
}

/// A stream playing or recording, on a thread of its own, until it's dropped.
pub struct Stream {
    quit: pw::channel::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.quit.send(()).ok();
        if let Some(thread) = self.thread.take() {
            thread.join().ok();
        }
    }
}

/// What's played, which the system's mixer shows and may treat apart.
#[derive(Clone, Copy)]
pub enum Playing {
    Voice,
    Notification,
    /// A voice message, a sound file or a video's sound.
    Media,
}

/// Plays stereo at a rate on a device, by its node's name, or the default one: `fill` is given
/// room for interleaved samples and how many frames that is. `failed` is set if the device goes.
pub fn play(device: &str, playing: Playing, rate: u32, fill: impl FnMut(&mut [f32], usize) + Send + 'static, failed: Arc<AtomicBool>) -> Option<Stream> {
    start(device, Some(playing), rate, Box::new(fill), Box::new(|_| {}), failed).ok()
}

/// Records one channel from a device, by its node's name, or the default one, handing what's
/// heard to `take`. `lost` is set if the device goes.
pub fn record(device: &str, take: impl FnMut(&[f32]) + Send + 'static, lost: Arc<AtomicBool>) -> Result<Stream, String> {
    start(device, None, RATE, Box::new(|_, _| {}), Box::new(take), lost)
}

type Fill = Box<dyn FnMut(&mut [f32], usize) + Send>;
type Take = Box<dyn FnMut(&[f32]) + Send>;

/// A stream playing `playing`, or recording without it.
fn start(device: &str, playing: Option<Playing>, rate: u32, fill: Fill, take: Take, failed: Arc<AtomicBool>) -> Result<Stream, String> {
    let (quit, quitting) = pw::channel::channel::<()>();
    let (ready, started) = std::sync::mpsc::channel::<Result<(), String>>();
    let device = device.to_string();
    let thread = std::thread::Builder::new()
        .name(if playing.is_some() { "zuna-sound-out" } else { "zuna-sound-in" }.into())
        .spawn(move || {
            if let Err(error) = run(&device, playing, rate, fill, take, failed, quitting, &ready) {
                ready.send(Err(error)).ok();
            }
        })
        .map_err(|error| error.to_string())?;
    started.recv().map_err(|error| error.to_string())??;
    Ok(Stream { quit, thread: Some(thread) })
}

/// The stream's thread: its main loop, until it's told to quit.
fn run(device: &str, playing: Option<Playing>, rate: u32, mut fill: Fill, mut take: Take, failed: Arc<AtomicBool>, quitting: pw::channel::Receiver<()>, ready: &std::sync::mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    if !init() {
        return Err("no PipeWire".into());
    }
    let fail = |error: pw::Error| error.to_string();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(fail)?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(fail)?;
    let core = context.connect_rc(None).map_err(fail)?;
    let output = playing.is_some();
    let channels: u32 = if output { 2 } else { 1 };
    let (name, role) = match playing {
        Some(Playing::Voice) => ("Zuna voice", "Communication"),
        Some(Playing::Notification) => ("Zuna notification", "Notification"),
        Some(Playing::Media) => ("Zuna media", "Music"),
        None => ("Zuna microphone", "Communication"),
    };
    let mut props = properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => if output { "Playback" } else { "Capture" },
        *pw::keys::MEDIA_ROLE => role,
        *pw::keys::APP_NAME => "Zuna",
        // 10 ms, which WebRTC's processing and RNNoise each take at a time.
        *pw::keys::NODE_LATENCY => format!("{}/{rate}", super::audio::FRAME),
    };
    // In a development build, a check's own devices in place of the system's defaults, so that
    // nothing it plays or records is the person's.
    let checks = if output { "ZUNA_CHECK_SPEAKERS" } else { "ZUNA_CHECK_MICROPHONE" };
    let device = match std::env::var(checks) {
        Ok(stand_in) if device == "default" && cfg!(debug_assertions) => stand_in,
        _ => device.to_string(),
    };
    if device != "default" {
        props.insert("target.object", device);
    }
    let stream = pw::stream::StreamBox::new(&core, name, props).map_err(fail)?;
    let _listener = stream
        .add_local_listener_with_user_data(())
        .state_changed({
            let failed = failed.clone();
            move |_, _, _, new| {
                if let pw::stream::StreamState::Error(error) = new {
                    log::warn!("a sound device stream failed: {error}");
                    failed.store(true, Ordering::Relaxed);
                }
            }
        })
        .process(move |stream, _| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let datas = buffer.datas_mut();
            let Some(data) = datas.first_mut() else { return };
            let stride = std::mem::size_of::<f32>() * channels as usize;
            if output {
                let Some(bytes) = data.data() else { return };
                let frames = bytes.len() / stride;
                // SAFETY: PipeWire maps the buffer aligned for the format asked for, F32LE.
                let samples = unsafe { std::slice::from_raw_parts_mut(bytes.as_mut_ptr() as *mut f32, frames * channels as usize) };
                fill(samples, frames);
                let chunk = data.chunk_mut();
                *chunk.offset_mut() = 0;
                *chunk.stride_mut() = stride as _;
                *chunk.size_mut() = (frames * stride) as _;
            } else {
                let size = data.chunk().size() as usize;
                let offset = data.chunk().offset() as usize;
                let Some(bytes) = data.data() else { return };
                let Some(heard) = bytes.get(offset..offset + size) else { return };
                // SAFETY: as above.
                let samples = unsafe { std::slice::from_raw_parts(heard.as_ptr() as *const f32, heard.len() / std::mem::size_of::<f32>()) };
                take(samples);
            }
        })
        .register()
        .map_err(fail)?;
    let mut format = spa::param::audio::AudioInfoRaw::new();
    format.set_format(spa::param::audio::AudioFormat::F32LE);
    format.set_rate(rate);
    format.set_channels(channels);
    let mut position = [0; spa::param::audio::MAX_CHANNELS];
    if output {
        position[0] = spa::sys::SPA_AUDIO_CHANNEL_FL;
        position[1] = spa::sys::SPA_AUDIO_CHANNEL_FR;
    } else {
        position[0] = spa::sys::SPA_AUDIO_CHANNEL_MONO;
    }
    format.set_position(position);
    let pod: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(spa::pod::Object { type_: spa::sys::SPA_TYPE_OBJECT_Format, id: spa::sys::SPA_PARAM_EnumFormat, properties: format.into() }),
    )
    .map_err(|error| format!("{error:?}"))?
    .0
    .into_inner();
    let mut params = [spa::pod::Pod::from_bytes(&pod).ok_or("the format")?];
    stream
        .connect(
            if output { spa::utils::Direction::Output } else { spa::utils::Direction::Input },
            None,
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS | pw::stream::StreamFlags::RT_PROCESS,
            &mut params,
        )
        .map_err(fail)?;
    let _quit = quitting.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |_| mainloop.quit()
    });
    ready.send(Ok(())).ok();
    mainloop.run();
    Ok(())
}
