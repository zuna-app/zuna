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

    println!("cargo:rerun-if-changed=assets/core/zuna-core.js");
    if !Path::new("assets/core/zuna-core.js").exists() {
        panic!("The core bundle is missing. Build it first: node apps/windows/core-bundle/build.mjs");
    }
}
