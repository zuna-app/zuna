use crate::{DevicePixels, Pixels, Result, SharedString, Size, size};
use smallvec::SmallVec;

use image::{Delay, Frame};
use std::{
    borrow::Cow,
    fmt,
    hash::Hash,
    sync::{
        OnceLock,
        atomic::{AtomicUsize, Ordering::SeqCst},
    },
    time::{Duration, Instant},
};

/// A source of assets for this app to use.
pub trait AssetSource: 'static + Send + Sync {
    /// Load the given asset from the source path.
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>>;

    /// List the assets at the given path.
    fn list(&self, path: &str) -> Result<Vec<SharedString>>;
}

impl AssetSource for () {
    fn load(&self, _path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(None)
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(vec![])
    }
}

/// A unique identifier for the image cache
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct ImageId(pub usize);

#[derive(PartialEq, Eq, Hash, Clone)]
pub(crate) struct RenderImageParams {
    pub(crate) image_id: ImageId,
    pub(crate) frame_index: usize,
}

/// A cached and processed image, in BGRA format
pub struct RenderImage {
    /// The ID associated with this image
    pub id: ImageId,
    /// The scale factor of this image on render.
    pub(crate) scale_factor: f32,
    data: SmallVec<[Frame; 1]>,
    /// Zuna: when an animated picture was first drawn, which its clock counts from.
    started: OnceLock<Instant>,
}

impl PartialEq for RenderImage {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for RenderImage {}

impl RenderImage {
    /// Create a new image from the given data.
    pub fn new(data: impl Into<SmallVec<[Frame; 1]>>) -> Self {
        static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

        Self {
            id: ImageId(NEXT_ID.fetch_add(1, SeqCst)),
            scale_factor: 1.0,
            data: data.into(),
            started: OnceLock::new(),
        }
    }

    /// Zuna: the frame an animated picture is at now, by its own clock, and when the next one
    /// is due, or its only frame and None for a still one. Every copy of a picture shares the
    /// clock, which starts when it's first drawn, as a browser's copies of an image do, so they
    /// move together. As in browsers, a frame of 10 ms or less lasts 100 ms.
    pub fn frame_at(&self, now: Instant) -> (usize, Option<Instant>) {
        if self.data.len() < 2 {
            return (0, None);
        }
        let shown = |frame: &Frame| match Duration::from(frame.delay()) {
            delay if delay <= Duration::from_millis(10) => Duration::from_millis(100),
            delay => delay,
        };
        let cycle: Duration = self.data.iter().map(shown).sum();
        let started = *self.started.get_or_init(|| now);
        let into = Duration::from_nanos((now.saturating_duration_since(started).as_nanos() % cycle.as_nanos()) as u64);
        let mut end = Duration::ZERO;
        for (index, frame) in self.data.iter().enumerate() {
            end += shown(frame);
            if into < end {
                return (index, Some(now + (end - into)));
            }
        }
        (0, Some(now + (cycle - into)))
    }

    /// Convert this image into a byte slice.
    pub fn as_bytes(&self, frame_index: usize) -> Option<&[u8]> {
        self.data
            .get(frame_index)
            .map(|frame| frame.buffer().as_raw().as_slice())
    }

    /// Get the size of this image, in pixels.
    pub fn size(&self, frame_index: usize) -> Size<DevicePixels> {
        let (width, height) = self.data[frame_index].buffer().dimensions();
        size(width.into(), height.into())
    }

    /// Get the size of this image, in pixels for display, adjusted for the scale factor.
    pub(crate) fn render_size(&self, frame_index: usize) -> Size<Pixels> {
        self.size(frame_index)
            .map(|v| (v.0 as f32 / self.scale_factor).into())
    }

    /// Get the delay of this frame from the previous
    pub fn delay(&self, frame_index: usize) -> Delay {
        self.data[frame_index].delay()
    }

    /// Get the number of frames for this image.
    pub fn frame_count(&self) -> usize {
        self.data.len()
    }
}

impl fmt::Debug for RenderImage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImageData")
            .field("id", &self.id)
            .field("size", &self.size(0))
            .finish()
    }
}
