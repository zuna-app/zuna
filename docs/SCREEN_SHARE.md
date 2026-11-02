# Native screen sharing

On Windows and Linux, the desktop app shares a whole screen from a small program of its own, which captures and encodes on the GPU and only uses LiveKit to carry the result. Viewers stay in Chromium, or the web app's browser, with nothing native.

```
Windows.Graphics.Capture ─┐                       ┌─ NVENC, AMF ─┐
                          ├─ zuna-screenshare ────┤              ├─ LiveKit SDK ─ encrypted ─ media server ─ viewers
xdg portal and PipeWire ──┘                       └─ NVENC, VA-API ┘   (pre-encoded mode)
```

This exists because screen sharing through Chromium is poor on Linux: it reads every frame back to the CPU with `glReadPixels`, and has no supported hardware encoder there. [The proof of concept's README](../poc/screenshare/README.md) has the measurements. A 2560x1440 share at 60 fps takes about 5% of a core on the sender.

Everything else goes through Chromium: sharing one window, macOS, the web app, and any build without the program. They all look the same to whoever is watching.

## How the app runs it

`apps/desktop/src/main/native-screen.ts` starts the program with `--control`. Its address, token and keys go over its standard input, one line of JSON at a time, since anything else on the computer could read a command line.

| Message | Means |
|---|---|
| `{"type":"start","url":…,"token":…,"key":…,"key_index":…}` | The first line: where to publish, and under what key |
| `{"type":"key","key":…,"key_index":…}` | The group moved on, so frames go under this from now on |
| `{"type":"stop"}` | Leave. Its standard input closing means the same, so it can't outlive the app |

It says `{"type":"ready",…}` on its standard output once it's publishing, `{"type":"stats",…}` once a second after that, and what's wrong on its standard error if it can't. If it doesn't start, the app shares through Chromium instead and says so, and the stream stats window, the button at the top of a voice channel, gives the reason. That window also has everything both routes report, frame by frame, for whoever is sending and whoever is watching.

It reaches the media server over TLS through rustls, trusting the system's certificates as Chromium does, so a server behind a private certificate authority works the same. `apps/desktop/test/voice-check.mjs` runs its media server behind TLS for this reason: plain `ws://` works without any TLS in the program at all.

It joins the room as a participant of its own, `<user>.<device>.screen`, whose token can only publish a screen and can't subscribe to anything. Like everyone else, it has a key of its own, derived from the room's key and that identity, so viewers can open what it sends with no help from it.

The computer's sound can't come from it, since it only captures pictures. Where it's asked for, on Windows, the app captures just the sound through Chromium and publishes that alongside.

## Building it

```bash
npm run build:screenshare
```

This fetches a pinned FFmpeg build, checks its SHA-256, builds the program and gathers what it needs into `apps/desktop/native/screenshare/dist`, which `npm run dist` then packs into installers as a resource. Without it, the app shares through Chromium.

**Windows** needs Visual Studio's C++ build tools and a Rust MSVC toolchain:

```bash
rustup toolchain install stable-x86_64-pc-windows-msvc
```

**Linux** needs clang, because libwebrtc's C++ doesn't work when built with GCC:

```bash
sudo apt install clang pkg-config libglib2.0-dev libva-dev
```

or on Arch:

```bash
sudo pacman -S clang pkgconf glib2 libva
```

A development build of the app finds the program in that same `dist` folder, or wherever `ZUNA_SCREENSHARE` says.

## Frame rate

What's sent depends on the screen changing: a still screen gets half a second at the full rate, for the encoder to sharpen it, and then a trickle. These are from Windows at 2560x1440 on a 240 Hz monitor, with something moving on the screen and 60 fps asked for:

| Route | Captured | Sent | Decoded by someone watching |
|---|---|---|---|
| Native, NVENC, over TLS | 60 | 60 | 60 |
| Chromium, OpenH264 | 57 | 57 | 57 |

Both keep from asking the system for exactly the frame rate. Windows drops a frame that arrives inside its minimum interval, and at the screen's own refresh rate that's a lot of them: asking for 239 fps on that monitor got 208, and asking for half the interval got 239. So it asks for half the interval, and the program keeps to the frame rate itself. Compositors can do the same, so on Linux it asks for a quarter more than the frame rate and trims what comes well ahead of its turn.

Chromium needs asking as well. Without a frame rate in `getDisplayMedia` it captures at 30, and LiveKit leaves the frame rate out when the size is the screen's own, so `voice/room.ts` passes it itself.

Chromium's fake capture runs at 20 fps. `--use-fake-ui-for-media-stream` swaps it in for a screen even when a real one was chosen, so measuring with that flag only measures the fake.

## What hasn't been checked

The proof of concept's README lists what has run where. Inside the app, only Windows with NVENC has run so far:

- **Linux** has only run in the proof of concept, on Arch with KDE and NVIDIA. It hasn't run from the app, or from a package, where the libraries come from beside the program rather than from where they were built. Its frame rate request and trimming are type-checked and have never run, and neither has its TLS.
- **VA-API and AMF** have never run.
- **Sharing a window natively** isn't built: it goes through Chromium.
- **Real networks:** a pre-encoded stream has one layer, so a viewer on a slow connection can't be dropped to a lower quality.
