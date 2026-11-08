//! Sharing a screen or a window on macOS, in the app: macOS's own picker chooses what, as the
//! Electron app's Chromium had it choose there (`useSystemPicker`), and ScreenCaptureKit
//! captures it, already made no larger than asked, on the GPU, into IOSurfaces in NV12 that
//! VideoToolbox encodes as they are. Content picked there needs no Screen Recording permission.
//!
//! A test build can share moving bars in place of a screen, past the picker
//! (`ZUNA_FAKE_SCREEN`), as the iPhone's test builds do, so that the rest of the way is
//! checked with nobody there to pick.

use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferCreate, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeightOfPlane, CVPixelBufferGetWidthOfPlane,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCContentSharingPicker, SCContentSharingPickerConfiguration, SCContentSharingPickerMode, SCContentSharingPickerObserver, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType,
};

/// A frame to send or to show: a pixel buffer in NV12, full range, backed by an IOSurface.
#[derive(Clone)]
pub struct Picture(pub CFRetained<CVPixelBuffer>);

// SAFETY: a pixel buffer is reference counted and may be handed between threads.
unsafe impl Send for Picture {}

/// What was picked, for `capture`.
pub struct Picked(Retained<SCContentFilter>);

// SAFETY: a content filter is immutable once made.
unsafe impl Send for Picked {}

/// Whether test builds share moving bars in place of a screen.
pub fn fake() -> bool {
    cfg!(feature = "test-control") && std::env::var_os("ZUNA_FAKE_SCREEN").is_some()
}

// --- Picking ---

struct ObserverIvars {
    answer: std::sync::Mutex<Option<Sender<Result<Picked, String>>>>,
}

define_class!(
    // SAFETY: NSObject has no requirements of a subclass, and Observer has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = ObserverIvars]
    struct Observer;

    unsafe impl NSObjectProtocol for Observer {}

    unsafe impl SCContentSharingPickerObserver for Observer {
        #[unsafe(method(contentSharingPicker:didCancelForStream:))]
        fn did_cancel(&self, _picker: &SCContentSharingPicker, _stream: Option<&SCStream>) {
            self.answer(Err(String::new()));
        }

        #[unsafe(method(contentSharingPicker:didUpdateWithFilter:forStream:))]
        fn did_pick(&self, _picker: &SCContentSharingPicker, filter: &SCContentFilter, _stream: Option<&SCStream>) {
            self.answer(Ok(Picked(Retained::from(filter))));
        }

        #[unsafe(method(contentSharingPickerStartDidFailWithError:))]
        fn did_fail(&self, error: &NSError) {
            self.answer(Err(error.localizedDescription().to_string()));
        }
    }
);

impl Observer {
    fn new(answer: Sender<Result<Picked, String>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ObserverIvars { answer: std::sync::Mutex::new(Some(answer)) });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }

    fn answer(&self, picked: Result<Picked, String>) {
        if let Some(answer) = self.ivars().answer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            answer.send(picked).ok();
        }
    }
}

/// Shows macOS's picker for a screen or a window, on the main thread, and waits on another for
/// what's picked: Err with nothing in it when the person cancels.
pub fn pick(window: bool) -> std::sync::mpsc::Receiver<Result<Picked, String>> {
    let (answer, picked) = std::sync::mpsc::channel();
    // SAFETY: the picker is shared, and asked from the main thread, where the app's run loop is.
    unsafe {
        let picker = SCContentSharingPicker::sharedPicker();
        let configuration = SCContentSharingPickerConfiguration::new();
        configuration.setAllowedPickerModes(if window { SCContentSharingPickerMode::SingleWindow } else { SCContentSharingPickerMode::SingleDisplay });
        picker.setDefaultConfiguration(&configuration);
        let observer = Observer::new(answer);
        picker.addObserver(ProtocolObject::from_ref(&*observer));
        // The picker holds its observers weakly, so the last one is kept here, and taken off
        // when another picking starts.
        if let Some(last) = OBSERVER.with(|kept| kept.replace(Some(observer))) {
            picker.removeObserver(ProtocolObject::from_ref(&*last));
        }
        picker.setActive(true);
        picker.present();
    }
    picked
}

thread_local! {
    static OBSERVER: std::cell::RefCell<Option<Retained<Observer>>> = const { std::cell::RefCell::new(None) };
}

/// The picker's done with: no longer shown in the menu bar.
pub fn picked_done() {
    // SAFETY: the shared picker may be told it's no longer wanted at any time.
    unsafe { SCContentSharingPicker::sharedPicker().setActive(false) };
}

/// The size the bars are shared at, in place of a screen.
pub fn fake_size(max_height: u32) -> (u32, u32) {
    fitted(1920, 1080, max_height)
}

/// The size a picked screen or window is captured at: its own, in pixels, no taller than
/// `max_height`, each side even, as H.264 takes it.
pub fn size(picked: &Picked, max_height: u32) -> (u32, u32) {
    // SAFETY: a filter's size is a plain value.
    let (rect, scale) = unsafe { (picked.0.contentRect(), picked.0.pointPixelScale()) };
    let (width, height) = ((rect.size.width * scale as f64).round() as u32, (rect.size.height * scale as f64).round() as u32);
    fitted(width.max(2), height.max(2), max_height)
}

/// A picture of this size made the same shape and no taller than asked, each side even.
fn fitted(width: u32, height: u32, max_height: u32) -> (u32, u32) {
    let (width, height) = if max_height > 0 && height > max_height { (((width as u64 * max_height as u64) / height as u64) as u32, max_height) } else { (width, height) };
    ((width & !1).max(2), (height & !1).max(2))
}

// --- Capturing ---

type OnPicture = Box<dyn Fn(Picture) + Send + Sync>;
/// Shared with the block that hears whether the capture started, which ends the share too.
type OnStopped = Arc<dyn Fn(Option<String>) + Send + Sync>;

struct OutputIvars {
    on_picture: OnPicture,
    on_stopped: OnStopped,
}

define_class!(
    // SAFETY: NSObject has no requirements of a subclass, and Output has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = OutputIvars]
    struct Output;

    unsafe impl NSObjectProtocol for Output {}

    unsafe impl SCStreamOutput for Output {
        // Each frame, on the output's own queue. A frame where nothing changed comes without
        // a picture, and is passed over.
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            if kind != SCStreamOutputType::Screen {
                return;
            }
            // SAFETY: the sample's picture is valid for the call, and retained to keep.
            let Some(image) = (unsafe { sample.image_buffer() }) else { return };
            (self.ivars().on_picture)(Picture(image));
        }
    }

    unsafe impl SCStreamDelegate for Output {
        // Ended by macOS: the window closed, or Stop in the menu bar.
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            // SCStreamErrorUserStopped: the person stopped it from macOS's own menu.
            let problem = (error.code() != -3817).then(|| error.localizedDescription().to_string());
            (self.ivars().on_stopped)(problem);
        }
    }
);

impl Output {
    fn new(on_picture: OnPicture, on_stopped: OnStopped) -> Retained<Self> {
        let this = Self::alloc().set_ivars(OutputIvars { on_picture, on_stopped });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// A capture going on, until it's dropped.
pub struct Capture {
    stream: Option<Retained<SCStream>>,
    _output: Option<Retained<Output>>,
    fake: Option<Arc<AtomicBool>>,
}

// SAFETY: a stream may be stopped from any thread.
unsafe impl Send for Capture {}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(stop) = &self.fake {
            stop.store(true, Ordering::Relaxed);
        }
        if let Some(stream) = self.stream.take() {
            // SAFETY: stopping takes no handler it must keep.
            unsafe { stream.stopCaptureWithCompletionHandler(None) };
        }
    }
}

/// Starts capturing what was picked, at no more than `fps` and no taller than `max_height`,
/// each picture to `on_picture`, until it's dropped or macOS stops it (`on_stopped`).
pub fn capture(picked: Picked, max_height: u32, fps: u32, cursor: bool, on_picture: impl Fn(Picture) + Send + Sync + 'static, on_stopped: impl Fn(Option<String>) + Send + Sync + 'static) -> Result<Capture, String> {
    let (width, height) = size(&picked, max_height);
    let on_stopped: OnStopped = Arc::new(on_stopped);
    let output = Output::new(Box::new(on_picture), on_stopped.clone());
    // SAFETY: what's made here is set up before the stream starts, and the output and its
    // queue live as long as the capture.
    unsafe {
        let configuration = SCStreamConfiguration::new();
        configuration.setWidth(width as usize);
        configuration.setHeight(height as usize);
        configuration.setScalesToFit(true);
        configuration.setMinimumFrameInterval(CMTime::new(1, fps.max(1) as i32));
        configuration.setPixelFormat(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);
        configuration.setShowsCursor(cursor);
        configuration.setQueueDepth(5);
        let stream = SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &picked.0, &configuration, Some(ProtocolObject::from_ref(&*output)));
        let queue = dispatch2::DispatchQueue::new("chat.zuna.screen", None);
        stream.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*output), SCStreamOutputType::Screen, Some(&queue)).map_err(|error| error.localizedDescription().to_string())?;
        // A capture that doesn't start ends the share, saying why, rather than showing a share
        // that sends nothing.
        let failed = on_stopped.clone();
        let started = RcBlock::new(move |error: *mut NSError| {
            // SAFETY: when it isn't null, the error is valid for the call.
            if let Some(error) = error.as_ref() {
                let problem = error.localizedDescription().to_string();
                log::warn!("the screen capture didn't start: {problem}");
                failed(Some(format!("The screen capture didn't start: {problem}")));
            }
        });
        stream.startCaptureWithCompletionHandler(Some(&started));
        log::info!("capturing the screen at {width}×{height}, {fps} fps");
        Ok(Capture { stream: Some(stream), _output: Some(output), fake: None })
    }
}

/// Moving bars in place of a screen, for test builds: the same pictures ScreenCaptureKit
/// gives, NV12 in IOSurfaces, at `fps`.
pub fn capture_fake(max_height: u32, fps: u32, on_picture: impl Fn(Picture) + Send + 'static) -> Capture {
    let (width, height) = fake_size(max_height);
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    std::thread::Builder::new()
        .name("zuna-fake-screen".into())
        .spawn(move || {
            let started = Instant::now();
            let every = Duration::from_secs_f64(1. / fps.max(1) as f64);
            let mut frame = 0u64;
            while !stopping.load(Ordering::Relaxed) {
                if let Some(picture) = bars(width, height, frame) {
                    on_picture(picture);
                }
                frame += 1;
                if let Some(wait) = (every * frame as u32).checked_sub(started.elapsed()) {
                    std::thread::sleep(wait);
                }
            }
        })
        .ok();
    Capture { stream: None, _output: None, fake: Some(stop) }
}

/// One frame of bars moving across, NV12, full range, in an IOSurface.
fn bars(width: u32, height: u32, frame: u64) -> Option<Picture> {
    // SAFETY: the buffer is made here, and locked while it's written.
    unsafe {
        let surface_key: &CFString = kCVPixelBufferIOSurfacePropertiesKey;
        let empty = CFDictionary::<CFString, CFType>::empty();
        let attributes = CFDictionary::from_slices(&[surface_key], &[empty.as_ref() as &CFType]);
        let mut buffer: *mut CVPixelBuffer = std::ptr::null_mut();
        let made = CVPixelBufferCreate(None, width as usize, height as usize, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, Some(attributes.as_opaque()), std::ptr::NonNull::from(&mut buffer));
        if made != 0 || buffer.is_null() {
            return None;
        }
        let buffer = CFRetained::from_raw(std::ptr::NonNull::new(buffer)?);
        CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::empty());
        let offset = (frame * 8) as usize;
        for plane in 0..2 {
            let base = CVPixelBufferGetBaseAddressOfPlane(&buffer, plane) as *mut u8;
            let stride = CVPixelBufferGetBytesPerRowOfPlane(&buffer, plane);
            let (plane_width, plane_height) = (CVPixelBufferGetWidthOfPlane(&buffer, plane), CVPixelBufferGetHeightOfPlane(&buffer, plane));
            for row in 0..plane_height {
                let line = std::slice::from_raw_parts_mut(base.add(row * stride), if plane == 0 { plane_width } else { plane_width * 2 });
                if plane == 0 {
                    for (x, value) in line.iter_mut().enumerate() {
                        *value = if ((x + offset) / 120) % 2 == 0 { 210 } else { 40 };
                    }
                } else {
                    for pair in line.chunks_mut(2) {
                        pair.copy_from_slice(&[96, 160]);
                    }
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::empty());
        Some(Picture(buffer))
    }
}

/// The buffer as LiveKit takes it, handing it a reference of its own.
pub fn into_native(picture: Picture) -> *mut c_void {
    CFRetained::into_raw(picture.0).as_ptr() as *mut c_void
}

/// What VideoToolbox decoded, if a frame is still its pixel buffer and in the one format
/// GPUI draws, NV12 at full range; otherwise the frame is converted as everywhere else.
pub fn decoded(buffer: &dyn livekit::webrtc::prelude::VideoBuffer) -> Option<(u32, u32, Picture)> {
    let raw = buffer.as_native()?.get_cv_pixel_buffer() as *mut CVPixelBuffer;
    let raw = std::ptr::NonNull::new(raw)?;
    // SAFETY: the frame holds the buffer while this takes a reference of its own.
    let retained = unsafe { CFRetained::retain(raw) };
    if objc2_core_video::CVPixelBufferGetPixelFormatType(&retained) != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange {
        return None;
    }
    let (width, height) = (objc2_core_video::CVPixelBufferGetWidth(&retained) as u32, objc2_core_video::CVPixelBufferGetHeight(&retained) as u32);
    Some((width, height, Picture(retained)))
}
