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

It joins the room as a participant of its own, `<user>.<device>.screen`, whose token only comes once the server's rules have said yes, can only publish a screen, and can't subscribe to anything. Like everyone else, it has a key of its own, derived from the room's key and that identity, so viewers can open what it sends with no help from it.

The computer's sound can't come from it, since it only captures pictures. Where it's asked for, on Windows, the app captures just the sound through Chromium and publishes that alongside.

On Windows the program also answers one question that has nothing to do with sharing: `--notification-state` prints whether Windows wants quiet right now, and exits, since Node can't ask. The app draws its own notifications there, so they don't get the system's rules for full-screen apps, presentations and Do Not Disturb (`apps/desktop/src/main/notifications.ts`). A build without the program shows notifications regardless.

It's told what to make of the picture on its command line, since none of that is secret: `--fps`, `--bitrate-kbps`, `--max-height`, `--no-cursor`, `--encoder`, `--quality` and `--keyframe-seconds`.

## What a server says, and what a device chooses

Everything a share uses comes from three places, in this order: what the person chose on this device (Settings, Screen sharing, and the picker), or otherwise what the server suggests, and then the server's limits over either. `screenTerms` in `packages/core/src/voice.ts` works it out, and the stream stats window says which limits it was held to.

**Server settings, Screen sharing,** for its admins. These are kept together in the `screen_share` setting and reach every app as part of `ServerInfo`:

| Rule | Held by |
|---|---|
| Who can share: everyone, admins or nobody | The media server |
| Whether sound can go with a share | The media server |
| How many can share at once, in a voice channel and on the server | The server, then the media server |
| Each voice channel's own say, when it's edited: off, or how many at once | The server, then the media server |
| The largest picture, frame rate, bitrate and sound bitrate | The apps |
| What's suggested for size, frame rate and bitrate | The apps |
| Whether admins are held to the limits and to how many at once | Both of those |

The first group holds whatever an app does. The token for coming into a voice channel doesn't allow a screen at all. To share, a device asks `POST /api/channels/{id}/voice/screen`, which keeps a place for it if the rules allow one. Only then is it given a token for the native program, or LiveKit is told to let its own connection publish a screen. LiveKit refuses anything else, and takes down what's already going when that's revoked.

So a share ends when it's stopped, when the device leaves the channel or makes a new connection, when an admin stops it, and when the rules stop allowing it. Limits on how many only hold for those starting after them.

The second group can't be held that way. The picture is encrypted and LiveKit doesn't check the rate of what it's sent, so the apps keep to these themselves, and a modified app could send more. A share already going keeps what it started with. Anyone worried about their bandwidth bill should also look at LiveKit's own `limit` settings, which apply to the whole media server.

**Settings, Screen sharing,** on each device:

| Setting | Native | Through the browser |
|---|---|---|
| Size, frame rate, most it may send | yes | yes |
| Sound: starting with it on, its quality | Captured by the browser beside the share | yes |
| How loud others' shares are, and whether one fills the stage when it starts | Those are for whoever's watching, however it was sent | |
| Capturing on the graphics card at all | yes | |
| Showing the pointer | yes | No: Chromium accepts `cursor: "never"` and goes on showing it, measured in Electron on Windows, so it isn't offered |
| Encoder, effort per frame, how often a full picture goes | yes | |
| What it's mostly showing, what gives first when the connection can't keep up | | yes |
| Codec, and sending a smaller copy | No: H.264, one layer, since it arrives already encoded | yes |

A native share that can't do what was chosen doesn't fail: it goes through the browser, and stream stats says why.

**Making the picture smaller** happens on the GPU, keeping its shape and an even size:

| Route | How |
|---|---|
| Windows | D3D11's video processor, in `native/encoder.c` |
| Linux, NVENC from DMA-BUFs | An OpenGL blit, in `native/dmabuf_cuda.c` |
| Linux, VA-API | `scale_vaapi`, which the graph already had for its colours |
| NVENC or AMF from CPU memory, which is a compositor that can't share DMA-BUFs | It can't, so that share goes through the browser |
| Through the browser | `height: { max }` in `getDisplayMedia` |

## Building it

```bash
npm run build:screenshare
```

This fetches a pinned FFmpeg build, checks its SHA-256, builds the program and gathers what it needs into `apps/desktop/native/screenshare/dist`, which `npm run dist` then packs into installers as a resource. Without it, the app shares through Chromium. Once it's built, `npm run dev` rebuilds it whenever its code changes, but the first build is always something to ask for.

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
- **Making the picture smaller** has run natively on Windows with NVENC, at 1280x720 from 2560x1440 at about 3.5% of a core. Its Linux routes are compiled or type-checked at most, and have never run.
- **Effort per frame** has been run at each end on Windows with NVENC, where it costs little at these sizes. Nobody has compared the pictures.
- **Leaving the pointer out natively** asks Windows and the portal to, and nobody has looked at a picture to see that it worked.
- **Sharing a window natively** isn't built: it goes through Chromium.
- **Real networks:** a pre-encoded stream has one layer, so a viewer on a slow connection can't be dropped to a lower quality.
