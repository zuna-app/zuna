# Screen sharing proof of concept

Screen sharing through Chromium is poor on Linux because of how it captures and encodes, not because of WebRTC. It reads every frame back to the CPU with `glReadPixels`, and it has no supported hardware encoder there.

This tries the alternative: capture and encode natively on the GPU, and use LiveKit only to carry the result.

```
Windows.Graphics.Capture ─┐                 ┌─ NVENC, AMF ─┐
                          ├─ this program ──┤              ├─ LiveKit SDK ─ encrypted ─ LiveKit server ─ Chromium
xdg portal and PipeWire ──┘                 └─ NVENC, VA-API ┘   (pre-encoded mode)
```

Viewers need no native code. The test viewer is the same Electron and Chromium the app ships.

## Running it

`scripts/demo.mjs` fetches and builds what it needs, starts LiveKit, the publisher and a viewer, and reports what it measured. It downloads a pinned FFmpeg build, checked against its SHA-256, and builds LiveKit's server from a pinned tag. Everything stays on this machine.

Run `npm install` at the top of the repository first, for Electron. You also need Node, Go, Git and Rust.

**Windows** also needs Visual Studio's C++ build tools and a Rust MSVC toolchain:

```bash
rustup toolchain install stable-x86_64-pc-windows-msvc
```

```bash
node scripts/demo.mjs --seconds 30
```

**Linux** also needs clang, because libwebrtc's C++ doesn't work when built with GCC, and an xdg-desktop-portal for your desktop:

```bash
sudo apt install clang pkg-config libglib2.0-dev libva-dev
```

```bash
node scripts/demo.mjs --seconds 30
```

A dialog asks what to share. Pick the monitor the test window will open on, which is the last one unless `--display` says otherwise. If VA-API can't find its driver, set `LIBVA_DRIVERS_PATH`, since the FFmpeg build may look in a different place from your distribution.

Without `--seconds` it runs until Ctrl+C.

| Option | Default | |
|---|---|---|
| `--encoder` | `auto` | `h264_nvenc`, `h264_amf` (Windows), `h264_vaapi` (Linux) |
| `--bitrate` | `20000` | The most to send, in kbit/s |
| `--fps` | `60` | |
| `--input` | `gpu` | `cpu` gives the encoder frames from CPU memory |
| `--crop` | | `1920x1080` encodes that much of the monitor |
| `--e2ee` | `yes` | `no` turns encryption off |
| `--viewer-key` | `right` | `wrong` or `none`, to see what a viewer without the key gets |
| `--joins` | `0` | Joins this many times and times each first frame |
| `--display` | last | Which monitor the test window opens on |
| `--label` | | Names the results in `results/` |

The test window is the test scene. A clock drawn in pixels at its top left is read back out of the received video, which gives the real delay from screen to decoded frame. Colour swatches beside it are compared with what was drawn.

`node scripts/key-log-check.mjs` publishes with every native log on and looks for the key in the output.

`cargo test --release` in `publisher` runs the bitstream and PipeWire format tests, with the MSVC toolchain on Windows.

## What it measured

On Windows 11, with an RTX 5070 Ti and a Ryzen 7 9800X3D, using NVENC, with encryption on unless it says otherwise. The publisher, LiveKit and the viewer all ran on one machine, so this is over loopback. Each row leaves out the first 10 seconds of its run.

| Stream | Frames from | Sent | Encoding | Publisher's CPU | Screen to decoded, median / 95% |
|---|---|---|---|---|---|
| 2560x1440, 60 fps, up to 20 Mbit/s | GPU textures | 60.0 fps, 18.9 Mbit/s | 3.4 ms | 5.1% of a core | 63 / 87 ms |
| The same | CPU memory | 60.0 fps, 15.5 Mbit/s | 4.7 ms | 16.7% of a core | 64 / 85 ms |
| The same, not encrypted | GPU textures | 59.9 fps, 15.4 Mbit/s | 3.4 ms | 4.4% of a core | 64 / 77 ms |
| 2560x1440, 60 fps, up to 4 Mbit/s | GPU textures | 60.0 fps, 4.0 Mbit/s | 3.3 ms | 6.6% of a core | 55 / 71 ms |
| 1920x1080, 60 fps, up to 12 Mbit/s | GPU textures | 60.0 fps, 11.4 Mbit/s | 2.1 ms | 4.1% of a core | 56 / 73 ms |

- Every run had no freezes and no lost packets. The sent bitrates are below their limits because the bitrate was still climbing for part of each run, and the first row ran for 45 seconds and the others for 30.
- About 25 to 30 ms of the delay is the jitter buffer Chromium keeps.
- Colours came through within 1 out of 255 on every channel.
- Decoding took 0.7 ms a frame. Chromium hides which decoder that was.
- Text stayed sharp while scrolling at 20 Mbit/s, and readable at 4. The test scene is simple, though: scrolling text and moving squares. Video or a game will need more.

**Encryption**, using one key on both sides as MLS would provide it:

- With the wrong key, 7.2 MB arrived in 12 seconds and no frame decoded.
- With no key, which is what a LiveKit server has, the viewer showed a solid green frame with no sign of the screen.
- Ten joins all succeeded. The first frame took 711 ms on the first join, and 167 to 295 ms on the others.
- With every native log on, the key didn't appear in 3,114 lines, as text, hex, base64 or a byte list, and neither did the key derived from it. The report of the frame cryptor logging keys doesn't apply to this version, at least on this path. libwebrtc's logs stay off anyway unless `ZUNA_WEBRTC_LOG` is set.

## What hasn't been checked

- **Linux has never run.** The Rust type-checks for Linux, without the LiveKit parts, which aren't specific to a platform. The C compiles against FFmpeg's headers with MSVC, and the PipeWire formats are unit tested against layouts taken from its headers. Nothing has been linked or run on Linux, so the first run may well find problems.
- **AMF has never run.** The RX 6400 in this machine is disabled in Device Manager.
- **Real networks.** Nothing has been tried with loss, limited bandwidth or more than one viewer, so how LiveKit treats a slow viewer of this stream is unknown. Since a pre-encoded stream has one layer, it can't drop that viewer to a lower quality.

Not built: Intel on Windows, whose encoder doesn't take RGB textures, so it needs a GPU colour conversion first. Audio. Window capture on Windows. Following a change of resolution. Scaling. The portal does offer windows on Linux.

## What it found

These matter for building the real thing.

- **LiveKit's static libwebrtc contains a private copy of FFmpeg,** with the same symbol names, so ours can't link into the same program. The encoder wrapper is a shared library loaded at runtime for this reason, and on Linux it's opened with `RTLD_DEEPBIND` so that it can't bind to the other copy.
- **FFmpeg resets NVENC and forces a keyframe on every bitrate change,** and the other encoders only take a bitrate when opened. libwebrtc revises its estimate several times a second, so `pipeline.rs` ignores changes under 25% and paces the rest. Even so, the climb costs 6 or 7 extra keyframes. Calling NVENC's API directly would avoid them.
- **The bitrate climbs slowly,** at about 1 Mbit/s each second after a quick start: about 7 Mbit/s after 3 seconds, and 20 Mbit/s after 12 to 21. A 40 Mbit/s limit wasn't reached in 30 seconds. The first seconds are the softest part of a share.
- **A viewer who can't decrypt asks for keyframes without end,** and the sender can only answer by sending them to everyone. That made 22 keyframes in 12 seconds, against 11 in 45 seconds normally. A key change during a call needs thought for this reason.
- **The keyframe bug under encryption ([rust-sdks#1573](https://github.com/livekit/rust-sdks/issues/1573)) doesn't affect NVENC,** which writes `slice_type` 2. `h264.rs` rewrites other encoders' keyframes, and that's only been tested on made-up ones, since no other encoder has run yet.
- **NVENC's output needs cleaning up first.** It mixes three- and four-byte start codes, and the frame cryptor needs four. It also adds filler and SEI, which `h264.rs` removes.
- **Native and browser encryption work together** when both use HKDF over the raw key: `KeyDerivationAlgorithm::HKDF` natively, and an `ArrayBuffer` passed to `setKey` in the browser. That also suits a key from the MLS exporter, which is already random.
- **`cl.exe` can't open paths over 260 characters,** and LiveKit's headers pass that from a target folder inside a deep checkout, whatever Windows' long path setting says. So `demo.mjs` builds in `%LOCALAPPDATA%\zss`.
- **NVIDIA on Linux goes through shared memory here,** which costs a CPU copy. The compositor may also read back the frame to fill it, so expect worse than the 16.7% above. Bringing DMA-BUFs into NVENC through CUDA is the next step for that route. Sunshine does it, except on hybrid laptops where the frames come from the other GPU.
