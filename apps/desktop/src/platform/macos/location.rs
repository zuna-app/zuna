//! Where this device is, for sharing it, as the desktop's browser asks for it (`locate` in
//! lib/location.ts): from CoreLocation, which asks the person the first time in macOS's own
//! dialog, with the words in the bundle's `Info.plist`. Nothing here loads a map.
//!
//! A location manager answers on the run loop of the thread that made it, so each request gets
//! a thread of its own that runs one until there's an answer.

use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_foundation::{CFRunLoop, kCFRunLoopDefaultMode};
use objc2_core_location::{CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate, kCLLocationAccuracyBest};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};

/// How long a position may take, as the desktop asks.
const FIND_WITHIN: Duration = Duration::from_secs(20);
/// How long the person gets to answer macOS's question first.
const ASK_WITHIN: Duration = Duration::from_secs(120);

enum Found {
    Position(f64, f64, f64),
    Refused,
    Unavailable,
}

struct DelegateIvars {
    found: Sender<Found>,
}

define_class!(
    // SAFETY: NSObject has no requirements of a subclass, and Delegate has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl CLLocationManagerDelegate for Delegate {
        #[unsafe(method(locationManager:didUpdateLocations:))]
        fn did_update(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
            if let Some(location) = locations.lastObject() {
                // SAFETY: a location's coordinate and accuracy are plain values.
                let (coordinate, accuracy) = unsafe { (location.coordinate(), location.horizontalAccuracy()) };
                self.ivars().found.send(Found::Position(coordinate.latitude, coordinate.longitude, accuracy)).ok();
            }
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn did_fail(&self, _manager: &CLLocationManager, error: &NSError) {
            log::debug!("location failed: {}", error.localizedDescription());
            // kCLErrorDenied.
            let refused = error.code() == 1;
            self.ivars().found.send(if refused { Found::Refused } else { Found::Unavailable }).ok();
        }

        // Once the person has answered, or at once if they have before.
        #[unsafe(method(locationManagerDidChangeAuthorization:))]
        fn did_change_authorization(&self, manager: &CLLocationManager) {
            // SAFETY: asked on the manager's own thread.
            match unsafe { manager.authorizationStatus() } {
                CLAuthorizationStatus::NotDetermined => {}
                CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => {
                    self.ivars().found.send(Found::Refused).ok();
                }
                // SAFETY: asked on the manager's own thread.
                _ => unsafe { manager.requestLocation() },
            }
        }
    }
);

impl Delegate {
    fn new(found: Sender<Found>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { found });
        // SAFETY: NSObject's init is its designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// Asks once, on this thread's run loop, until there's an answer or it's taken too long.
fn find() -> Found {
    let (found, answer) = channel();
    let delegate = Delegate::new(found);
    // SAFETY: the manager is made, asked and dropped on this thread, which runs its run loop.
    let manager = unsafe { CLLocationManager::new() };
    unsafe {
        manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        manager.setDesiredAccuracy(kCLLocationAccuracyBest);
    }
    // The delegate hears the status at once if it's known; otherwise this asks the person.
    if unsafe { manager.authorizationStatus() } == CLAuthorizationStatus::NotDetermined {
        unsafe { manager.requestWhenInUseAuthorization() };
    }
    let started = Instant::now();
    loop {
        if let Ok(found) = answer.try_recv() {
            return found;
        }
        let waiting = started.elapsed();
        let asked = unsafe { manager.authorizationStatus() } == CLAuthorizationStatus::NotDetermined;
        if waiting > if asked { ASK_WITHIN } else { FIND_WITHIN } {
            return Found::Unavailable;
        }
        // SAFETY: the default mode is a constant the run loop takes.
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.25, true);
    }
}

/// Latitude, longitude and how far off they may be, in meters; or why there isn't one, in words to show.
pub fn locate() -> Result<(f64, f64, Option<f64>), String> {
    let (found, answer) = channel();
    std::thread::Builder::new()
        .name("zuna-location".into())
        .spawn(move || {
            found.send(find()).ok();
        })
        .ok();
    match answer.recv_timeout(ASK_WITHIN + FIND_WITHIN) {
        Ok(Found::Position(latitude, longitude, accuracy)) => Ok((latitude, longitude, Some(accuracy.round()))),
        Ok(Found::Refused) => Err("Zuna isn't allowed to use your location. Allow it in System Settings, under Privacy & Security, then Location Services.".into()),
        Ok(Found::Unavailable) => Err("Your location isn't available right now.".into()),
        Err(_) => Err("Finding your location took too long. Try again.".into()),
    }
}
