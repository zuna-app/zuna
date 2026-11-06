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

    println!("cargo:rerun-if-changed=assets/core/zuna-core.js");
    if !Path::new("assets/core/zuna-core.js").exists() {
        panic!("The core bundle is missing. Build it first: node apps/windows/core-bundle/build.mjs");
    }
}

/// The app's icon in the exe, for Explorer, the taskbar and shortcuts, from the desktop's own
/// sizes: an ICO of PNGs, which Windows has read since Vista, compiled in as a resource.
fn embed_icon(root: &str) {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icons = Path::new(root).join("../desktop/resources/icons");
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
    std::fs::write(&rc, format!("1 ICON \"{}\"\n", icon.display().to_string().replace('\\', "\\\\"))).unwrap();
    embed_resource::compile(&rc, embed_resource::NONE).manifest_optional().unwrap();
}
