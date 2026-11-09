//! Windows.Graphics.Capture hands over a D3D11 texture for each frame, and the copy
//! into the encoder's texture happens on the GPU, so no pixel touches the CPU. It
//! captures a monitor, or one window by its HWND.

use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use windows::{
    core::{factory, Interface, BOOL},
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D, D3D11_BOX, D3D11_CPU_ACCESS_READ,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
                D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
            },
            Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1, DXGI_ADAPTER_DESC1},
            Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
            Gdi::{EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HDC, HMONITOR, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL},
        },
        System::{
            Threading::{CreateEventW, SetEvent, WaitForSingleObject},
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
                RoInitialize, RO_INIT_MULTITHREADED,
            },
        },
        UI::WindowsAndMessaging::{GetWindowTextW, IsWindow},
    },
};

use super::{even, family, fitted, Codec, Options};
use crate::{
    encoder::{Config, Encoder, Input, Pixel, Result, Stream, INPUT_CPU, INPUT_D3D11},
    pipeline::Pipeline,
};

const VENDOR_NVIDIA: u32 = 0x10de;
const VENDOR_AMD: u32 = 0x1002;

const FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const POOL_FRAMES: i32 = 3;

fn error(doing: &str) -> impl Fn(windows::core::Error) -> String + '_ {
    move |error| format!("{doing}: {error}")
}

struct Monitor {
    handle: HMONITOR,
    name: String,
}

fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn add(handle: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<Monitor>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo) }.as_bool() {
            let end = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
            list.push(Monitor { handle, name: String::from_utf16_lossy(&info.szDevice[..end]) });
        }
        true.into()
    }
    let mut list = Vec::new();
    let _ = unsafe { EnumDisplayMonitors(None, None, Some(add), LPARAM(&mut list as *mut _ as isize)) };
    list
}

fn adapters() -> Result<Vec<(IDXGIAdapter1, DXGI_ADAPTER_DESC1)>> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(error("Listing GPUs"))?;
    let mut list = Vec::new();
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            list.push((adapter, desc));
        }
    }
    Ok(list)
}

fn drives_monitor(adapter: &IDXGIAdapter1, monitor: HMONITOR) -> bool {
    let mut index = 0;
    while let Ok(output) = unsafe { adapter.EnumOutputs(index) } {
        index += 1;
        if unsafe { output.GetDesc() }.is_ok_and(|desc| desc.Monitor == monitor) {
            return true;
        }
    }
    false
}

fn adapter_name(desc: &DXGI_ADAPTER_DESC1) -> String {
    let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
    String::from_utf16_lossy(&desc.Description[..end])
}

/// Picks the GPU and its encoder for the codec: the one asked for, or the one driving the monitor.
fn choose_adapter(encoder: &str, codec: Codec, monitor: HMONITOR) -> Result<(IDXGIAdapter1, String, String)> {
    let list = adapters()?;
    let family = family(encoder);
    let wanted_vendor = match family {
        "auto" | "mf" => None,
        "nvenc" => Some(VENDOR_NVIDIA),
        "amf" => Some(VENDOR_AMD),
        other => return Err(format!("There's no {other} on Windows: use nvenc, amf or mf")),
    };
    let (adapter, desc) = list
        .iter()
        .find(|(adapter, desc)| wanted_vendor.map_or_else(|| drives_monitor(adapter, monitor), |vendor| desc.VendorId == vendor))
        .ok_or_else(|| format!("No GPU found for {encoder}"))?;
    let family = match (family, desc.VendorId) {
        ("mf", _) => "mf",
        (_, VENDOR_NVIDIA) => "nvenc",
        (_, VENDOR_AMD) => "amf",
        // Intel's, and any other GPU's, through the encoder its driver gives Media Foundation.
        _ => "mf",
    };
    Ok((adapter.clone(), codec.encoder(family), adapter_name(desc)))
}

fn window_title(window: HWND) -> String {
    let mut title = [0u16; 256];
    let length = unsafe { GetWindowTextW(window, &mut title) }.max(0) as usize;
    String::from_utf16_lossy(&title[..length])
}

pub struct Capture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt_device: IDirect3DDevice,
    /// Kept for as long as it's captured, since that's what says when it closes.
    _item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    pool_size: SizeInt32,
    session: GraphicsCaptureSession,
    frame_arrived: HANDLE,
    /// What was shared has gone: a window that closed, or a monitor unplugged.
    ended: Arc<AtomicBool>,
    /// The window shared, as a number, since the item doesn't say when one closes to a thread
    /// without a dispatcher queue, as the share's is.
    window: Option<isize>,
    /// What's taken from each frame, before it's made smaller.
    width: u32,
    height: u32,
    max_height: Option<u32>,
    /// What the encoder was opened for, so that another can be opened when the picture changes size.
    stream: Option<Stream>,
    cpu_input: bool,
    staging: Option<ID3D11Texture2D>,
    codec: String,
    pub description: String,
    /// `screen` or `window`.
    pub source: &'static str,
}

impl Capture {
    pub fn open(options: &Options) -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(error("Starting WinRT"))?;

        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(error("Starting capture"))?;
        let (item, monitor, name, source): (GraphicsCaptureItem, _, _, _) = match options.window {
            Some(window) => {
                let window = HWND(window as usize as *mut c_void);
                if !unsafe { IsWindow(Some(window)) }.as_bool() {
                    return Err("The window has closed".into());
                }
                let item = unsafe { interop.CreateForWindow(window) }.map_err(error("Capturing the window"))?;
                // The GPU goes with the monitor it's mostly on, as a screen's does.
                (item, unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) }, format!("window {:?}", window_title(window)), "window")
            }
            None => {
                let all = monitors();
                let monitor = match options.monitor_at {
                    Some((x, y)) => unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL) },
                    None => all.first().ok_or("There's no monitor")?.handle,
                };
                let name = all.iter().find(|m| m.handle == monitor).map_or("unknown monitor".to_owned(), |m| m.name.clone());
                (unsafe { interop.CreateForMonitor(monitor) }.map_err(error("Capturing the monitor"))?, monitor, name, "screen")
            }
        };

        let (adapter, codec, gpu) = choose_adapter(&options.encoder, options.codec, monitor)?;

        let (mut device, mut context) = (None, None);
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(error("Creating the D3D11 device"))?;
        let device: ID3D11Device = device.unwrap();
        let context: ID3D11DeviceContext = context.unwrap();
        // The capture's thread and the encoder both use this device.
        let protected: ID3D11Multithread = device.cast().map_err(error("Protecting the device"))?;
        let _ = unsafe { protected.SetMultithreadProtected(true) };

        let dxgi: IDXGIDevice = device.cast().map_err(error("Reading the DXGI device"))?;
        let winrt_device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .map_err(error("Wrapping the device"))?
            .cast()
            .map_err(error("Wrapping the device"))?;

        let size = item.Size().map_err(error("Reading the size of what's shared"))?;
        // Room for a window to grow to its screen's size without a new pool.
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        let screen = if unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() { info.monitorInfo.rcMonitor } else { RECT::default() };
        let pool_size = SizeInt32 { Width: size.Width.max(screen.right - screen.left), Height: size.Height.max(screen.bottom - screen.top) };

        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, FORMAT, POOL_FRAMES, pool_size).map_err(error("Creating the frame pool"))?;
        let frame_arrived = unsafe { CreateEventW(None, false, false, None) }.map_err(error("Creating an event"))?;
        let signal = frame_arrived.0 as isize;
        pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
            unsafe { SetEvent(HANDLE(signal as *mut c_void)) }?;
            Ok(())
        }))
        .map_err(error("Listening for frames"))?;
        let ended = Arc::new(AtomicBool::new(false));
        {
            let ended = ended.clone();
            item.Closed(&TypedEventHandler::new(move |_, _| {
                ended.store(true, Ordering::Relaxed);
                unsafe { SetEvent(HANDLE(signal as *mut c_void)) }?;
                Ok(())
            }))
            .map_err(error("Listening for what's shared to close"))?;
        }

        let session = pool.CreateCaptureSession(&item).map_err(error("Creating the session"))?;
        let _ = session.SetIsCursorCaptureEnabled(options.cursor);
        // None of these are on every version of Windows, and none is worth stopping for.
        let _ = session.SetIsBorderRequired(false);
        // A window's menus and popups, as it shows them, from Windows 11 24H2.
        let _ = session.SetIncludeSecondaryWindows(true);
        // Half the frame's interval, because Windows drops a frame that comes even a little
        // inside this. At the screen's own refresh rate that's about every other one, and
        // `run` already keeps to the frame rate.
        let _ = session.SetMinUpdateInterval(TimeSpan { Duration: 10_000_000 / (options.fps as i64 * 2) });
        session.StartCapture().map_err(error("Starting the capture"))?;

        let input = if options.cpu_input { "CPU memory" } else { "GPU textures" };
        Ok(Self {
            device,
            context,
            winrt_device,
            _item: item,
            pool,
            pool_size,
            session,
            frame_arrived,
            ended,
            window: options.window.map(|window| window as isize),
            width: even(size.Width.max(0) as u32),
            height: even(size.Height.max(0) as u32),
            max_height: options.max_height,
            stream: None,
            cpu_input: options.cpu_input,
            staging: None,
            description: format!("{name} at {}x{} on {gpu}, {codec} from {input}", size.Width, size.Height),
            codec,
            source,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn open_encoder(&mut self, stream: Stream) -> Result<Encoder> {
        self.stream = Some(stream);
        Encoder::open(&Config {
            codec: &self.codec,
            input: if self.cpu_input { INPUT_CPU } else { INPUT_D3D11 },
            pixel: Pixel::Bgra,
            source_width: self.width,
            source_height: self.height,
            stream,
            d3d11_device: self.device.as_raw(),
            render_node: None,
        })
    }

    fn newest_frame(&self, pipeline: &mut Pipeline) -> Option<Direct3D11CaptureFrame> {
        let mut newest = None;
        // A frame goes back to the pool when dropped, freeing a slot for the next.
        while let Ok(frame) = self.pool.TryGetNextFrame() {
            // When Windows made it, on a clock of its own, rather than when it's read here.
            let made = frame.SystemRelativeTime().ok().map(|time| Duration::from_nanos(time.Duration.max(0) as u64 * 100));
            pipeline.note_arrival(made);
            newest = Some(frame);
        }
        newest
    }

    pub fn run(&mut self, pipeline: &mut Pipeline, stop: &AtomicBool) -> Result<()> {
        while !stop.load(Ordering::Relaxed) {
            let wait = pipeline.idle_wait().as_millis().max(1) as u32;
            let _ = unsafe { WaitForSingleObject(self.frame_arrived, wait) };
            let closed = self.window.is_some_and(|window| !unsafe { IsWindow(Some(HWND(window as *mut c_void))) }.as_bool());
            if closed || self.ended.load(Ordering::Relaxed) {
                log::info!("what was shared has gone");
                break;
            }

            let Some(mut frame) = self.newest_frame(pipeline) else {
                pipeline.on_idle()?;
                continue;
            };
            // Monitors can refresh faster than the stream's frame rate, so wait for
            // the frame's turn and take whatever is newest by then.
            let due = pipeline.next_due();
            let now = Instant::now();
            if due > now {
                thread::sleep(due - now);
                if let Some(newer) = self.newest_frame(pipeline) {
                    frame = newer;
                }
            }
            self.encode(&frame, pipeline)?;
        }
        Ok(())
    }

    fn encode(&mut self, frame: &Direct3D11CaptureFrame, pipeline: &mut Pipeline) -> Result<()> {
        let content = frame.ContentSize().map_err(error("Reading the frame's size"))?;
        // A window that's been made as small as it goes has nothing to show.
        if content.Width < 2 || content.Height < 2 {
            return Ok(());
        }
        // A frame fills its pool's textures from the top left, so a pool larger than what's shared
        // takes any size up to its own. Only one that's grown past that needs a new pool, which
        // makes frames at the new size from the next one, as this only has what fitted.
        if content.Width > self.pool_size.Width || content.Height > self.pool_size.Height {
            let size = SizeInt32 { Width: content.Width.max(self.pool_size.Width), Height: content.Height.max(self.pool_size.Height) };
            self.pool.Recreate(&self.winrt_device, FORMAT, POOL_FRAMES, size).map_err(error("Following the new size"))?;
            self.pool_size = size;
            return Ok(());
        }
        // As even as H.264 needs.
        let size = (even(content.Width as u32), even(content.Height as u32));
        if size != (self.width, self.height) {
            self.follow_size(size, pipeline)?;
        }
        let surface = frame.Surface().map_err(error("Reading the frame"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(error("Reading the frame"))?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(error("Reading the frame"))?;

        if !self.cpu_input {
            return pipeline.on_frame(Input::D3d11 { texture: texture.as_raw(), x: 0, y: 0 });
        }
        self.encode_from_cpu(&texture, pipeline)
    }

    /// Goes on at another size, with an encoder opened for it, keeping to the tallest that was
    /// asked. Its first frame is a keyframe, so someone watching sees the new size at once.
    fn follow_size(&mut self, (width, height): (u32, u32), pipeline: &mut Pipeline) -> Result<()> {
        let stream = self.stream.ok_or("The encoder hasn't been opened")?;
        (self.width, self.height) = (width, height);
        self.staging = None;
        let (encode_width, encode_height) = fitted((width, height), self.max_height);
        let encoder = self.open_encoder(Stream { width: encode_width, height: encode_height, bitrate: pipeline.bitrate(), ..stream })?;
        pipeline.restart(encoder, encode_width, encode_height);
        log::info!("the picture is now {width}x{height}, encoded at {encode_width}x{encode_height}");
        Ok(())
    }

    /// The route Linux takes with NVENC, kept here so that it can be run on Windows.
    fn encode_from_cpu(&mut self, texture: &ID3D11Texture2D, pipeline: &mut Pipeline) -> Result<()> {
        if self.staging.is_none() {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: self.width,
                Height: self.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging = None;
            unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(error("Creating a staging texture"))?;
            self.staging = staging;
        }
        let staging = self.staging.as_ref().unwrap();
        let region = D3D11_BOX { left: 0, top: 0, front: 0, right: self.width, bottom: self.height, back: 1 };
        unsafe { self.context.CopySubresourceRegion(staging, 0, 0, 0, 0, texture, 0, Some(&region)) };

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { self.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.map_err(error("Reading the frame back"))?;
        let stride = mapped.RowPitch as usize;
        let data = unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, stride * self.height as usize) };
        let result = pipeline.on_frame(Input::Cpu { data, stride });
        unsafe { self.context.Unmap(staging, 0) };
        result
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
        let _ = unsafe { CloseHandle(self.frame_arrived) };
    }
}
