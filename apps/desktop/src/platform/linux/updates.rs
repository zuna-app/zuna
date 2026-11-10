//! Updates on Linux come from the system's packages, or a new AppImage, as they did for the
//! Electron app, so the app never updates itself.

use std::path::Path;

/// Whether this copy is the one a package installed, which registers `zuna://` itself.
pub fn installed(_exe: &Path) -> bool {
    false
}
