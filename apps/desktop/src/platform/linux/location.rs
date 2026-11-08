//! Where this device is, for sharing it, as the web asks the browser for it (`locate` in
//! packages/ui/src/lib/location.ts): from GeoClue, through the location portal, which asks the person in
//! the system's own dialog where it asks at all. Nothing here loads a map.

use std::time::Duration;

use ashpd::desktop::location::{Accuracy, CreateSessionOptions, LocationProxy, StartOptions};
use futures::StreamExt;

/// How long a position may take, as the web asks.
const FIND_WITHIN: Duration = Duration::from_secs(20);

enum Found {
    Position(f64, f64, f64),
    Refused,
    Unavailable,
    TookTooLong,
}

async fn find() -> Found {
    let Ok(proxy) = LocationProxy::new().await.inspect_err(|error| log::debug!("location portal: {error}")) else { return Found::Unavailable };
    let options = CreateSessionOptions::default().set_distance_threshold(0).set_time_threshold(0).set_accuracy(Accuracy::Exact);
    let Ok(session) = proxy.create_session(options).await.inspect_err(|error| log::debug!("location session: {error}")) else { return Found::Unavailable };
    let Ok(updates) = proxy.receive_location_updated().await else { return Found::Unavailable };
    futures::pin_mut!(updates);
    // Turned down in the dialog, or in the system's settings.
    if let Err(error) = proxy.start(&session, None, StartOptions::default()).await.and_then(|request| request.response()) {
        log::debug!("location refused: {error}");
        session.close().await.ok();
        return Found::Refused;
    }
    // The wait is ended here, so that the session is always closed: left open, GeoClue would
    // go on locating, and the system would show it doing so, until the app quit.
    let (time_up, waited) = futures::channel::oneshot::channel::<()>();
    std::thread::spawn(move || {
        std::thread::sleep(FIND_WITHIN);
        time_up.send(()).ok();
    });
    let found = match futures::future::select(updates.next(), waited).await {
        futures::future::Either::Left((Some(location), _)) => Found::Position(location.latitude(), location.longitude(), location.accuracy()),
        futures::future::Either::Left((None, _)) => Found::Unavailable,
        futures::future::Either::Right(_) => Found::TookTooLong,
    };
    session.close().await.ok();
    found
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
    // A little past the wait `find` ends itself, for a portal that doesn't answer at all.
    match answer.recv_timeout(FIND_WITHIN + Duration::from_secs(10)) {
        Ok(Found::Position(latitude, longitude, accuracy)) => Ok((latitude, longitude, Some(accuracy.round()))),
        Ok(Found::Refused) => Err("Zuna isn't allowed to use your location. Allow it in your system's privacy settings.".into()),
        Ok(Found::Unavailable) => Err("Your location isn't available right now.".into()),
        Ok(Found::TookTooLong) | Err(_) => Err("Finding your location took too long. Try again.".into()),
    }
}
