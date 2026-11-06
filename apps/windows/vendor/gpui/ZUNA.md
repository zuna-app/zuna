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
