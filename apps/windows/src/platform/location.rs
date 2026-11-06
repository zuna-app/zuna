//! Where this device is, from Windows's location service, as the desktop's browser
//! asks for it (`locate` in lib/location.ts). Nothing here loads a map.

use std::time::Duration;

use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};
use windows::Foundation::TimeSpan;

/// Latitude, longitude and how far off they may be, in meters; or why there isn't one, in words to show.
pub fn locate() -> Result<(f64, f64, Option<f64>), String> {
    let unavailable = || "Your location isn't available right now.".to_string();
    let access = Geolocator::RequestAccessAsync().and_then(|asked| asked.get()).map_err(|error| {
        log::debug!("location access: {error:?}");
        unavailable()
    })?;
    if access != GeolocationAccessStatus::Allowed {
        return Err("Zuna isn't allowed to use your location. Allow it in your system's privacy settings.".into());
    }
    let locator = Geolocator::new().map_err(|_| unavailable())?;
    locator.SetDesiredAccuracy(PositionAccuracy::High).ok();
    // As the desktop asks: at most 30 seconds old, and 20 seconds to find it.
    let age = TimeSpan::from(Duration::from_secs(30));
    let timeout = TimeSpan::from(Duration::from_secs(20));
    let position = locator.GetGeopositionAsyncWithAgeAndTimeout(age, timeout).and_then(|found| found.get()).map_err(|error| {
        log::debug!("location: {error:?}");
        if error.code().0 as u32 == 0x800705B4 {
            "Finding your location took too long. Try again.".to_string()
        } else {
            unavailable()
        }
    })?;
    let coordinate = position.Coordinate().map_err(|_| unavailable())?;
    let point = coordinate.Point().and_then(|point| point.Position()).map_err(|_| unavailable())?;
    let accuracy = coordinate.Accuracy().ok().map(|meters| meters.round());
    Ok((point.Latitude, point.Longitude, accuracy))
}
