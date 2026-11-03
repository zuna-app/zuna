use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-env-changed=ZUNA_FFMPEG_DIR");
    println!("cargo:rerun-if-env-changed=ZUNA_CHECK_ONLY");

    // Type-checking another platform's Rust needs no compiler for that platform, and macOS only
    // builds the computer's sound, which needs no encoder.
    if env::var_os("ZUNA_CHECK_ONLY").is_some() || env::var("CARGO_CFG_TARGET_OS").unwrap() == "macos" {
        return;
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let ffmpeg = env::var_os("ZUNA_FFMPEG_DIR")
        .map(PathBuf::from)
        .expect("Set ZUNA_FFMPEG_DIR to a build of FFmpeg, as scripts/build-screenshare.mjs does");
    assert!(ffmpeg.join("include").exists(), "No FFmpeg at {}", ffmpeg.display());

    // OUT_DIR is target/<profile>/build/<crate>/out, and the program is in target/<profile>.
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let program_dir = out.ancestors().nth(3).unwrap();

    build_encoder_library(&manifest, &ffmpeg, &out, program_dir);
    if env::var("CARGO_CFG_TARGET_OS").unwrap() == "windows" {
        copy_ffmpeg_dlls(&ffmpeg, program_dir);
    }
}

/// `cc` only makes static libraries, so this uses its choice of compiler and flags
/// and asks for a shared library by hand.
fn build_encoder_library(manifest: &Path, ffmpeg: &Path, out: &Path, program_dir: &Path) {
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
            .arg(format!("/Fe:{}", program_dir.join("zuna_encoder.dll").display()))
            .arg("/link")
            .arg(format!("/LIBPATH:{}", ffmpeg.join("lib").display()))
            .args(["avcodec.lib", "avutil.lib"]);
    } else {
        // An old-style rpath, since FFmpeg's libraries need each other and the new kind
        // applies only to this library's direct dependencies.
        command
            .args(["-shared", "-fPIC", "-fvisibility=hidden"])
            .arg(&source)
            .arg(manifest.join("native/dmabuf_cuda.c"))
            .arg("-o")
            .arg(program_dir.join("libzuna_encoder.so"))
            .arg(format!("-L{}", ffmpeg.join("lib").display()))
            .args(["-lavcodec", "-lavfilter", "-lavutil", "-ldl", "-Wl,-Bsymbolic", "-Wl,--disable-new-dtags"])
            // Beside this library when it's been packaged, and where it was built otherwise.
            .arg("-Wl,-rpath,$ORIGIN")
            .arg(format!("-Wl,-rpath,{}", ffmpeg.join("lib").display()));
    }
    let status = command.status().expect("Couldn't run the C compiler");
    assert!(status.success(), "Couldn't build native/encoder.c");
}

fn copy_ffmpeg_dlls(ffmpeg: &Path, program_dir: &Path) {
    for entry in fs::read_dir(ffmpeg.join("bin")).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "dll") {
            fs::copy(&path, program_dir.join(path.file_name().unwrap())).unwrap();
        }
    }
}
