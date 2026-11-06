use std::{
    sync::{
        Condvar, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

// Zuna: whether any window wants a frame drawn or presented. The vsync thread sleeps while
// none does, instead of waking every window at the display's refresh rate to find nothing
// to draw, which kept the UI thread busy for as long as the app ran.
static FRAME_WANTED: AtomicBool = AtomicBool::new(true);
static FRAME_LOCK: Mutex<()> = Mutex::new(());
static FRAME_WAKE: Condvar = Condvar::new();

/// Wakes the vsync thread for a frame, from any thread.
pub(crate) fn want_frame() {
    if !FRAME_WANTED.swap(true, Ordering::AcqRel) {
        // Taken after the flag is set, so a thread that saw it unset is already waiting.
        let _guard = FRAME_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        FRAME_WAKE.notify_one();
    }
}

/// Waits until a frame is wanted or the time is up, and says whether one is.
pub(crate) fn wait_for_wanted_frame(timeout: Duration) -> bool {
    let mut guard = FRAME_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let until = Instant::now() + timeout;
    while !FRAME_WANTED.load(Ordering::Acquire) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        guard = FRAME_WAKE.wait_timeout(guard, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
    }
    true
}

/// Takes the wish for a frame, just before the windows are told to draw one.
pub(crate) fn take_wanted_frame() {
    FRAME_WANTED.store(false, Ordering::Release);
}

use anyhow::{Context, Result};
use util::ResultExt;
use windows::Win32::{
    Foundation::HWND,
    Graphics::Dwm::{DWM_TIMING_INFO, DwmFlush, DwmGetCompositionTimingInfo},
    System::Performance::QueryPerformanceFrequency,
};

static QPC_TICKS_PER_SECOND: LazyLock<u64> = LazyLock::new(|| {
    let mut frequency = 0;
    // On systems that run Windows XP or later, the function will always succeed and
    // will thus never return zero.
    unsafe { QueryPerformanceFrequency(&mut frequency).unwrap() };
    frequency as u64
});

const VSYNC_INTERVAL_THRESHOLD: Duration = Duration::from_millis(1);
const DEFAULT_VSYNC_INTERVAL: Duration = Duration::from_micros(16_666); // ~60Hz

pub(crate) struct VSyncProvider {
    pub(crate) interval: Duration,
    f: Box<dyn Fn() -> bool>,
}

impl VSyncProvider {
    pub(crate) fn new() -> Self {
        let interval = get_dwm_interval()
            .context("Failed to get DWM interval")
            .log_err()
            .unwrap_or(DEFAULT_VSYNC_INTERVAL);
        let f = Box::new(|| unsafe { DwmFlush().is_ok() });
        Self { interval, f }
    }

    pub(crate) fn wait_for_vsync(&self) {
        let vsync_start = Instant::now();
        let wait_succeeded = (self.f)();
        let elapsed = vsync_start.elapsed();
        // DwmFlush and DCompositionWaitForCompositorClock returns very early
        // instead of waiting until vblank when the monitor goes to sleep or is
        // unplugged (nothing to present due to desktop occlusion). We use 1ms as
        // a threshold for the duration of the wait functions and fallback to
        // Sleep() if it returns before that. This could happen during normal
        // operation for the first call after the vsync thread becomes non-idle,
        // but it shouldn't happen often.
        if !wait_succeeded || elapsed < VSYNC_INTERVAL_THRESHOLD {
            log::trace!("VSyncProvider::wait_for_vsync() took less time than expected");
            std::thread::sleep(self.interval);
        }
    }
}

fn get_dwm_interval() -> Result<Duration> {
    let mut timing_info = DWM_TIMING_INFO {
        cbSize: std::mem::size_of::<DWM_TIMING_INFO>() as u32,
        ..Default::default()
    };
    unsafe { DwmGetCompositionTimingInfo(HWND::default(), &mut timing_info) }?;
    let interval = retrieve_duration(timing_info.qpcRefreshPeriod, *QPC_TICKS_PER_SECOND);
    // Check for interval values that are impossibly low. A 29 microsecond
    // interval was seen (from a qpcRefreshPeriod of 60).
    if interval < VSYNC_INTERVAL_THRESHOLD {
        Ok(retrieve_duration(
            timing_info.rateRefresh.uiDenominator as u64,
            timing_info.rateRefresh.uiNumerator as u64,
        ))
    } else {
        Ok(interval)
    }
}

#[inline]
fn retrieve_duration(counts: u64, ticks_per_second: u64) -> Duration {
    let ticks_per_microsecond = ticks_per_second / 1_000_000;
    Duration::from_micros(counts / ticks_per_microsecond)
}
