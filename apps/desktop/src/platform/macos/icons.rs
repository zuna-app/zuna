//! The unread count on the Dock's icon, as Electron's `app.setBadgeCount` puts it there on
//! macOS: the number, or nothing at zero.

use objc2::MainThreadMarker;
use objc2_app_kit::NSApplication;
use objc2_foundation::NSString;

/// Shows the unread count on the app's icon in the Dock.
pub fn set_unread(count: u32) {
    let Some(main_thread) = MainThreadMarker::new() else { return };
    let label = (count > 0).then(|| NSString::from_str(&count.to_string()));
    NSApplication::sharedApplication(main_thread).dockTile().setBadgeLabel(label.as_deref());
}

/// What the Dock's icon says, for the checks.
#[cfg(feature = "test-control")]
pub fn badge() -> Option<String> {
    let main_thread = MainThreadMarker::new()?;
    NSApplication::sharedApplication(main_thread).dockTile().badgeLabel().map(|label| label.to_string())
}
