// The library names itself through @rpath, as the app finds it in its bundle's Frameworks, and
// finds FFmpeg's libraries beside it there, or, in a debug build, where the repository keeps them.

fn main() {
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@rpath/libzuna_media_ffmpeg.dylib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        if let Ok(ffmpeg) = std::env::var("FFMPEG_DIR") {
            let ffmpeg = std::path::Path::new(&ffmpeg).canonicalize().map(|path| path.display().to_string()).unwrap_or(ffmpeg);
            println!("cargo:rustc-link-arg=-Wl,-rpath,{ffmpeg}/lib");
        }
    }
}
