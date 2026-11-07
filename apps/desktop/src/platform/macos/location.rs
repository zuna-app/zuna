//! Where this device is, for sharing it.

/// Latitude, longitude and how far off they may be, in meters; or why there isn't one, in words to show.
pub fn locate() -> Result<(f64, f64, Option<f64>), String> {
    Err("Your location isn't available right now.".into())
}
