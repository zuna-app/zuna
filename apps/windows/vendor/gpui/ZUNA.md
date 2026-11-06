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
