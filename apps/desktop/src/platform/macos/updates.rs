//! The app doesn't update itself on macOS yet: that needs a build signed with a Developer ID,
//! which local builds aren't (docs/MACOS_APP_PLAN.md).

use std::path::Path;

pub fn start() {}

pub fn install_on_quit() {}

/// Whether this copy is a bundle in Applications, the person's or the computer's, rather
/// than a build started where it was made.
pub fn installed(exe: &Path) -> bool {
    let in_bundle = exe.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS"));
    let applications = [Some(std::path::PathBuf::from("/Applications")), dirs::home_dir().map(|home| home.join("Applications"))];
    in_bundle && applications.iter().flatten().any(|folder| exe.starts_with(folder))
}
