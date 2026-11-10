// Embeds the icons, so the app is one file, and checks the core bundle is there.

use std::fmt::Write;
use std::path::Path;

fn main() {
    // Lucide's icons, written by scripts/icons.mjs, and the app's own beside them.
    let mut table = String::from("pub static ICONS: &[(&str, &[u8])] = &[\n");
    let root = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    for dir in ["icons", "app-icons"] {
        println!("cargo:rerun-if-changed=assets/{dir}");
        let mut names: Vec<String> = std::fs::read_dir(Path::new("assets").join(dir))
            .expect("the icon folders exist")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".svg"))
            .collect();
        names.sort();
        for name in names {
            writeln!(table, "    (\"icons/{name}\", include_bytes!(r\"{root}/assets/{dir}/{name}\")),").unwrap();
        }
    }
    table.push_str("];\n");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("icons.rs");
    std::fs::write(out, table).unwrap();

    embed_icon(&root);
    link_ffmpeg();
    link_objc();

    println!("cargo:rerun-if-changed=assets/core/zuna-core.js");
    if !Path::new("assets/core/zuna-core.js").exists() {
        panic!("The core bundle is missing. Build it first: node apps/desktop/core-bundle/build.mjs");
    }
}

/// On Linux, where FFmpeg's libraries are found: in `lib` beside the program, where the screen
/// share's build gathers them (screenshare/build.rs) and the packages carry them, and in a debug
/// build where the repository pins them too. An old-style rpath, since they need each other, and
/// the new kind only reaches the program's own.
fn link_ffmpeg() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    println!("cargo:rustc-link-arg=-Wl,--disable-new-dtags");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/lib");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        if let Ok(ffmpeg) = std::env::var("FFMPEG_DIR") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{ffmpeg}/lib");
        }
    }
}

/// On macOS, every Objective-C category in the static libraries: libwebrtc's, which LiveKit
/// links in, add methods to Foundation's classes that its video codecs call, and the linker
/// leaves a category out of a static library unless it's told to keep them all.
fn link_objc() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-ObjC");
    }
}

/// The app's icon in the exe, for Explorer, the taskbar and shortcuts, from the desktop's own
/// sizes: an ICO of PNGs, which Windows has read since Vista, compiled in as a resource, with its
/// name and version, which Task Manager shows as the app's name rather than Zuna.exe.
fn embed_icon(root: &str) {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icons = Path::new(root).join("resources/icons");
    println!("cargo:rerun-if-changed={}", icons.display());
    let images: Vec<(u32, Vec<u8>)> = [16u32, 24, 32, 48, 64, 128, 256].into_iter().filter_map(|size| std::fs::read(icons.join(format!("{size}x{size}.png"))).ok().map(|bytes| (size, bytes))).collect();
    if images.is_empty() {
        return;
    }
    let mut ico = Vec::new();
    ico.extend_from_slice(&[0, 0, 1, 0]);
    ico.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * images.len() as u32;
    for (size, bytes) in &images {
        // A size of 256 is written as 0.
        let side = if *size >= 256 { 0 } else { *size as u8 };
        ico.extend_from_slice(&[side, side, 0, 0]);
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&32u16.to_le_bytes());
        ico.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += bytes.len() as u32;
    }
    for (_, bytes) in &images {
        ico.extend_from_slice(bytes);
    }
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).to_path_buf();
    let icon = out.join("zuna.ico");
    std::fs::write(&icon, ico).unwrap();
    let rc = out.join("zuna.rc");
    println!("cargo:rerun-if-env-changed=ZUNA_VERSION");
    println!("cargo:rerun-if-env-changed=ZUNA_BUILD");
    println!("cargo:rerun-if-env-changed=ZUNA_CHANNEL");
    let version = std::env::var("ZUNA_VERSION").unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap());
    // The version's three numbers, then the build number, which is what tells two nightlies apart.
    let mut numbers: Vec<u16> = version.split(['.', '-', '+']).map(|part| part.parse().unwrap_or(0)).take(3).collect();
    numbers.resize(3, 0);
    let build = std::env::var("ZUNA_BUILD").ok().and_then(|build| build.parse::<u16>().ok()).unwrap_or(0);
    numbers.push(build);
    // As a person reads it: 1.2.3, or 1.2.3-nightly.1108.
    let version = match std::env::var("ZUNA_CHANNEL").as_deref() {
        Ok("nightly") if build > 0 => format!("{version}-nightly.{build}"),
        _ => version,
    };
    let numbers = numbers.iter().map(u16::to_string).collect::<Vec<_>>().join(",");
    let strings: String = [
        ("CompanyName", "Zuna contributors"),
        ("FileDescription", "Zuna"),
        ("FileVersion", version.as_str()),
        ("InternalName", "Zuna"),
        ("LegalCopyright", "Zuna contributors. Licensed under AGPL-3.0."),
        ("OriginalFilename", "Zuna.exe"),
        ("ProductName", "Zuna"),
        ("ProductVersion", version.as_str()),
    ]
    .iter()
    .map(|(key, value)| format!("      VALUE \"{key}\", \"{value}\"\n"))
    .collect();
    let info = format!(
        "1 VERSIONINFO\nFILEVERSION {numbers}\nPRODUCTVERSION {numbers}\nFILEOS 0x40004\nFILETYPE 0x1\nBEGIN\n  BLOCK \"StringFileInfo\"\n  BEGIN\n    BLOCK \"040904b0\"\n    BEGIN\n{strings}    END\n  END\n  BLOCK \"VarFileInfo\"\n  BEGIN\n    VALUE \"Translation\", 0x409, 1200\n  END\nEND\n"
    );
    std::fs::write(&rc, format!("1 ICON \"{}\"\n{info}", icon.display().to_string().replace('\\', "\\\\"))).unwrap();
    embed_resource::compile(&rc, embed_resource::NONE).manifest_optional().unwrap();
}
