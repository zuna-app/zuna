//! Builds the encoder, native/encoder.c, as a library of its own against the FFmpeg the repository
//! pins, and gathers it with FFmpeg's libraries into `lib` beside the app, where the app loads it
//! from (encoder.rs) and its packages carry it from.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    println!("cargo:rerun-if-env-changed=ZUNA_CHECK_ONLY");

    // Type-checking another platform's Rust needs no compiler for that platform, and macOS only
    // builds the computer's sound, which needs no encoder.
    if env::var_os("ZUNA_CHECK_ONLY").is_some() || env::var("CARGO_CFG_TARGET_OS").unwrap() == "macos" {
        return;
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // apps/desktop/.cargo/config.toml says where, and the app's scripts fetch it there.
    let ffmpeg = env::var_os("FFMPEG_DIR").map(PathBuf::from).expect("FFMPEG_DIR says where FFmpeg is, as apps/desktop/.cargo/config.toml sets it");
    assert!(
        ffmpeg.join("include").exists(),
        "No FFmpeg at {}. The app's scripts fetch the one the repository pins, as does `node scripts/ffmpeg.mjs`.",
        ffmpeg.display()
    );

    // The app is in target/<profile>, and OUT_DIR is under its `build`: build/<crate>/out until
    // Rust 1.100, and build/<crate>/<hash>/out since, so it's found by name, not by how deep it is.
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let profile = out
        .ancestors()
        .find(|folder| folder.file_name().is_some_and(|name| name == "build"))
        .and_then(Path::parent)
        .unwrap_or_else(|| panic!("OUT_DIR isn't under a build folder: {}", out.display()));
    let libraries = profile.join("lib");
    fs::create_dir_all(&libraries).unwrap();

    build_encoder_library(&manifest, &ffmpeg, &out, &libraries);
    copy_ffmpeg(&ffmpeg, &libraries);
}

/// `cc` only makes static libraries, so this uses its choice of compiler and flags
/// and asks for a shared library by hand.
fn build_encoder_library(manifest: &Path, ffmpeg: &Path, out: &Path, libraries: &Path) {
    let compiler = cc::Build::new()
        .include(manifest.join("native"))
        .include(ffmpeg.join("include"))
        .opt_level(2)
        .cargo_metadata(false)
        .get_compiler();
    let source = manifest.join("native/encoder.c");

    let mut command = compiler.to_command();
    if compiler.is_like_msvc() {
        command
            .current_dir(out)
            .arg("/LD")
            .arg(&source)
            .arg(format!("/Fe:{}", libraries.join("zuna_encoder.dll").display()))
            .arg("/link")
            .arg(format!("/LIBPATH:{}", ffmpeg.join("lib").display()))
            .args(["avcodec.lib", "avutil.lib"])
            // Only the library goes beside the app, as everything there is packaged.
            .arg(format!("/IMPLIB:{}", out.join("zuna_encoder.lib").display()))
            .arg(format!("/PDB:{}", out.join("zuna_encoder.pdb").display()))
            .arg("/INCREMENTAL:NO");
    } else {
        // An old-style rpath, since FFmpeg's libraries need each other and the new kind
        // applies only to this library's direct dependencies.
        command
            .args(["-shared", "-fPIC", "-fvisibility=hidden"])
            .arg(&source)
            .arg(manifest.join("native/dmabuf_cuda.c"))
            .arg("-o")
            .arg(libraries.join("libzuna_encoder.so"))
            .arg(format!("-L{}", ffmpeg.join("lib").display()))
            .args(["-lavcodec", "-lavfilter", "-lavutil", "-ldl", "-Wl,-Bsymbolic", "-Wl,--disable-new-dtags"])
            // Beside this library, and where it was built for a development build.
            .arg("-Wl,-rpath,$ORIGIN")
            .arg(format!("-Wl,-rpath,{}", ffmpeg.join("lib").display()));
    }
    let status = command.status().expect("Couldn't run the C compiler");
    assert!(status.success(), "Couldn't build native/encoder.c");
}

/// Only what's needed: on Windows, the libraries the encoder links to and those they link to, and
/// on Linux those and what the app's media links to, each by the name it's loaded by,
/// libavcodec.so.62, as the links beside it, libavcodec.so and libavcodec.so.62.28.103, would
/// each copy the whole library again. With FFmpeg's licence, which goes with them.
fn copy_ffmpeg(ffmpeg: &Path, libraries: &Path) {
    let windows = env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows";
    let names: &[&str] = if windows { &["avcodec", "avutil", "swresample"] } else { &["avcodec", "avfilter", "avformat", "avutil", "swresample", "swscale"] };
    let wanted = |file: &str| {
        names.iter().any(|name| {
            if windows {
                file.strip_prefix(name).is_some_and(|rest| rest.starts_with('-') && rest.ends_with(".dll"))
            } else {
                file.strip_prefix(&format!("lib{name}.so.")).is_some_and(|version| !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit()))
            }
        })
    };
    for entry in fs::read_dir(ffmpeg.join(if windows { "bin" } else { "lib" })).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if wanted(&name) {
            fs::copy(entry.path(), libraries.join(&name)).unwrap();
        }
    }
    if ffmpeg.join("LICENSE.txt").exists() {
        fs::copy(ffmpeg.join("LICENSE.txt"), libraries.join("FFMPEG-LICENSE.txt")).unwrap();
    }
}
