//! Where this device is, for sharing it, as the web asks the browser for it (`locate` in
//! packages/ui/src/lib/location.ts): from GeoClue, through the location portal, which asks the person in
//! the system's own dialog where it asks at all. Nothing here loads a map.

use std::time::Duration;

use ashpd::desktop::location::{Accuracy, LocationProxy};
use futures::StreamExt;

/// How long a position may take, as the web asks.
const FIND_WITHIN: Duration = Duration::from_secs(20);

enum Found {
    Position(f64, f64, f64),
    Refused,
    Unavailable,
}

async fn find() -> Found {
    let Ok(proxy) = LocationProxy::new().await.inspect_err(|error| log::debug!("location portal: {error}")) else { return Found::Unavailable };
    let Ok(session) = proxy.create_session(Some(0), Some(0), Some(Accuracy::Exact)).await.inspect_err(|error| log::debug!("location session: {error}")) else { return Found::Unavailable };
    let Ok(mut updates) = proxy.receive_location_updated().await else { return Found::Unavailable };
    // Turned down in the dialog, or in the system's settings.
    if let Err(error) = proxy.start(&session, None).await.and_then(|request| request.response()) {
        log::debug!("location refused: {error}");
        session.close().await.ok();
        return Found::Refused;
    }
    let location = updates.next().await;
    session.close().await.ok();
    match location {
        Some(location) => Found::Position(location.latitude(), location.longitude(), location.accuracy()),
        None => Found::Unavailable,
    }
}

/// Latitude, longitude and how far off they may be, in meters; or why there isn't one, in words to show.
pub fn locate() -> Result<(f64, f64, Option<f64>), String> {
    let (found, answer) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("zuna-location".into())
        .spawn(move || {
            found.send(futures::executor::block_on(find())).ok();
        })
        .ok();
    match answer.recv_timeout(FIND_WITHIN) {
        Ok(Found::Position(latitude, longitude, accuracy)) => Ok((latitude, longitude, Some(accuracy.round()))),
        Ok(Found::Refused) => Err("Zuna isn't allowed to use your location. Allow it in your system's privacy settings.".into()),
        Ok(Found::Unavailable) => Err("Your location isn't available right now.".into()),
        Err(_) => Err("Finding your location took too long. Try again.".into()),
    }
}
