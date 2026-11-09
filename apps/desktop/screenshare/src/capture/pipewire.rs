//! The parts of PipeWire this needs, loaded at runtime as libwebrtc does it. That means
//! no build dependency, and a clear message on a system without it. The layouts are
//! from spa/buffer/buffer.h, spa/utils/hook.h and pipewire/stream.h, and PipeWire keeps
//! them stable.

use std::ffi::{c_char, c_int, c_void, CString};

use libloading::Library;

pub const DIRECTION_INPUT: c_int = 0;
pub const STREAM_FLAG_AUTOCONNECT: c_int = 1 << 0;
pub const STREAM_FLAG_MAP_BUFFERS: c_int = 1 << 2;

pub const DATA_MEM_PTR: u32 = 1;
pub const DATA_MEM_FD: u32 = 2;
pub const DATA_DMA_BUF: u32 = 3;

pub const CHUNK_FLAG_CORRUPTED: i32 = 1;

pub const STATE_ERROR: c_int = -1;

#[repr(C)]
pub struct SpaChunk {
    pub offset: u32,
    pub size: u32,
    pub stride: i32,
    pub flags: i32,
}

#[repr(C)]
pub struct SpaData {
    pub data_type: u32,
    pub flags: u32,
    pub fd: i64,
    pub mapoffset: u32,
    pub maxsize: u32,
    pub data: *mut c_void,
    pub chunk: *mut SpaChunk,
}

#[repr(C)]
pub struct SpaBuffer {
    pub n_metas: u32,
    pub n_datas: u32,
    pub metas: *mut c_void,
    pub datas: *mut SpaData,
}

#[repr(C)]
pub struct PwBuffer {
    pub buffer: *mut SpaBuffer,
    pub user_data: *mut c_void,
    pub size: u64,
    pub requested: u64,
    pub time: u64,
}

/// `struct spa_hook`, which PipeWire writes to and this only has to hold.
#[repr(C)]
pub struct SpaHook {
    link: [*mut c_void; 2],
    funcs: *const c_void,
    data: *mut c_void,
    removed: *mut c_void,
    private: *mut c_void,
}

impl SpaHook {
    pub fn zeroed() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

type Callback = Option<unsafe extern "C" fn(*mut c_void)>;

#[repr(C)]
pub struct StreamEvents {
    pub version: u32,
    pub destroy: Callback,
    pub state_changed: Option<unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char)>,
    pub control_info: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    pub io_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void, u32)>,
    pub param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const c_void)>,
    pub add_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut PwBuffer)>,
    pub remove_buffer: Option<unsafe extern "C" fn(*mut c_void, *mut PwBuffer)>,
    pub process: Callback,
    pub drained: Callback,
    pub command: Option<unsafe extern "C" fn(*mut c_void, *const c_void)>,
    pub trigger_done: Callback,
}

/// `struct spa_dict_item` and `struct spa_dict`, which carry an object's properties.
#[repr(C)]
pub struct SpaDictItem {
    pub key: *const c_char,
    pub value: *const c_char,
}

#[repr(C)]
pub struct SpaDict {
    pub flags: u32,
    pub n_items: u32,
    pub items: *const SpaDictItem,
}

impl SpaDict {
    /// The value of one property, if it's there and is text.
    pub fn get(&self, key: &str) -> Option<String> {
        if self.items.is_null() {
            return None;
        }
        let items = unsafe { std::slice::from_raw_parts(self.items, self.n_items as usize) };
        items.iter().find_map(|item| {
            if item.key.is_null() || item.value.is_null() || unsafe { std::ffi::CStr::from_ptr(item.key) }.to_bytes() != key.as_bytes() {
                return None;
            }
            Some(unsafe { std::ffi::CStr::from_ptr(item.value) }.to_string_lossy().into_owned())
        })
    }
}

/// `struct spa_interface`. A core or registry starts with one, and its methods are only
/// reachable through it, since the headers call them from inline functions.
#[repr(C)]
pub struct SpaInterface {
    pub type_name: *const c_char,
    pub version: u32,
    pub funcs: *const c_void,
    pub data: *mut c_void,
}

/// `struct pw_core_methods`, from pipewire/core.h.
#[repr(C)]
pub struct CoreMethods {
    pub version: u32,
    pub add_listener: unsafe extern "C" fn(*mut c_void, *mut SpaHook, *const CoreEvents, *mut c_void) -> c_int,
    pub hello: *const c_void,
    pub sync: unsafe extern "C" fn(*mut c_void, u32, c_int) -> c_int,
    pub pong: *const c_void,
    pub error: *const c_void,
    pub get_registry: unsafe extern "C" fn(*mut c_void, u32, usize) -> *mut Opaque,
    pub create_object: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char, u32, *const SpaDict, usize) -> *mut Opaque,
    pub destroy: *const c_void,
}

/// `struct pw_core_events`, at version 0, which leaves out what this doesn't need.
#[repr(C)]
pub struct CoreEvents {
    pub version: u32,
    pub info: Callback,
    pub done: Option<unsafe extern "C" fn(*mut c_void, u32, c_int)>,
    pub ping: Callback,
    pub error: Option<unsafe extern "C" fn(*mut c_void, u32, c_int, c_int, *const c_char)>,
    pub remove_id: Callback,
    pub bound_id: Callback,
    pub add_mem: Callback,
    pub remove_mem: Callback,
}

#[repr(C)]
pub struct RegistryMethods {
    pub version: u32,
    pub add_listener: unsafe extern "C" fn(*mut c_void, *mut SpaHook, *const RegistryEvents, *mut c_void) -> c_int,
    pub bind: unsafe extern "C" fn(*mut c_void, u32, *const c_char, u32, usize) -> *mut Opaque,
    pub destroy: *const c_void,
}

#[repr(C)]
pub struct RegistryEvents {
    pub version: u32,
    pub global: Option<unsafe extern "C" fn(*mut c_void, u32, u32, *const c_char, u32, *const SpaDict)>,
    pub global_remove: Option<unsafe extern "C" fn(*mut c_void, u32)>,
}

/// The start of `struct pw_node_methods`, which is only ever read through a pointer.
#[repr(C)]
pub struct NodeMethods {
    pub version: u32,
    pub add_listener: unsafe extern "C" fn(*mut c_void, *mut SpaHook, *const NodeEvents, *mut c_void) -> c_int,
}

#[repr(C)]
pub struct NodeEvents {
    pub version: u32,
    pub info: Option<unsafe extern "C" fn(*mut c_void, *const NodeInfo)>,
    pub param: Callback,
}

/// `struct pw_node_info`. The registry only says a little about a node, and this has the rest.
#[repr(C)]
pub struct NodeInfo {
    pub id: u32,
    pub max_input_ports: u32,
    pub max_output_ports: u32,
    pub change_mask: u64,
    pub n_input_ports: u32,
    pub n_output_ports: u32,
    pub state: c_int,
    pub error: *const c_char,
    pub props: *const SpaDict,
    pub params: *const c_void,
    pub n_params: u32,
}

// Only function pointers, which are safe to share.
unsafe impl Sync for CoreEvents {}
unsafe impl Sync for RegistryEvents {}
unsafe impl Sync for NodeEvents {}

/// The method table behind an object's interface, and what to call it with.
pub unsafe fn methods<T>(object: *mut Opaque) -> (&'static T, *mut c_void) {
    let interface = unsafe { &*(object as *const SpaInterface) };
    (unsafe { &*(interface.funcs as *const T) }, interface.data)
}

pub const ID_CORE: u32 = 0;
pub const ID_ANY: u32 = 0xffff_ffff;
pub const VERSION_REGISTRY: u32 = 3;
pub const VERSION_LINK: u32 = 3;
pub const VERSION_NODE: u32 = 3;

const _: () = {
    assert!(size_of::<SpaChunk>() == 16);
    assert!(size_of::<SpaData>() == 40);
    assert!(size_of::<SpaBuffer>() == 24);
    assert!(size_of::<PwBuffer>() == 40);
    assert!(size_of::<SpaHook>() == 48);
    assert!(size_of::<StreamEvents>() == 96);
    assert!(size_of::<SpaDict>() == 16);
    assert!(size_of::<SpaInterface>() == 32);
    assert!(size_of::<CoreMethods>() == 72);
    assert!(size_of::<CoreEvents>() == 72);
    assert!(size_of::<RegistryMethods>() == 32);
    assert!(size_of::<RegistryEvents>() == 24);
    assert!(size_of::<NodeEvents>() == 24);
    assert!(size_of::<NodeInfo>() == 72);
    assert!(std::mem::offset_of!(NodeInfo, props) == 48);
};

pub enum Opaque {}

pub struct Api {
    pub init: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char),
    pub thread_loop_new: unsafe extern "C" fn(*const c_char, *const c_void) -> *mut Opaque,
    pub thread_loop_get_loop: unsafe extern "C" fn(*mut Opaque) -> *mut Opaque,
    pub thread_loop_start: unsafe extern "C" fn(*mut Opaque) -> c_int,
    pub thread_loop_stop: unsafe extern "C" fn(*mut Opaque),
    pub thread_loop_lock: unsafe extern "C" fn(*mut Opaque),
    pub thread_loop_unlock: unsafe extern "C" fn(*mut Opaque),
    pub thread_loop_destroy: unsafe extern "C" fn(*mut Opaque),
    pub context_new: unsafe extern "C" fn(*mut Opaque, *mut Opaque, usize) -> *mut Opaque,
    pub context_destroy: unsafe extern "C" fn(*mut Opaque),
    pub context_connect_fd: unsafe extern "C" fn(*mut Opaque, c_int, *mut Opaque, usize) -> *mut Opaque,
    pub context_connect: unsafe extern "C" fn(*mut Opaque, *mut Opaque, usize) -> *mut Opaque,
    pub core_disconnect: unsafe extern "C" fn(*mut Opaque) -> c_int,
    pub proxy_destroy: unsafe extern "C" fn(*mut Opaque),
    pub properties_new_string: unsafe extern "C" fn(*const c_char) -> *mut Opaque,
    pub stream_new: unsafe extern "C" fn(*mut Opaque, *const c_char, *mut Opaque) -> *mut Opaque,
    pub stream_destroy: unsafe extern "C" fn(*mut Opaque),
    pub stream_add_listener: unsafe extern "C" fn(*mut Opaque, *mut SpaHook, *const StreamEvents, *mut c_void),
    pub stream_connect: unsafe extern "C" fn(*mut Opaque, c_int, u32, c_int, *mut *const c_void, u32) -> c_int,
    pub stream_update_params: unsafe extern "C" fn(*mut Opaque, *mut *const c_void, u32) -> c_int,
    pub stream_dequeue_buffer: unsafe extern "C" fn(*mut Opaque) -> *mut PwBuffer,
    pub stream_queue_buffer: unsafe extern "C" fn(*mut Opaque, *mut PwBuffer) -> c_int,
}

/// PipeWire's functions, loaded the first time a share asks.
pub fn load() -> Result<&'static Api, String> {
    static API: std::sync::OnceLock<Result<Api, String>> = std::sync::OnceLock::new();
    API.get_or_init(load_api).as_ref().map_err(Clone::clone)
}

fn load_api() -> Result<Api, String> {
    let library = unsafe { Library::new("libpipewire-0.3.so.0") }.map_err(|error| format!("Loading PipeWire: {error}"))?;
    macro_rules! get {
        ($name:literal) => {
            *unsafe { library.get($name) }.map_err(|error| format!("{}: {error}", String::from_utf8_lossy($name)))?
        };
    }
    let api = Api {
        init: get!(b"pw_init"),
        thread_loop_new: get!(b"pw_thread_loop_new"),
        thread_loop_get_loop: get!(b"pw_thread_loop_get_loop"),
        thread_loop_start: get!(b"pw_thread_loop_start"),
        thread_loop_stop: get!(b"pw_thread_loop_stop"),
        thread_loop_lock: get!(b"pw_thread_loop_lock"),
        thread_loop_unlock: get!(b"pw_thread_loop_unlock"),
        thread_loop_destroy: get!(b"pw_thread_loop_destroy"),
        context_new: get!(b"pw_context_new"),
        context_destroy: get!(b"pw_context_destroy"),
        context_connect_fd: get!(b"pw_context_connect_fd"),
        context_connect: get!(b"pw_context_connect"),
        core_disconnect: get!(b"pw_core_disconnect"),
        proxy_destroy: get!(b"pw_proxy_destroy"),
        properties_new_string: get!(b"pw_properties_new_string"),
        stream_new: get!(b"pw_stream_new"),
        stream_destroy: get!(b"pw_stream_destroy"),
        stream_add_listener: get!(b"pw_stream_add_listener"),
        stream_connect: get!(b"pw_stream_connect"),
        stream_update_params: get!(b"pw_stream_update_params"),
        stream_dequeue_buffer: get!(b"pw_stream_dequeue_buffer"),
        stream_queue_buffer: get!(b"pw_stream_queue_buffer"),
    };
    // The function pointers outlive this, so the library stays loaded for good.
    std::mem::forget(library);
    Ok(api)
}

pub fn c_string(text: &str) -> CString {
    CString::new(text).expect("No NUL in this text")
}
