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
- **Animated WebP from bytes.** `Image::to_image_data` decoded a WebP's first frame only, so
  an animated 7TV emote the app fetched itself stood still, or failed to draw at all. It now
  decodes every frame, as `img` does for a picture it loads (`platform.rs`).
- **An animation's next frame when it's due.** An animated picture drew its view again on every
  vsync, 120 times a second for an emote of 20 frames a second. It now does so when its next
  frame is due (`elements/img.rs`).
