# GPUI in Zuna

This is GPUI 0.2.2 as Zed published it on crates.io, without its examples and tests, which
`Cargo.toml`'s `[patch.crates-io]` puts in place of the published crate. It's here so the
Windows app can change how GPUI draws on Windows. Each change is marked `Zuna:` where it is.

- **Frames only when one is wanted.** GPUI's vsync thread told every window to redraw at the
  display's refresh rate for as long as the app ran, and the UI thread woke each time to find
  nothing to draw. It now sleeps until something marks a window dirty, asks for an animation
  frame or has a scene to present (`platform/windows/vsync.rs`, `platform.rs`, and the calls
  to `frame_wanted` in `window.rs` and `app.rs`). The scene is no longer presented again for
  a second after input on Windows, which only repeated the same frame.
- **Frames only when one is wanted on Wayland, too.** A Wayland window asked for the next frame
  callback on every frame and committed its surface, so while it was on screen the compositor
  woke the app at the display's refresh rate to find nothing to draw, and after input it
  presented the same scene again for a second. A window now asks for a callback only while
  something wants a frame, through the same `frame_wanted` (`want_frame`, `frame` and
  `completed_frame` in `platform/linux/wayland/window.rs`), and the second of presenting again
  is off on Linux too (`window.rs`). Measured with a chat open in a nested KWin at 60 Hz: 65 to
  71 wakeups of the main thread a second before, 8 after (`apps/desktop/test/linux-check.mjs`).
- **The first frame after a rest is drawn at once,** rather than at the next vblank, so what
  input changes shows sooner. Frames after it keep to vsync (`platform/windows/platform.rs`).
- **One Direct3D device at startup.** GPUI made a device to check an adapter worked, threw
  it away and made another. The first is kept, which takes about 110 ms off starting on an
  NVIDIA card, where the first device loads the driver (`platform/windows/directx_devices.rs`).
- **`Window::cursor_style_under_mouse`,** the cursor what's under the pointer asks for, so the
  app can leave a double-click on something clickable alone, as the desktop does (`window.rs`).
- **Animated WebP from bytes.** `Image::to_image_data` decoded a WebP's first frame only, so
  an animated 7TV emote the app fetched itself stood still, or failed to draw at all. It now
  decodes every frame, as `img` does for a picture it loads (`platform.rs`).
- **An animation's next frame when it's due.** An animated picture drew its view again on every
  vsync, 240 times a second on a 240 Hz screen, for an emote of 20 frames a second. It now
  does so when its next frame is due (`elements/img.rs`).
- **Smooth wheel scrolling.** A wheel's notch in a list or a scrolling area glides about 100 px,
  as Chromium's does, eased out over about 150 ms, and notches that come while it moves add to
  where it's going. A touchpad's pixels still move at once (`elements/smooth.rs`, and where
  `list.rs` and `div.rs` handle the wheel).
- **A cached view's own dependencies.** `App::detect_accessed_entities` counted what a cached
  view's draw touched less what anything had touched earlier in the frame, so a view made
  earlier in the frame left itself out. Once its drawing was reused, the window stopped
  listening for it, and notifying it drew nothing: a chat opened before its first message never
  showed it. It now counts what the draw touched (`app.rs`).
- **Activating a window with a given token on Wayland.** `Window::activate_window_with_token`
  hands `xdg_activation_v1` a token another program was given, such as a launcher's for a second
  start, or the tray's for a click, as Wayland only brings a window forward with one. GPUI's own
  `activate` asks for a token without a serial, which compositors refuse (`window.rs`,
  `platform.rs`, `platform/linux/wayland/window.rs`).
- **Files copied in a file manager.** `App::read_paths_from_clipboard` reads the `text/uri-list`
  a file manager offers, as a drop's is read, as GPUI's Wayland clipboard only read text and
  pictures (`app.rs`, `platform.rs`, `platform/linux/platform.rs`,
  `platform/linux/wayland/clipboard.rs`).

Beside GPUI, `vendor/xattr` is xattr 0.2.3, which GPUI's HTTP client takes in through
zed-async-tar on Unix. It named `libc::ENOATTR`, which libc no longer has on Linux, where it's
`ENODATA`, so it didn't build there (`src/sys/mod.rs`). Windows never builds it.
