//! Links TDLib statically, from where scripts/tdlib.mjs builds it (apps/desktop/.deps/tdlib), or
//! from `ZUNA_TDLIB_DIR`, with the OpenSSL and zlib built beside it.

use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=ZUNA_TDLIB_DIR");
    let dir = std::env::var_os("ZUNA_TDLIB_DIR").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..").join(".deps").join("tdlib")
    });
    let lib = dir.join("lib");
    println!("cargo:rerun-if-changed={}", dir.join(".stamp").display());
    if !lib.is_dir() {
        panic!("TDLib isn't built in {}: run `node scripts/tdlib.mjs` first.", dir.display());
    }
    println!("cargo:rustc-link-search=native={}", lib.display());

    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    // Each before what it needs, which a linker on Linux reads them in the order of.
    for name in ["tdjson_static", "tdjson_private", "tdclient", "tdcore", "tdmtproto", "tdapi", "tde2e", "tddb", "tdsqlite", "tdnet", "tdactor", "tdutils"] {
        println!("cargo:rustc-link-lib=static={name}");
    }
    if windows {
        println!("cargo:rustc-link-lib=static=libssl");
        println!("cargo:rustc-link-lib=static=libcrypto");
        println!("cargo:rustc-link-lib=static=zs");
        for system in ["ws2_32", "mswsock", "normaliz", "psapi", "crypt32", "advapi32", "user32", "bcrypt", "gdi32", "shell32", "ole32"] {
            println!("cargo:rustc-link-lib=dylib={system}");
        }
    } else {
        println!("cargo:rustc-link-lib=static=ssl");
        println!("cargo:rustc-link-lib=static=crypto");
        println!("cargo:rustc-link-lib=static=z");
        match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
            Ok("macos") => {
                println!("cargo:rustc-link-lib=dylib=c++");
                println!("cargo:rustc-link-lib=framework=CoreFoundation");
                println!("cargo:rustc-link-lib=framework=Security");
            }
            // Linked whole on Linux, C library and all (scripts/linux-app.mjs builds it with
            // crt-static), so that its box lets it read no file of the system's at all.
            _ if std::env::var("CARGO_CFG_TARGET_FEATURE").is_ok_and(|features| features.split(',').any(|feature| feature == "crt-static")) => {
                println!("cargo:rustc-link-lib=static=stdc++");
            }
            _ => {
                println!("cargo:rustc-link-lib=dylib=stdc++");
                println!("cargo:rustc-link-lib=dylib=dl");
                println!("cargo:rustc-link-lib=dylib=pthread");
            }
        }
    }
}
