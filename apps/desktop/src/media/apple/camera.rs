//! Cameras on macOS, read through AVFoundation as Chromium reads them there: each listed by
//! the name macOS gives it, the Mac's own, one plugged in and an iPhone through Continuity
//! Camera, opened by its unique ID, and each frame taken as BGRA, top row first, made no taller
//! than 720p by AVFoundation itself, into the same reader V4L2's feed on Linux
//! (`camera::Reader`). macOS asks the person the first time, with the words in the bundle's
//! `Info.plist`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceDiscoverySession, AVCaptureDeviceInput, AVCaptureDevicePosition, AVCaptureDeviceTypeBuiltInWideAngleCamera,
    AVCaptureDeviceTypeContinuityCamera, AVCaptureDeviceTypeExternal, AVCaptureOutput, AVCaptureSession, AVCaptureSessionPreset1280x720, AVCaptureVideoDataOutput,
    AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeVideo,
};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress, kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString};

use crate::media::CameraDevice;
use crate::media::camera::Reader;

type Frame = (u32, u32, Vec<u8>);

/// The tallest a call sends, which frames are made no taller than.
const WANTED_HEIGHT: u32 = 720;

/// A picture of this size made the same shape and no taller than asked, each side even.
fn fitted(width: u32, height: u32, max_height: u32) -> (u32, u32) {
    if height <= max_height {
        return (width & !1, height & !1);
    }
    let scaled = (width as u64 * max_height as u64 / height as u64) as u32;
    ((scaled & !1).max(2), max_height)
}

/// The cameras there are, by their unique ID and name, asking AVFoundation: what's drawn reads
/// them through `crate::devices`, which keeps them.
pub fn cameras() -> Vec<CameraDevice> {
    // SAFETY: the device types and media type are AVFoundation's own constants.
    let devices = unsafe {
        let Some(video) = AVMediaTypeVideo else { return Vec::new() };
        let kinds = NSArray::from_slice(&[AVCaptureDeviceTypeBuiltInWideAngleCamera, AVCaptureDeviceTypeExternal, AVCaptureDeviceTypeContinuityCamera]);
        AVCaptureDeviceDiscoverySession::discoverySessionWithDeviceTypes_mediaType_position(&kinds, Some(video), AVCaptureDevicePosition::Unspecified).devices()
    };
    // SAFETY: a device's ID and name are plain strings.
    devices.iter().map(|device| unsafe { CameraDevice { id: device.uniqueID().to_string(), name: device.localizedName().to_string() } }).collect()
}

/// Whether the person lets Zuna use the camera, asking them the first time, which waits for
/// their answer.
fn allowed() -> bool {
    // SAFETY: the media type is AVFoundation's own constant.
    let Some(video) = (unsafe { AVMediaTypeVideo }) else { return false };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(video) } {
        AVAuthorizationStatus::Authorized => true,
        AVAuthorizationStatus::NotDetermined => {
            let (answer, answered) = std::sync::mpsc::channel();
            let told = RcBlock::new(move |granted: Bool| {
                answer.send(granted.as_bool()).ok();
            });
            // SAFETY: the block lives until it's called, as the method copies it.
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(video, &told) };
            answered.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
        }
        _ => false,
    }
}

/// The camera by its ID, or the system's default for "default" or one that's gone.
fn device(id: &str) -> Option<Retained<AVCaptureDevice>> {
    // SAFETY: looking a device up has no requirements.
    unsafe {
        let found = (id != "default").then(|| AVCaptureDevice::deviceWithUniqueID(&NSString::from_str(id))).flatten();
        found.or_else(|| AVCaptureDevice::defaultDeviceWithMediaType(AVMediaTypeVideo?))
    }
}

/// Opens a camera, saying what's wrong at once, and gives what reads it on a thread of its own.
pub(crate) fn open(id: &str) -> Result<Reader, String> {
    if !allowed() {
        return Err("Zuna isn't allowed to use the camera. Allow it in System Settings, under Privacy & Security, then Camera.".into());
    }
    if device(id).is_none() {
        return Err("There's no camera Zuna can use.".into());
    }
    let id = id.to_string();
    Ok(Box::new(move |stop: Arc<AtomicBool>, on_frame: &mut dyn FnMut(u32, u32, Vec<u8>)| {
        let (frames, session) = match start(&id) {
            Ok(started) => started,
            Err(error) => return log::warn!("the camera: {error}"),
        };
        while !stop.load(Ordering::Relaxed) {
            if let Ok((width, height, bgra)) = frames.recv_timeout(Duration::from_millis(200)) {
                on_frame(width, height, bgra);
            }
        }
        // SAFETY: the session was made on this thread, and is stopped once.
        unsafe { session.stopRunning() };
    }))
}

/// A running session on the camera, and its frames, the newest kept when they come faster
/// than they're taken.
fn start(id: &str) -> Result<(Receiver<Frame>, Retained<AVCaptureSession>), String> {
    let device = device(id).ok_or("the camera is gone")?;
    let (sender, frames) = sync_channel::<Frame>(2);
    // SAFETY: what's made here is set up before the session runs, and the delegate and its
    // queue live as long as the output that holds them.
    unsafe {
        let input = AVCaptureDeviceInput::deviceInputWithDevice_error(&device).map_err(|error| error.localizedDescription().to_string())?;
        let session = AVCaptureSession::new();
        if session.canSetSessionPreset(AVCaptureSessionPreset1280x720) {
            session.setSessionPreset(AVCaptureSessionPreset1280x720);
        }
        if !session.canAddInput(&input) {
            return Err("the camera can't be read".into());
        }
        session.addInput(&input);
        let output = AVCaptureVideoDataOutput::new();
        // The camera's own picture, made no taller than 720p on the GPU, as a call sends no
        // more, and scaling 1080p on the CPU each frame held it to a few a second.
        let dimensions = objc2_core_media::CMVideoFormatDescriptionGetDimensions(&device.activeFormat().formatDescription());
        let (width, height) = fitted(dimensions.width.max(2) as u32, dimensions.height.max(2) as u32, WANTED_HEIGHT);
        let as_key = |key: &objc2_core_foundation::CFString| -> &NSString { &*(key as *const _ as *const NSString) };
        let number = |value: u32| Retained::into_super(Retained::into_super(Retained::into_super(NSNumber::new_u32(value))));
        let settings: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_retained_objects(
            &[as_key(kCVPixelBufferPixelFormatTypeKey), as_key(objc2_core_video::kCVPixelBufferWidthKey), as_key(objc2_core_video::kCVPixelBufferHeightKey)],
            &[number(kCVPixelFormatType_32BGRA), number(width), number(height)],
        );
        output.setVideoSettings(Some(&settings));
        output.setAlwaysDiscardsLateVideoFrames(true);
        let delegate = Delegate::new(sender);
        let queue = dispatch2::DispatchQueue::new("chat.zuna.camera", None);
        output.setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*delegate)), Some(&queue));
        if !session.canAddOutput(&output) {
            return Err("the camera's frames can't be read".into());
        }
        session.addOutput(&output);
        session.startRunning();
        // The output keeps its delegate weakly, so this one goes with the session.
        std::mem::forget(delegate);
        Ok((frames, session))
    }
}

/// A frame's pixels, BGRA rows packed tight, top row first.
fn pixels(buffer: &CVPixelBuffer) -> Option<Frame> {
    // SAFETY: the buffer is locked for reading while its rows are copied.
    unsafe {
        if CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
            return None;
        }
        let (width, height, stride) = (CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), CVPixelBufferGetBytesPerRow(buffer));
        let base = CVPixelBufferGetBaseAddress(buffer) as *const u8;
        let frame = (!base.is_null()).then(|| {
            let mut bgra = Vec::with_capacity(width * height * 4);
            for row in 0..height {
                bgra.extend_from_slice(std::slice::from_raw_parts(base.add(row * stride), width * 4));
            }
            (width as u32, height as u32, bgra)
        });
        CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly);
        frame
    }
}

struct DelegateIvars {
    frames: SyncSender<Frame>,
}

define_class!(
    // SAFETY: NSObject has no requirements of a subclass, and Delegate has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for Delegate {
        // Each frame, on the output's own queue.
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn captured(&self, _output: &AVCaptureOutput, sample: &CMSampleBuffer, _connection: &AVCaptureConnection) {
            // SAFETY: the sample's picture is valid for the call.
            let Some(image) = (unsafe { sample.image_buffer() }) else { return };
            let buffer: &CVPixelBuffer = &image;
            if let Some(frame) = pixels(buffer) {
                // Dropped when the reader is behind: the newest is what's wanted.
                self.ivars().frames.try_send(frame).ok();
            }
        }
    }
);

impl Delegate {
    fn new(frames: SyncSender<Frame>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { frames });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}
