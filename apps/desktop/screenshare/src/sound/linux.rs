//! The computer's sound on Linux, from PipeWire. PipeWire has no stream of everything but
//! one program, so this makes a stream of its own that nothing connects to, and links each
//! program's output into it, as programs come and go. What it gets is what leaves each
//! program, after the program's own volume and before the system's.

use std::{
    collections::HashMap,
    ffi::{c_char, c_int, c_void, CStr},
    ptr,
    sync::mpsc::{SyncSender, TrySendError},
    thread,
    time::{Duration, Instant},
};

use libloading::Library;

use super::{App, Source, WindowApp, Wanted, RATE};
use crate::{
    capture::{
        pipewire::{self, c_string, Api, CoreEvents, CoreMethods, NodeEvents, NodeInfo, NodeMethods, Opaque, PwBuffer, RegistryEvents, RegistryMethods, SpaDict, SpaDictItem, SpaHook, StreamEvents},
        pod::{self, Value},
    },
    encoder::Result,
};

// From spa/param/param.h, spa/param/format.h and spa/param/audio/raw.h.
const PARAM_ENUM_FORMAT: u32 = 3;
const OBJECT_FORMAT: u32 = 0x40003;
const FORMAT_MEDIA_TYPE: u32 = 1;
const FORMAT_MEDIA_SUBTYPE: u32 = 2;
const FORMAT_AUDIO_FORMAT: u32 = 0x10001;
const FORMAT_AUDIO_RATE: u32 = 0x10003;
const FORMAT_AUDIO_CHANNELS: u32 = 0x10004;
const FORMAT_AUDIO_POSITION: u32 = 0x10005;
const MEDIA_TYPE_AUDIO: u32 = 1;
const MEDIA_SUBTYPE_RAW: u32 = 1;
const AUDIO_F32: u32 = 0x11b;
const CHANNEL_FL: u32 = 3;
const CHANNEL_FR: u32 = 4;

/// Two 32-bit floats.
const FRAME_BYTES: usize = 8;

/// A stream that's playing, from one program.
struct Player {
    program: String,
    name: String,
    pid: Option<u32>,
    wanted: bool,
}

struct Port {
    node: u32,
    output: bool,
    channel: String,
}

/// Everything the callbacks touch. PipeWire holds the thread loop's lock around them,
/// and the other thread takes the same lock.
struct State {
    api: &'static Api,
    core: *mut Opaque,
    registry: *mut Opaque,
    stream: *mut Opaque,
    /// None when it's only listing who's playing.
    wanted: Option<Wanted>,
    /// The app's own process, whose sound and its children's is never taken.
    exclude: Option<u32>,
    own_name: String,
    own_node: Option<u32>,
    /// Streams that play, whose program the registry doesn't say, so each is asked.
    bound: HashMap<u32, (*mut Opaque, Box<SpaHook>)>,
    /// Each connection's process, for a stream that doesn't say its own.
    clients: HashMap<u32, u32>,
    players: HashMap<u32, Player>,
    ports: HashMap<u32, Port>,
    /// By output port and input port.
    links: HashMap<(u32, u32), *mut Opaque>,
    pending_sync: c_int,
    synced: bool,
    samples: Option<SyncSender<Vec<u8>>>,
    failure: Option<String>,
}

/// A process's parent, from /proc. Its name comes in brackets and can hold anything, so
/// this reads from the last bracket.
fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

/// Whether a process is this one or was started under it. Chromium plays sound from a
/// process of its own, under the app's.
fn descends(pid: u32, root: u32) -> bool {
    let mut at = pid;
    for _ in 0..64 {
        if at == root {
            return true;
        }
        match parent_of(at) {
            Some(parent) if parent > 1 => at = parent,
            _ => return false,
        }
    }
    false
}

/// The process that started a WebKit web process's sandbox, from the instance its stream names,
/// `webkit-<pid>-<n>`. In bubblewrap the web process says the pid it has in there, which means
/// nothing out here; the process that started it is the app's web view, such as zuna-watch.
fn sandboxed_by(instance: &str) -> Option<u32> {
    instance.strip_prefix("webkit-")?.split('-').next()?.parse().ok().filter(|pid| *pid > 1)
}

/// Whether a program's channel goes into one of this stream's two: a side to its own
/// side, the subwoofer's nowhere, and the rest to both.
fn feeds(channel: &str, into: &str) -> bool {
    let side = match channel.strip_prefix("AUX").and_then(|number| number.parse::<u32>().ok()) {
        Some(number) if number % 2 == 0 => "FL",
        Some(_) => "FR",
        None if channel.starts_with("LFE") => return false,
        None if channel.ends_with('L') => "FL",
        None if channel.ends_with('R') => "FR",
        None => return true,
    };
    side == into
}

impl State {
    fn add_node(&mut self, id: u32, props: &SpaDict) {
        if props.get("node.name").as_deref() == Some(self.own_name.as_str()) {
            self.own_node = Some(id);
            return;
        }
        if props.get("media.class").as_deref() != Some("Stream/Output/Audio") || self.bound.contains_key(&id) {
            return;
        }
        let interface = c_string("PipeWire:Interface:Node");
        let (methods, registry) = unsafe { pipewire::methods::<RegistryMethods>(self.registry) };
        let node = unsafe { (methods.bind)(registry, id, interface.as_ptr(), pipewire::VERSION_NODE, 0) };
        if node.is_null() {
            return;
        }
        let mut hook = Box::new(SpaHook::zeroed());
        let (methods, object) = unsafe { pipewire::methods::<NodeMethods>(node) };
        unsafe { (methods.add_listener)(object, &mut *hook, &NODE_EVENTS, self as *mut State as *mut c_void) };
        self.bound.insert(id, (node, hook));
    }

    /// A stream that plays, once PipeWire has said all about it.
    fn add_player(&mut self, id: u32, props: &SpaDict) {
        // A program that plays through PipeWire's PulseAudio server says which process it is.
        // One that connects itself might not, and then its connection says.
        let client = props.get("client.id").and_then(|text| text.parse::<u32>().ok()).and_then(|client| self.clients.get(&client).copied());
        let sandbox = props.get("pipewire.access.portal.instance_id").and_then(|instance| sandboxed_by(&instance));
        let pid = sandbox.or_else(|| props.get("application.process.id").and_then(|text| text.parse::<u32>().ok())).or(client);
        // Zuna's own sound is left out, but for its helpers' when they're what's wanted.
        let helpers = matches!(self.wanted, Some(Wanted::Helpers(_)));
        if let (Some(pid), Some(root)) = (pid, self.exclude) {
            if descends(pid, root) && !(helpers && pid != root) {
                return;
            }
        }
        let binary = props.get("application.process.binary");
        let app_name = props.get("application.name");
        let node_name = props.get("node.name");
        let Some(program) = binary.clone().or_else(|| app_name.clone()).or_else(|| node_name.clone()) else { return };
        let name = app_name.or(binary).or(node_name).unwrap_or_default();
        let wanted = match &self.wanted {
            Some(Wanted::Everything) => true,
            Some(Wanted::Program(wanted)) => *wanted == program,
            Some(Wanted::Tree(root)) => pid.is_some_and(|pid| descends(pid, *root)),
            Some(Wanted::Helpers(root)) => pid.is_some_and(|pid| pid != *root && descends(pid, *root)),
            None => false,
        };
        self.players.insert(id, Player { program, name, pid, wanted });
    }

    fn add_port(&mut self, id: u32, props: &SpaDict) {
        let Some(node) = props.get("node.id").and_then(|text| text.parse::<u32>().ok()) else { return };
        if props.get("port.monitor").as_deref() == Some("true") || props.get("format.dsp").is_some_and(|format| !format.contains("audio")) {
            return;
        }
        let Some(channel) = props.get("audio.channel").or_else(|| props.get("port.id").map(|id| format!("AUX{id}"))) else { return };
        let output = props.get("port.direction").as_deref() == Some("out");
        self.ports.insert(id, Port { node, output, channel });
    }

    /// Links every wanted program's output into this stream, where it isn't already.
    fn link_wanted(&mut self) {
        let Some(own) = self.own_node else { return };
        let inputs: Vec<(u32, &str)> = self.ports.iter().filter(|(_, port)| port.node == own && !port.output).map(|(&id, port)| (id, port.channel.as_str())).collect();
        let mut missing = Vec::new();
        for (&id, port) in &self.ports {
            if !port.output || !self.players.get(&port.node).is_some_and(|player| player.wanted) {
                continue;
            }
            for &(input, channel) in &inputs {
                if feeds(&port.channel, channel) && !self.links.contains_key(&(id, input)) {
                    missing.push((port.node, id, input));
                }
            }
        }
        for (node, output, input) in missing {
            let link = self.link(node, output, own, input);
            if !link.is_null() {
                self.links.insert((output, input), link);
            }
        }
    }

    /// A link this connection to PipeWire owns, so that it goes when the connection closes.
    fn link(&self, output_node: u32, output_port: u32, input_node: u32, input_port: u32) -> *mut Opaque {
        let pairs = [
            ("link.output.node", output_node.to_string()),
            ("link.output.port", output_port.to_string()),
            ("link.input.node", input_node.to_string()),
            ("link.input.port", input_port.to_string()),
            ("object.linger", "false".to_owned()),
        ]
        .map(|(key, value)| (c_string(key), c_string(&value)));
        let items: Vec<SpaDictItem> = pairs.iter().map(|(key, value)| SpaDictItem { key: key.as_ptr(), value: value.as_ptr() }).collect();
        let dict = SpaDict { flags: 0, n_items: items.len() as u32, items: items.as_ptr() };
        let factory = c_string("link-factory");
        let interface = c_string("PipeWire:Interface:Link");
        let (methods, object) = unsafe { pipewire::methods::<CoreMethods>(self.core) };
        unsafe { (methods.create_object)(object, factory.as_ptr(), interface.as_ptr(), pipewire::VERSION_LINK, &dict, 0) }
    }

    fn remove(&mut self, id: u32) {
        self.players.remove(&id);
        self.clients.remove(&id);
        if let Some((node, _hook)) = self.bound.remove(&id) {
            unsafe { (self.api.proxy_destroy)(node) };
        }
        if self.ports.remove(&id).is_some() {
            let gone: Vec<(u32, u32)> = self.links.keys().filter(|(output, input)| *output == id || *input == id).copied().collect();
            for key in gone {
                if let Some(link) = self.links.remove(&key) {
                    unsafe { (self.api.proxy_destroy)(link) };
                }
            }
        }
        if self.own_node == Some(id) {
            self.own_node = None;
            self.failure = Some("PipeWire took away the stream for the share's sound".into());
        }
    }
}

unsafe extern "C" fn on_global(data: *mut c_void, id: u32, _permissions: u32, type_name: *const c_char, _version: u32, props: *const SpaDict) {
    let state = unsafe { &mut *(data as *mut State) };
    if type_name.is_null() || props.is_null() {
        return;
    }
    let props = unsafe { &*props };
    match unsafe { CStr::from_ptr(type_name) }.to_bytes() {
        b"PipeWire:Interface:Node" => state.add_node(id, props),
        b"PipeWire:Interface:Port" => state.add_port(id, props),
        b"PipeWire:Interface:Client" => {
            if let Some(pid) = props.get("pipewire.sec.pid").and_then(|text| text.parse::<u32>().ok()) {
                state.clients.insert(id, pid);
            }
            return;
        }
        _ => return,
    }
    if state.wanted.is_some() {
        state.link_wanted();
    }
}

unsafe extern "C" fn on_node_info(data: *mut c_void, info: *const NodeInfo) {
    let state = unsafe { &mut *(data as *mut State) };
    let Some(info) = (unsafe { info.as_ref() }) else { return };
    let Some(props) = (unsafe { info.props.as_ref() }) else { return };
    state.add_player(info.id, props);
    if state.wanted.is_some() {
        state.link_wanted();
    }
}

unsafe extern "C" fn on_global_remove(data: *mut c_void, id: u32) {
    unsafe { &mut *(data as *mut State) }.remove(id);
}

unsafe extern "C" fn on_done(data: *mut c_void, id: u32, seq: c_int) {
    let state = unsafe { &mut *(data as *mut State) };
    if id == pipewire::ID_CORE && seq == state.pending_sync {
        state.synced = true;
    }
}

unsafe extern "C" fn on_error(data: *mut c_void, id: u32, _seq: c_int, res: c_int, message: *const c_char) {
    let state = unsafe { &mut *(data as *mut State) };
    let message = if message.is_null() { "unknown".into() } else { unsafe { CStr::from_ptr(message) }.to_string_lossy().into_owned() };
    // Something about one link is no reason to stop: the rest may be fine.
    if id == pipewire::ID_CORE {
        state.failure = Some(format!("PipeWire: {message}"));
    } else {
        log::warn!("PipeWire refused object {id}: {message} ({res})");
    }
}

unsafe extern "C" fn on_state_changed(data: *mut c_void, _old: c_int, state: c_int, error: *const c_char) {
    let shared = unsafe { &mut *(data as *mut State) };
    if state == pipewire::STATE_ERROR {
        let message = if error.is_null() { "unknown".into() } else { unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned() };
        shared.failure = Some(format!("PipeWire stream failed: {message}"));
    }
}

unsafe extern "C" fn on_process(data: *mut c_void) {
    let state = unsafe { &mut *(data as *mut State) };
    loop {
        let buffer: *mut PwBuffer = unsafe { (state.api.stream_dequeue_buffer)(state.stream) };
        if buffer.is_null() {
            break;
        }
        let spa = unsafe { &*(*buffer).buffer };
        if spa.n_datas > 0 {
            let first = unsafe { &*spa.datas };
            let chunk = unsafe { &*first.chunk };
            if !first.data.is_null() && chunk.size > 0 {
                let offset = (chunk.offset % first.maxsize.max(1)) as usize;
                let size = (chunk.size as usize).min((first.maxsize as usize).saturating_sub(offset)) / FRAME_BYTES * FRAME_BYTES;
                let bytes = unsafe { std::slice::from_raw_parts((first.data as *const u8).add(offset), size) };
                // An app that falls behind loses sound rather than holding up PipeWire.
                if let Some(Err(TrySendError::Disconnected(_))) = state.samples.as_ref().map(|samples| samples.try_send(bytes.to_vec())) {
                    state.samples = None;
                }
            }
        }
        unsafe { (state.api.stream_queue_buffer)(state.stream, buffer) };
    }
}

static CORE_EVENTS: CoreEvents = CoreEvents {
    version: 0,
    info: None,
    done: Some(on_done),
    ping: None,
    error: Some(on_error),
    remove_id: None,
    bound_id: None,
    add_mem: None,
    remove_mem: None,
};

static NODE_EVENTS: NodeEvents = NodeEvents { version: 0, info: Some(on_node_info), param: None };

static REGISTRY_EVENTS: RegistryEvents = RegistryEvents { version: 0, global: Some(on_global), global_remove: Some(on_global_remove) };

static STREAM_EVENTS: StreamEvents = StreamEvents {
    version: 2,
    destroy: None,
    state_changed: Some(on_state_changed),
    control_info: None,
    io_changed: None,
    param_changed: None,
    add_buffer: None,
    remove_buffer: None,
    process: Some(on_process),
    drained: None,
    command: None,
    trigger_done: None,
};

/// A connection to PipeWire that hears of everything there is, and of what comes and goes.
struct Watch {
    api: &'static Api,
    thread_loop: *mut Opaque,
    context: *mut Opaque,
    core: *mut Opaque,
    state: Box<State>,
    hooks: [Box<SpaHook>; 3],
}

impl Watch {
    fn open(wanted: Option<Wanted>, exclude: Option<u32>) -> Result<Self> {
        let api = pipewire::load()?;
        unsafe { (api.init)(ptr::null_mut(), ptr::null_mut()) };
        let name = c_string("zuna-sound");
        let thread_loop = unsafe { (api.thread_loop_new)(name.as_ptr(), ptr::null()) };
        if thread_loop.is_null() {
            return Err("Couldn't create PipeWire's thread".into());
        }
        let context = unsafe { (api.context_new)((api.thread_loop_get_loop)(thread_loop), ptr::null_mut(), 0) };
        if context.is_null() {
            unsafe { (api.thread_loop_destroy)(thread_loop) };
            return Err("Couldn't create PipeWire's context".into());
        }
        if unsafe { (api.thread_loop_start)(thread_loop) } < 0 {
            unsafe {
                (api.context_destroy)(context);
                (api.thread_loop_destroy)(thread_loop);
            }
            return Err("Couldn't start PipeWire's thread".into());
        }

        unsafe { (api.thread_loop_lock)(thread_loop) };
        let core = unsafe { (api.context_connect)(context, ptr::null_mut(), 0) };
        if core.is_null() {
            unsafe {
                (api.thread_loop_unlock)(thread_loop);
                (api.thread_loop_stop)(thread_loop);
                (api.context_destroy)(context);
                (api.thread_loop_destroy)(thread_loop);
            }
            return Err("Couldn't connect to PipeWire".into());
        }
        let mut watch = Self {
            api,
            thread_loop,
            context,
            core,
            state: Box::new(State {
                api,
                core,
                registry: ptr::null_mut(),
                stream: ptr::null_mut(),
                wanted,
                exclude,
                own_name: format!("zuna-screen-sound-{}", std::process::id()),
                own_node: None,
                bound: HashMap::new(),
                clients: HashMap::new(),
                players: HashMap::new(),
                ports: HashMap::new(),
                links: HashMap::new(),
                pending_sync: 0,
                synced: false,
                samples: None,
                failure: None,
            }),
            hooks: [Box::new(SpaHook::zeroed()), Box::new(SpaHook::zeroed()), Box::new(SpaHook::zeroed())],
        };
        let data = &mut *watch.state as *mut State as *mut c_void;
        unsafe {
            let (core_methods, core_object) = pipewire::methods::<CoreMethods>(core);
            (core_methods.add_listener)(core_object, &mut *watch.hooks[0], &CORE_EVENTS, data);
            let registry = (core_methods.get_registry)(core_object, pipewire::VERSION_REGISTRY, 0);
            if registry.is_null() {
                (api.thread_loop_unlock)(thread_loop);
                return Err("Couldn't ask PipeWire what there is".into());
            }
            watch.state.registry = registry;
            let (registry_methods, registry_object) = pipewire::methods::<RegistryMethods>(registry);
            (registry_methods.add_listener)(registry_object, &mut *watch.hooks[1], &REGISTRY_EVENTS, data);
            (api.thread_loop_unlock)(thread_loop);
        }
        Ok(watch)
    }

    /// Makes the stream that what's wanted is linked into. Nothing else connects to it,
    /// since it doesn't ask to be.
    fn open_stream(&mut self) -> Result<()> {
        let api = self.api;
        let properties = c_string(&format!(
            "media.type=Audio media.category=Capture media.role=Screen application.name=Zuna node.name={} node.description=\"Zuna screen share\"",
            self.state.own_name
        ));
        let format = pod::object(
            OBJECT_FORMAT,
            PARAM_ENUM_FORMAT,
            &[
                (FORMAT_MEDIA_TYPE, 0, Value::Id(MEDIA_TYPE_AUDIO)),
                (FORMAT_MEDIA_SUBTYPE, 0, Value::Id(MEDIA_SUBTYPE_RAW)),
                (FORMAT_AUDIO_FORMAT, 0, Value::Id(AUDIO_F32)),
                (FORMAT_AUDIO_RATE, 0, Value::Int(RATE as i32)),
                (FORMAT_AUDIO_CHANNELS, 0, Value::Int(2)),
                (FORMAT_AUDIO_POSITION, 0, Value::Array(vec![Value::Id(CHANNEL_FL), Value::Id(CHANNEL_FR)])),
            ],
        );
        let mut params = [format.as_ptr() as *const c_void];
        let name = c_string("Screen share sound");
        unsafe { (api.thread_loop_lock)(self.thread_loop) };
        let stream = unsafe { (api.stream_new)(self.core, name.as_ptr(), (api.properties_new_string)(properties.as_ptr())) };
        if stream.is_null() {
            unsafe { (api.thread_loop_unlock)(self.thread_loop) };
            return Err("Couldn't create a PipeWire stream".into());
        }
        self.state.stream = stream;
        let data = &mut *self.state as *mut State as *mut c_void;
        let connected = unsafe {
            (api.stream_add_listener)(stream, &mut *self.hooks[2], &STREAM_EVENTS, data);
            (api.stream_connect)(stream, pipewire::DIRECTION_INPUT, pipewire::ID_ANY, pipewire::STREAM_FLAG_MAP_BUFFERS, params.as_mut_ptr(), 1)
        };
        unsafe { (api.thread_loop_unlock)(self.thread_loop) };
        if connected < 0 {
            return Err(format!("Couldn't connect the PipeWire stream: error {connected}"));
        }
        Ok(())
    }

    /// Waits until PipeWire has said everything there is so far.
    fn sync(&mut self) -> Result<()> {
        let api = self.api;
        unsafe {
            (api.thread_loop_lock)(self.thread_loop);
            let (methods, object) = pipewire::methods::<CoreMethods>(self.core);
            self.state.synced = false;
            self.state.pending_sync = (methods.sync)(object, pipewire::ID_CORE, 0);
            (api.thread_loop_unlock)(self.thread_loop);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let (synced, failure) = self.locked(|state| (state.synced, state.failure.take()));
            if let Some(message) = failure {
                return Err(message);
            }
            if synced {
                return Ok(());
            }
            if Instant::now() > deadline {
                return Err("PipeWire didn't answer within 5 seconds".into());
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn locked<T>(&mut self, read: impl FnOnce(&mut State) -> T) -> T {
        unsafe { (self.api.thread_loop_lock)(self.thread_loop) };
        let value = read(&mut self.state);
        unsafe { (self.api.thread_loop_unlock)(self.thread_loop) };
        value
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let api = self.api;
        unsafe {
            (api.thread_loop_stop)(self.thread_loop);
            if !self.state.stream.is_null() {
                (api.stream_destroy)(self.state.stream);
            }
            // The links go with the connection.
            (api.core_disconnect)(self.core);
            (api.context_destroy)(self.context);
            (api.thread_loop_destroy)(self.thread_loop);
        }
    }
}

/// Everything there is now, and what each stream says about itself.
fn look(exclude: Option<u32>) -> Result<Watch> {
    let mut watch = Watch::open(None, exclude)?;
    // The first hears of each stream, and the second of what each says about itself.
    watch.sync()?;
    watch.sync()?;
    Ok(watch)
}

pub fn apps(exclude: Option<u32>) -> Result<Vec<App>> {
    Ok(look(exclude)?.locked(|state| state.players.values().map(|player| App { id: player.program.clone(), name: player.name.clone() }).collect()))
}

/// A window's process, which X11 keeps on the window. Wayland has nothing of the kind, and
/// the app only asks this when it runs on X11.
fn window_pid(window: u32) -> Option<u32> {
    #[repr(C)]
    struct AtomReply {
        response_type: u8,
        pad: u8,
        sequence: u16,
        length: u32,
        atom: u32,
    }
    type Connect = unsafe extern "C" fn(*const c_char, *mut c_int) -> *mut c_void;
    type HasError = unsafe extern "C" fn(*mut c_void) -> c_int;
    type InternAtom = unsafe extern "C" fn(*mut c_void, u8, u16, *const c_char) -> u32;
    type InternAtomReply = unsafe extern "C" fn(*mut c_void, u32, *mut *mut c_void) -> *mut AtomReply;
    type GetProperty = unsafe extern "C" fn(*mut c_void, u8, u32, u32, u32, u32, u32) -> u32;
    type GetPropertyReply = unsafe extern "C" fn(*mut c_void, u32, *mut *mut c_void) -> *mut c_void;
    type PropertyValue = unsafe extern "C" fn(*const c_void) -> *const c_void;
    type PropertyLength = unsafe extern "C" fn(*const c_void) -> c_int;
    type Disconnect = unsafe extern "C" fn(*mut c_void);
    const CARDINAL: u32 = 6;

    let library = unsafe { Library::new("libxcb.so.1") }.ok()?;
    unsafe {
        let connect: Connect = *library.get(b"xcb_connect").ok()?;
        let has_error: HasError = *library.get(b"xcb_connection_has_error").ok()?;
        let intern_atom: InternAtom = *library.get(b"xcb_intern_atom").ok()?;
        let intern_atom_reply: InternAtomReply = *library.get(b"xcb_intern_atom_reply").ok()?;
        let get_property: GetProperty = *library.get(b"xcb_get_property").ok()?;
        let get_property_reply: GetPropertyReply = *library.get(b"xcb_get_property_reply").ok()?;
        let property_value: PropertyValue = *library.get(b"xcb_get_property_value").ok()?;
        let property_length: PropertyLength = *library.get(b"xcb_get_property_value_length").ok()?;
        let disconnect: Disconnect = *library.get(b"xcb_disconnect").ok()?;

        let connection = connect(ptr::null(), ptr::null_mut());
        if connection.is_null() {
            return None;
        }
        let mut pid = None;
        if has_error(connection) == 0 {
            let name = b"_NET_WM_PID";
            let atom = intern_atom_reply(connection, intern_atom(connection, 1, name.len() as u16, name.as_ptr() as *const c_char), ptr::null_mut());
            if !atom.is_null() {
                let reply = get_property_reply(connection, get_property(connection, 0, window, (*atom).atom, CARDINAL, 0, 1), ptr::null_mut());
                if !reply.is_null() {
                    if property_length(reply) >= 4 {
                        pid = Some(*(property_value(reply) as *const u32)).filter(|&pid| pid > 0);
                    }
                    libc::free(reply);
                }
                libc::free(atom as *mut c_void);
            }
        }
        disconnect(connection);
        pid
    }
}

/// What a process is called: its program's file name.
fn process_name(pid: u32) -> Option<String> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
    let name = exe.as_ref().and_then(|path| path.file_name()).map(|name| name.to_string_lossy().into_owned());
    name.or_else(|| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|name| name.trim().to_owned()))
}

pub fn window_app(window: u64, exclude: Option<u32>) -> Result<Option<WindowApp>> {
    let Some(pid) = u32::try_from(window).ok().and_then(window_pid) else { return Ok(None) };
    if exclude.is_some_and(|root| descends(pid, root)) {
        return Ok(None);
    }
    let playing: Vec<(String, String)> = look(exclude)?.locked(|state| {
        state.players.values().filter(|player| player.pid.is_some_and(|player| descends(player, pid))).map(|player| (player.program.clone(), player.name.clone())).collect()
    });
    let mut covers: Vec<String> = playing.iter().map(|(program, _)| program.clone()).collect();
    covers.sort();
    covers.dedup();
    // An app that names itself, such as Firefox, rather than its program's file name.
    let named = playing.first().map(|(_, name)| name.clone()).filter(|name| playing.iter().all(|(_, other)| other == name));
    let Some(name) = named.or_else(|| process_name(pid)) else { return Ok(None) };
    Ok(Some(WindowApp { id: format!("pid:{pid}"), name, playing: !playing.is_empty(), covers }))
}

pub struct Capture(Watch);

impl Source for Capture {
    fn failure(&mut self) -> Option<String> {
        self.0.locked(|state| state.failure.take())
    }
}

pub fn open(wanted: Wanted, exclude: Option<u32>, samples: SyncSender<Vec<u8>>) -> Result<Capture> {
    let mut watch = Watch::open(Some(wanted), exclude)?;
    watch.locked(|state| state.samples = Some(samples));
    watch.open_stream()?;
    watch.sync()?;
    Ok(Capture(watch))
}

#[cfg(test)]
mod tests {
    use super::{feeds, sandboxed_by};

    #[test]
    fn a_webkit_sandbox_names_the_process_that_started_it() {
        assert_eq!(sandboxed_by("webkit-38779-4"), Some(38779));
        assert_eq!(sandboxed_by("webkit-1-4"), None);
        // A Flatpak app's own instance, which isn't WebKit's.
        assert_eq!(sandboxed_by("1462371892"), None);
        assert_eq!(sandboxed_by("webkit-x-4"), None);
    }

    #[test]
    fn each_side_goes_to_its_own_side() {
        assert!(feeds("FL", "FL") && !feeds("FL", "FR"));
        assert!(feeds("FR", "FR") && !feeds("FR", "FL"));
        assert!(feeds("RL", "FL") && feeds("SR", "FR"));
    }

    #[test]
    fn the_middle_goes_to_both_and_the_subwoofer_to_neither() {
        assert!(feeds("MONO", "FL") && feeds("MONO", "FR"));
        assert!(feeds("FC", "FL") && feeds("FC", "FR"));
        assert!(!feeds("LFE", "FL") && !feeds("LFE", "FR"));
    }

    #[test]
    fn channels_without_a_place_alternate() {
        assert!(feeds("AUX0", "FL") && !feeds("AUX0", "FR"));
        assert!(feeds("AUX1", "FR") && !feeds("AUX1", "FL"));
    }
}
