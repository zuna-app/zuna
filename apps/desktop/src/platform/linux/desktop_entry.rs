//! On Linux the applications menu, `zuna://` links and the portals find the app by its .desktop
//! file, `zuna.desktop`. The .deb, .rpm and pacman packages install it in
//! /usr/share/applications. An AppImage or a .tar.gz has nowhere to put one, so it writes this
//! person's own each time it starts, pointing at wherever it is now, and takes it away again
//! once a package has one, as the desktop's `desktop-entry.ts` does.

use std::path::{Path, PathBuf};

/// Marks a .desktop file as one this wrote, so it never changes or removes anyone else's.
const MARK: &str = "X-Zuna-Written-By-Itself=true";

fn name() -> String {
    format!("{}.desktop", crate::platform::APP_ID)
}

fn data_home() -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(set) if set.is_absolute() => set,
        _ => dirs::home_dir().unwrap_or_default().join(".local/share"),
    }
}

/// Where packages install, without this person's own, which some systems list too.
fn system_data_dirs() -> Vec<PathBuf> {
    let home = data_home();
    std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|dirs| !dirs.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into())
        .split(':')
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute() && *dir != home)
        .collect()
}

/// A string value as the desktop entry specification escapes it.
fn escaped(value: &str) -> String {
    value.replace('\\', "\\\\")
}

/// A path as one argument of Exec, quoted as the specification asks, before a string's own escapes.
fn exec_argument(path: &str) -> String {
    if path.chars().all(|c| c.is_ascii_alphanumeric() || "_/.+-".contains(c)) {
        return path.into();
    }
    let mut quoted = String::from("\"");
    for c in path.chars() {
        if "\"`$\\".contains(c) {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    escaped(&quoted).replace('%', "%%")
}

/// The program to start: an AppImage by its own path, as what runs is a copy that's gone once it stops.
fn program() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if let (Some(image), Some(dir)) = (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR")) {
        // Another AppImage's, handed down through whatever started this one, isn't this.
        if exe.starts_with(Path::new(&dir)) {
            return Some(image.into());
        }
    }
    Some(exe)
}

/// Writes this person's .desktop file for an AppImage or a .tar.gz, or takes it away once a
/// package has one. A development build leaves it alone.
pub fn keep() {
    if cfg!(debug_assertions) {
        return;
    }
    if let Err(error) = write() {
        log::warn!("Zuna couldn't add itself to the applications menu: {error}");
    }
}

fn write() -> std::io::Result<()> {
    let own = data_home().join("applications").join(name());
    let existing = std::fs::read_to_string(&own).ok();
    let ours = existing.as_ref().is_some_and(|text| text.lines().any(|line| line == MARK));
    if system_data_dirs().iter().any(|dir| dir.join("applications").join(name()).exists()) {
        // This person's own goes first, so it would hide the package's.
        if ours {
            std::fs::remove_file(&own)?;
        }
        return Ok(());
    }
    if existing.is_some() && !ours {
        return Ok(());
    }
    let Some(path) = program() else { return Ok(()) };
    let Some(path) = path.to_str() else { return Ok(()) };
    // A line break in the path would start a line of its own.
    if path.chars().any(char::is_control) {
        return Ok(());
    }

    // What runs from an AppImage is gone once it stops, so the menu's icon is a copy.
    let picture = data_home().join("icons").join(format!("{}.png", crate::platform::APP_ID));
    if std::fs::read(&picture).ok().as_deref() != Some(crate::platform::ICON_256) {
        std::fs::create_dir_all(picture.parent().expect("it's in a folder"))?;
        std::fs::write(&picture, crate::platform::ICON_256)?;
    }
    let Some(picture) = picture.to_str() else { return Ok(()) };

    // As the packages' own, from scripts/linux-app.mjs, and gone from the menu once the program is.
    let text = [
        "[Desktop Entry]".to_string(),
        "Name=Zuna".into(),
        "Comment=Zuna: private, end-to-end encrypted chat on servers you run.".into(),
        format!("Exec={} %U", exec_argument(path)),
        format!("TryExec={}", escaped(path)),
        "Terminal=false".into(),
        "Type=Application".into(),
        format!("Icon={}", escaped(picture)),
        format!("StartupWMClass={}", crate::platform::APP_ID),
        "MimeType=x-scheme-handler/zuna;".into(),
        "Categories=Network;InstantMessaging;".into(),
        MARK.into(),
        String::new(),
    ]
    .join("\n");
    if existing.as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    std::fs::create_dir_all(own.parent().expect("it's in a folder"))?;
    std::fs::write(&own, text)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&own, std::fs::Permissions::from_mode(0o644))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_a_path_for_exec_as_the_specification_asks() {
        assert_eq!(exec_argument("/opt/Zuna/zuna"), "/opt/Zuna/zuna");
        assert_eq!(exec_argument("/home/a b/Zuna 100%.AppImage"), "\"/home/a b/Zuna 100%%.AppImage\"");
        assert_eq!(exec_argument("/x/$y\"z"), "\"/x/\\\\$y\\\\\"z\"");
    }
}
