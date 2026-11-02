//! Windows.Graphics.Capture hands over a D3D11 texture for each frame, and the copy
//! into the encoder's texture happens on the GPU, so no pixel touches the CPU.

use std::{
    ffi::c_void,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Instant,
};

use windows::{
    core::{factory, Interface, BOOL},
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{CloseHandle, HANDLE, LPARAM, POINT, RECT},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D, D3D11_BOX, D3D11_CPU_ACCESS_READ,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
                D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
            },
            Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1, DXGI_ADAPTER_DESC1},
            Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
            Gdi::{EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, HDC, HMONITOR, MONITORINFOEXW, MONITOR_DEFAULTTONULL},
        },
        System::{
            Threading::{CreateEventW, SetEvent, WaitForSingleObject},
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
                RoInitialize, RO_INIT_MULTITHREADED,
            },
        },
    },
};

use super::{even, Options};
use crate::{
    encoder::{Config, Encoder, Input, Pixel, Result, Stream, INPUT_CPU, INPUT_D3D11},
    pipeline::Pipeline,
};

const VENDOR_NVIDIA: u32 = 0x10de;
const VENDOR_AMD: u32 = 0x1002;
const VENDOR_INTEL: u32 = 0x8086;

fn error(doing: &str) -> impl Fn(windows::core::Error) -> String + '_ {
    move |error| format!("{doing}: {error}")
}

struct Monitor {
    handle: HMONITOR,
    name: String,
    rect: RECT,
    primary: bool,
}

fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn add(handle: HMONITOR, _: HDC, _: *mut RECT, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<Monitor>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo) }.as_bool() {
            let end = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
            list.push(Monitor {
                handle,
                name: String::from_utf16_lossy(&info.szDevice[..end]),
                rect: info.monitorInfo.rcMonitor,
                primary: info.monitorInfo.dwFlags & 1 != 0,
            });
        }
        true.into()
    }
    let mut list = Vec::new();
    let _ = unsafe { EnumDisplayMonitors(None, None, Some(add), LPARAM(&mut list as *mut _ as isize)) };
    list
}

pub fn list_monitors() {
    for (index, monitor) in monitors().iter().enumerate() {
        let rect = monitor.rect;
        println!(
            "{{\"type\":\"monitor\",\"index\":{index},\"name\":{:?},\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"primary\":{}}}",
            monitor.name,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            monitor.primary
        );
    }
    for (_, desc) in adapters().unwrap_or_default() {
        println!("{{\"type\":\"gpu\",\"name\":{:?},\"vendor\":\"{:#x}\"}}", adapter_name(&desc), desc.VendorId);
    }
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

/// Picks the GPU and its encoder: the one asked for, or the one driving the monitor.
fn choose_adapter(encoder: &str, monitor: HMONITOR) -> Result<(IDXGIAdapter1, String, String)> {
    let list = adapters()?;
    let wanted_vendor = match encoder {
        "auto" => None,
        "h264_nvenc" => Some(VENDOR_NVIDIA),
        "h264_amf" => Some(VENDOR_AMD),
        other => return Err(format!("This proof of concept doesn't do {other} on Windows: use h264_nvenc or h264_amf")),
    };
    let (adapter, desc) = list
        .iter()
        .find(|(adapter, desc)| wanted_vendor.map_or_else(|| drives_monitor(adapter, monitor), |vendor| desc.VendorId == vendor))
        .ok_or_else(|| format!("No GPU found for {encoder}"))?;
    let codec = match desc.VendorId {
        VENDOR_NVIDIA => "h264_nvenc",
        VENDOR_AMD => "h264_amf",
        VENDOR_INTEL => return Err("Intel isn't in this proof of concept on Windows, since its encoder doesn't take RGB textures".into()),
        vendor => return Err(format!("No encoder for GPU vendor {vendor:#x}")),
    };
    Ok((adapter.clone(), codec.to_owned(), adapter_name(desc)))
}

pub struct Capture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_arrived: HANDLE,
    width: u32,
    height: u32,
    full_size: (i32, i32),
    cpu_input: bool,
    staging: Option<ID3D11Texture2D>,
    codec: String,
    pub description: String,
}

impl Capture {
    pub fn open(options: &Options, _runtime: &tokio::runtime::Runtime) -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(error("Starting WinRT"))?;

        let all = monitors();
        let monitor = match options.monitor_at {
            Some((x, y)) => unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL) },
            None => all.get(options.monitor).ok_or_else(|| format!("There's no monitor {}", options.monitor))?.handle,
        };
        let monitor_name = all.iter().find(|m| m.handle == monitor).map_or("unknown monitor".to_owned(), |m| m.name.clone());

        let (adapter, codec, gpu) = choose_adapter(&options.encoder, monitor)?;

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

        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(error("Starting capture"))?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForMonitor(monitor) }.map_err(error("Capturing the monitor"))?;
        let size = item.Size().map_err(error("Reading the monitor's size"))?;

        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size)
            .map_err(error("Creating the frame pool"))?;
        let frame_arrived = unsafe { CreateEventW(None, false, false, None) }.map_err(error("Creating an event"))?;
        let signal = frame_arrived.0 as isize;
        pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
            unsafe { SetEvent(HANDLE(signal as *mut c_void)) }?;
            Ok(())
        }))
        .map_err(error("Listening for frames"))?;

        let session = pool.CreateCaptureSession(&item).map_err(error("Creating the session"))?;
        let _ = session.SetIsCursorCaptureEnabled(options.cursor);
        // Not on every version of Windows, and neither is worth stopping for.
        let _ = session.SetIsBorderRequired(false);
        // Half the frame's interval, because Windows drops a frame that comes even a little
        // inside this. At the screen's own refresh rate that's about every other one, and
        // `run` already keeps to the frame rate.
        let _ = session.SetMinUpdateInterval(TimeSpan { Duration: 10_000_000 / (options.fps as i64 * 2) });
        session.StartCapture().map_err(error("Starting the capture"))?;

        let (mut width, mut height) = (even(size.Width as u32), even(size.Height as u32));
        if let Some((crop_width, crop_height)) = options.crop {
            width = width.min(even(crop_width));
            height = height.min(even(crop_height));
        }

        let input = if options.cpu_input { "CPU memory" } else { "GPU textures" };
        Ok(Self {
            device,
            context,
            pool,
            session,
            frame_arrived,
            width,
            height,
            full_size: (size.Width, size.Height),
            cpu_input: options.cpu_input,
            staging: None,
            description: format!("{monitor_name} at {}x{} on {gpu}, {codec} from {input}", size.Width, size.Height),
            codec,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn open_encoder(&self, stream: Stream) -> Result<Encoder> {
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

    fn newest_frame(&self) -> Option<Direct3D11CaptureFrame> {
        let mut newest = None;
        // A frame goes back to the pool when dropped, freeing a slot for the next.
        while let Ok(frame) = self.pool.TryGetNextFrame() {
            newest = Some(frame);
        }
        newest
    }

    pub fn run(&mut self, pipeline: &mut Pipeline, stop: &AtomicBool) -> Result<()> {
        while !stop.load(Ordering::Relaxed) {
            let wait = pipeline.idle_wait().as_millis().max(1) as u32;
            let _ = unsafe { WaitForSingleObject(self.frame_arrived, wait) };

            let Some(mut frame) = self.newest_frame() else {
                pipeline.on_idle()?;
                continue;
            };
            // Monitors can refresh faster than the stream's frame rate, so wait for
            // the frame's turn and take whatever is newest by then.
            let due = pipeline.next_due();
            let now = Instant::now();
            if due > now {
                thread::sleep(due - now);
                if let Some(newer) = self.newest_frame() {
                    frame = newer;
                }
            }
            self.encode(&frame, pipeline)?;
        }
        Ok(())
    }

    fn encode(&mut self, frame: &Direct3D11CaptureFrame, pipeline: &mut Pipeline) -> Result<()> {
        let content = frame.ContentSize().map_err(error("Reading the frame's size"))?;
        if (content.Width, content.Height) != self.full_size {
            return Err(format!("The monitor changed to {}x{}, which this proof of concept doesn't follow", content.Width, content.Height));
        }
        let surface = frame.Surface().map_err(error("Reading the frame"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(error("Reading the frame"))?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(error("Reading the frame"))?;

        if !self.cpu_input {
            return pipeline.on_frame(Input::D3d11 { texture: texture.as_raw(), x: 0, y: 0 });
        }
        self.encode_from_cpu(&texture, pipeline)
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
