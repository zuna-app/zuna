//! zuna-watch: the window a video watched together plays in on Linux, where nothing can be put
//! inside another program's window under Wayland. A GTK window holding WebKitGTK, which loads
//! `watch.html` from packages/watch under the address the app names, the Referer YouTube needs,
//! as the macOS and iPhone apps load it in WKWebView. It keeps no data, frames YouTube's player
//! alone under the page's content security policy, opens a link pressed in it in the browser,
//! opens no window, and gets no camera, microphone or downloads.
//!
//! The app starts it (src/platform/linux/watch_view.rs) and they speak in lines of JSON over its
//! pipes. It's a program of its own so that the app starts without WebKitGTK, which its packages
//! only recommend, and so that GTK's main loop has a main thread of its own beside GPUI's.
//!
//! From the app, on standard input:
//!   {"type":"load","page":"…","origin":"https://chat.zuna.desktop/","title":"…"}  first, once
//!   {"type":"page","message":{…}}   for the page, as `window.zunaWatch.receive(message)`
//!   {"type":"title","title":"…"}    the window's title
//!   {"type":"raise"}                asks for the window to come forward
//! and the end of it, as when the app stops or goes, closes the window.
//!
//! To the app, on standard output:
//!   {"type":"page","message":"…"}   what the page posted, as it posted it, which the app checks
//!   {"type":"decoders","video":true,"sound":true}  whether GStreamer can decode what YouTube sends
//!   {"type":"closed"}               its person closed the window
//!   {"type":"failed","problem":"…"} it couldn't open, said before it exits
//!
//! Nothing else reaches standard output: what GTK, WebKit or a GPU's overlay print there goes to
//! standard error, which the app writes to its log.

#[cfg(target_os = "linux")]
mod decoders;
#[cfg(target_os = "linux")]
mod window;

#[cfg(target_os = "linux")]
fn main() {
    std::process::exit(window::run());
}

/// Only Linux needs a window of its own: the other systems put the web view in the app's.
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("zuna-watch only runs on Linux.");
    std::process::exit(1);
}
