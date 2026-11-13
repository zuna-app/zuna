//! On Linux the applications menu, `zuna://` links and the portals find the app by its .desktop
//! file, `zuna.desktop`. The .deb, .rpm and pacman packages install it in
//! /usr/share/applications. An AppImage or a .tar.gz has nowhere to put one, so it writes this
//! person's own each time it starts, pointing at wherever it is now, and takes it away again
//! once a package has one, as the Electron app's did.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Marks a .desktop file as one this wrote, so it never changes or removes anyone else's.
const MARK: &str = "X-Zuna-Written-By-Itself=true";

fn name() -> String {
    format!("{}.desktop", crate::platform::APP_ID)
}

/// This person's own data folder, from `XDG_DATA_HOME` as it's set and the home folder.
fn data_home(set: Option<OsString>, home: Option<PathBuf>) -> PathBuf {
    match set.map(PathBuf::from) {
        Some(set) if set.is_absolute() => set,
        _ => home.unwrap_or_default().join(".local/share"),
    }
}

/// Where packages install, from `XDG_DATA_DIRS` as it's set, without this person's own,
/// which some systems list too.
fn system_data_dirs(set: Option<String>, home: &Path) -> Vec<PathBuf> {
    set.filter(|dirs| !dirs.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into())
        .split(':')
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute() && dir != home)
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
    let home = data_home(std::env::var_os("XDG_DATA_HOME"), dirs::home_dir());
    let system = system_data_dirs(std::env::var("XDG_DATA_DIRS").ok(), &home);
    write_in(&home, &system, program().as_deref())
}

/// What `write` does, in the folders and for the program given.
fn write_in(data_home: &Path, system_dirs: &[PathBuf], program: Option<&Path>) -> std::io::Result<()> {
    let own = data_home.join("applications").join(name());
    let existing = std::fs::read_to_string(&own).ok();
    let ours = existing.as_ref().is_some_and(|text| text.lines().any(|line| line == MARK));
    if system_dirs.iter().any(|dir| dir.join("applications").join(name()).exists()) {
        // This person's own goes first, so it would hide the package's.
        if ours {
            std::fs::remove_file(&own)?;
        }
        return Ok(());
    }
    if existing.is_some() && !ours {
        return Ok(());
    }
    let Some(path) = program.and_then(Path::to_str) else { return Ok(()) };
    // A line break in the path would start a line of its own.
    if path.chars().any(char::is_control) {
        return Ok(());
    }

    // What runs from an AppImage is gone once it stops, so the menu's icon is a copy.
    let picture = data_home.join("icons").join(format!("{}.png", crate::platform::APP_ID));
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

    #[test]
    fn escapes_a_strings_backslashes() {
        assert_eq!(escaped("/opt/Zuna/zuna"), "/opt/Zuna/zuna");
        assert_eq!(escaped("/a\\b\\"), "/a\\\\b\\\\");
        assert_eq!(name(), "zuna.desktop");
    }

    #[test]
    fn finds_this_persons_data_folder_only_where_it_is_absolute() {
        let home = || Some(PathBuf::from("/home/a"));
        assert_eq!(data_home(None, home()), Path::new("/home/a/.local/share"));
        assert_eq!(data_home(Some("".into()), home()), Path::new("/home/a/.local/share"));
        assert_eq!(data_home(Some("data".into()), home()), Path::new("/home/a/.local/share"));
        assert_eq!(data_home(Some("/srv/data".into()), home()), Path::new("/srv/data"));
        assert_eq!(data_home(None, None), Path::new(".local/share"));
    }

    #[test]
    fn finds_where_packages_install_without_this_persons_own() {
        let home = Path::new("/home/a/.local/share");
        let defaults = vec![PathBuf::from("/usr/local/share"), PathBuf::from("/usr/share")];
        assert_eq!(system_data_dirs(None, home), defaults);
        assert_eq!(system_data_dirs(Some("".into()), home), defaults);
        assert_eq!(system_data_dirs(Some("share:/opt/share::".into()), home), vec![PathBuf::from("/opt/share")]);
        assert_eq!(system_data_dirs(Some("/home/a/.local/share:/usr/share".into()), home), vec![PathBuf::from("/usr/share")]);
    }

    /// A data folder, a system's folder and a program of their own, gone once it's dropped.
    struct Folders {
        root: PathBuf,
        home: PathBuf,
        system: PathBuf,
    }

    impl Folders {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("zuna-desktop-entry-{}-{name}", std::process::id()));
            std::fs::remove_dir_all(&root).ok();
            let folders = Folders { home: root.join("home"), system: root.join("system"), root };
            std::fs::create_dir_all(&folders.system).unwrap();
            folders
        }

        fn own(&self) -> PathBuf {
            self.home.join("applications").join(name())
        }

        fn write(&self, program: &str) -> Option<String> {
            write_in(&self.home, std::slice::from_ref(&self.system), Some(&self.root.join(program))).expect("written");
            std::fs::read_to_string(self.own()).ok()
        }

        fn package(&self) {
            std::fs::create_dir_all(self.system.join("applications")).unwrap();
            std::fs::write(self.system.join("applications").join(name()), "[Desktop Entry]\nName=Zuna\n").unwrap();
        }
    }

    impl Drop for Folders {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    #[test]
    fn writes_an_entry_for_wherever_the_program_is() {
        use std::os::unix::fs::PermissionsExt;
        let folders = Folders::new("writes");
        let text = folders.write("opt/Zuna 1.AppImage").expect("there's an entry");
        let program = folders.root.join("opt/Zuna 1.AppImage");
        let icon = folders.home.join("icons/zuna.png");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "[Desktop Entry]");
        let program_text = program.to_str().unwrap();
        assert!(exec_argument(program_text).starts_with('"'), "a path with a space is quoted");
        assert!(lines.contains(&format!("Exec={} %U", exec_argument(program_text)).as_str()), "{text}");
        assert!(lines.contains(&format!("TryExec={}", program.display()).as_str()), "{text}");
        assert!(lines.contains(&format!("Icon={}", icon.display()).as_str()), "{text}");
        assert!(lines.contains(&"StartupWMClass=zuna"));
        assert!(lines.contains(&"MimeType=x-scheme-handler/zuna;"));
        assert!(lines.contains(&MARK));
        assert_eq!(std::fs::metadata(folders.own()).unwrap().permissions().mode() & 0o777, 0o644);
        assert_eq!(std::fs::read(&icon).unwrap(), crate::platform::ICON_256);

        // Moved, it points at where it is now.
        let moved = folders.write("elsewhere/zuna").expect("there's still an entry");
        let elsewhere = folders.root.join("elsewhere/zuna");
        assert!(moved.lines().any(|line| line == format!("Exec={} %U", exec_argument(elsewhere.to_str().unwrap()))), "{moved}");
    }

    #[test]
    fn leaves_the_same_entry_unwritten() {
        use std::os::unix::fs::PermissionsExt;
        let folders = Folders::new("same");
        let first = folders.write("zuna").expect("there's an entry");
        // Were it written again, it would be 0644 again.
        std::fs::set_permissions(folders.own(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(folders.write("zuna").as_deref(), Some(first.as_str()));
        assert_eq!(std::fs::metadata(folders.own()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn takes_its_own_entry_away_once_a_package_has_one() {
        let folders = Folders::new("package");
        assert!(folders.write("zuna").is_some());
        folders.package();
        assert_eq!(folders.write("zuna"), None);
        // And writes none while the package's is there.
        assert_eq!(folders.write("zuna"), None);
    }

    #[test]
    fn leaves_someone_elses_entry_of_the_same_name_alone() {
        let folders = Folders::new("someone");
        let theirs = "[Desktop Entry]\nName=Something else\nExec=/usr/bin/other\n";
        std::fs::create_dir_all(folders.own().parent().unwrap()).unwrap();
        std::fs::write(folders.own(), theirs).unwrap();
        assert_eq!(folders.write("zuna").as_deref(), Some(theirs));
        folders.package();
        assert_eq!(folders.write("zuna").as_deref(), Some(theirs));
    }

    #[test]
    fn writes_nothing_for_a_path_with_a_control_character() {
        let folders = Folders::new("control");
        assert_eq!(folders.write("zu\nna"), None);
        assert_eq!(folders.write("zu\tna"), None);
        assert!(!folders.home.join("icons").exists());
        // Nor without a program at all.
        write_in(&folders.home, std::slice::from_ref(&folders.system), None).unwrap();
        assert!(!folders.own().exists());
    }
}
