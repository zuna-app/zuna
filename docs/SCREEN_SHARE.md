# Native screen sharing

On Windows and Linux, the desktop app shares a whole screen from a small program of its own, and on Linux one window too, which captures and encodes on the GPU and only uses LiveKit to carry the result. Viewers stay in Chromium, or the web app's browser, with nothing native.

```
Windows.Graphics.Capture ─┐                       ┌─ NVENC, AMF ─┐
                          ├─ zuna-screenshare ────┤              ├─ LiveKit SDK ─ encrypted ─ media server ─ viewers
xdg portal and PipeWire ──┘                       └─ NVENC, VA-API ┘   (pre-encoded mode)
```

This exists because screen sharing through Chromium is poor on Linux: it reads every frame back to the CPU with `glReadPixels`, and has no supported hardware encoder there. [The proof of concept's README](../poc/screenshare/README.md) has the measurements. A 2560x1440 share at 60 fps takes about 5% of a core on the sender.

Everything else goes through Chromium: one window on Windows, macOS, the web app, and any build without the program. They all look the same to whoever is watching.

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

The computer's sound can't come with its pictures. The app captures it apart and publishes it alongside, as [The computer's sound](#the-computers-sound) says.

## Choosing what to share on Linux

Under Wayland, nothing but the portal's dialog can say what there is to share, so the native program asks it, and the picker in the app only offers its two tabs: a screen, or a window, which tells the portal which to list. Chromium's own list would ask the portal too, so a native share used to bring up the dialog twice. `portalSources` in `native-screen.ts` asks the program (`--portal-sources`) whether there's a portal and what it shares, once, and where there isn't one, as in a session under X11, the app lists screens and windows itself as before. A share that can't go natively after all asks the portal again, through Chromium.

The portal only says whether a screen or a window was chosen, and the program says the same once it's publishing. A window can change size: PipeWire settles on the new size, and the program opens another encoder at it, keeping to the tallest that was asked, with a keyframe, so someone watching sees it at its new size at once. When the window closes, the compositor takes its PipeWire node away, which the program hears from PipeWire's registry, the same on every compositor, and it leaves, so the share ends without a word.

## The computer's sound

A share's sound goes out over the device's own connection, beside the picture, whichever way the picture goes:

| | Captured by | What can be chosen |
|---|---|---|
| Windows | Everything but Zuna: Chromium's loopback, which `restrictOwnAudio` keeps Zuna out of. One app: this program, through process loopback (`src/sound/windows.rs`) | Everything but Zuna, or one app |
| Linux | This program, from PipeWire (`src/sound/linux.rs`) | Everything but Zuna, or one app |
| macOS and the web | The browser | Whatever its own picker offers |

`--sound` writes everything playing apart from the process `--exclude-pid` names and those it started, and `--sound-from ID` only one app's, by the id `--sound-apps` or `--window-app` gives it. `pid:N` is a process and those it started.

What a share starts with follows what's shared: a screen, everything but Zuna, and a window, the sound of the app it belongs to. Windows and X11 say which process a window belongs to, which `--window-app` asks, so its sound is taken from that process and those it started. Wayland's portal doesn't, on any compositor, and Electron gets no title or icon for a window chosen through it either (seen on KDE: `window:1:0:s`, with no name). So there a window starts with no sound, and the picker says to choose the app whose sound goes with it, from those playing now and the one chosen last. A window on Windows without the program starts without sound too, since Chromium could only add everything. Settings' "Start with sound on" turns all of it off, and whatever's chosen in the picker holds until another source is.

On Linux, PipeWire has no stream of everything but one program, so the program makes a stream of its own that nothing connects to, and links each app's output into it as apps start and stop playing. The sound is taken as it leaves each app, after the app's own volume and before the system's, so where an app plays to makes no difference: speakers, headphones, or something like EasyEffects in between. Chromium plays Zuna's sound from a process under the app's, so it's left out, and nobody in the call hears themselves back. The links belong to the program, and go when it does.

`apps/desktop/src/main/native-sound.ts` runs it. It writes one line of JSON once it's listening, and then only sound: 32-bit floats, two channels interleaved at 48 kHz, and only while something plays. The samples go to the page over a MessagePort, and straight on to the audio thread (`voice/share-sound.worklet.ts`), which plays them into the published track. That keeps 40 ms in hand, more when PipeWire hands over larger pieces, and drops what piles up past 150 ms more, so the sound doesn't fall behind the picture.

On Windows an app is the first process of its program, found by walking up from the one with sound while the parent is the same program, so a browser's sound, which comes from a process it started, goes with it. Process loopback needs Windows 10 version 2004 or later, and before that a share of one app's goes without sound and says so.

The picker lists an app while it has a stream open on Linux, or a session on Windows, which for most is while it plays. A window's app is offered while it's quiet as well, since its sound is taken from whenever it starts.

On Windows the program also answers one question that has nothing to do with sharing: `--notification-state` prints whether Windows wants quiet right now, and exits, since Node can't ask. The app draws its own notifications there, so they don't get the system's rules for full-screen apps, presentations and Do Not Disturb (`apps/desktop/src/main/notifications.ts`). A build without the program shows notifications regardless.

On Linux it does the same for push to talk under Wayland, where nothing but the compositor sees a key held in another window. `--global-shortcuts` says whether the compositor has the global shortcuts portal and lets this app use it, and `--push-to-talk KEY` binds the key through it and says when it goes down and up, until the app closes its standard input (`src/shortcut.rs`, run by `apps/desktop/src/main/global-key.ts`). The portal only gives a shortcut to an app it can name, by the .desktop file installed under the name of the systemd scope the app runs in, which Electron makes from `desktopName`: `zuna.desktop`, which the .deb installs. An AppImage or a development build has none, so there push to talk is greyed out and says why, as it is where the compositor has no such portal.

It's told what to make of the picture on its command line, since none of that is secret: `--fps`, `--bitrate-kbps`, `--max-height`, `--no-cursor`, `--encoder`, `--quality`, `--keyframe-seconds`, and on Linux `--source screen` or `--source window`, which the portal's dialog offers.

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
| Sound: starting with it on, its quality | Captured beside the share: by the browser on Windows, by the program on Linux | yes, and on Linux by the program, as for a native share |
| Whose sound: everything but Zuna, or one app, starting from what's shared | Linux and Windows | Linux and Windows |
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

## Watching

Whoever's watching decodes in Chromium, or in the web app's browser. On Linux, Chromium won't decode through VA-API on an NVIDIA GPU unless `VaapiOnNvidiaGPUs` is on, so the desktop app turns it on when it runs on Wayland (`apps/desktop/src/main/index.ts`). That goes through nvidia-vaapi-driver, which NVIDIA doesn't ship, and where it isn't installed Chromium decodes in software as before. On X11 it stays off: there VA-API decodes every frame and paints each one white, seen on KDE through XWayland, both in the app and in a bare Electron page sending itself H.264. Measured in the app on Arch with KDE and an RTX 5080, at 1920x1080, a frame takes:

| Codec | Hardware | Software |
|---|---|---|
| H.264, every native share and most through the browser | 0.16 ms | 1.6 ms |
| VP8 | 0.2 ms | 2.0 ms |
| VP9 | 1.1 ms | 1.1 ms |
| AV1 | 0.4 ms | 0.9 ms |

Windows and macOS decode in hardware without being asked, through D3D11 and VideoToolbox, which hasn't been checked here, and nor have Intel or AMD GPUs on Linux.

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

The proof of concept's README lists what has run where. Inside the app, Windows and Linux with NVENC have run so far:

- **Linux** has run from the app on Arch with KDE and an RTX 5080, over KRdp with its screen at 1920x1080, publishing over TLS to apps watching: NVENC from DMA-BUFs, 60 fps sent and 60 decoded at 2.3 ms a frame and 4% of a core, and 30 fps asked for gave 30.0. KWin was asked for at most 37 then, which on KRdp's 60 Hz screen already lands on every other refresh, so the trimming still hasn't been seen at work. KWin offers any size from 200x200 to 10000x10000 with its screen's own as the default (seen in `pw-dump`), and scales to whatever's taken. PipeWire takes the consumer's default when the range allows it, so the program offers no size at all and gets the screen's own. Until it did, it offered 1920x1080. Since then, `voice-check.mjs` has shared a 2560x1440 screen natively at its own size.
- **VA-API and AMF** have never run.
- **Making the picture smaller** has run natively on Windows with NVENC, at 1280x720 from 2560x1440 at about 3.5% of a core, and on Linux with NVENC from DMA-BUFs through the OpenGL blit, at 1280x720 from 1920x1080 and 60 fps, 1.4 ms a frame and 4% of a core. VA-API's `scale_vaapi` has never run.
- **Effort per frame** has been run at each end on Windows with NVENC, where it costs little at these sizes. Nobody has compared the pictures.
- **Leaving the pointer out natively** asks Windows and the portal to. Through KDE's portal it works: with the pointer over the tab bar, a frame someone watching received showed it with the pointer on, and not with it off. On Windows nobody has looked at a picture.
- **Sharing a window natively** has run on Linux with KWin, in the app on Arch with an RTX 5080: a 908x634 window at 60 fps from DMA-BUFs, the one app's sound chosen for it reaching someone watching, its picture following it to 1288x534 at once, and the share ending quietly as it closed. GNOME, wlroots compositors and Hyprland haven't run it. One that kept a window's stream at one size and marked the window in it as `SPA_META_VideoCrop` would need that read, which the program doesn't ask for. On Windows it isn't built, and a window goes through Chromium: `GraphicsCaptureItem` can come from `CreateForWindow` in `src/capture/windows.rs`, and would need the same new encoder when the window changes size, and to end when it closes.
- **The computer's sound on Linux** has run from the app beside a share through the browser, in `apps/desktop/test/sound-check.mjs` on Arch with KDE, PipeWire 1.6 and EasyEffects, and by itself against a player linked straight to a sink without EasyEffects. Beside a native share, one app's sound has run with a window shared through KDE's portal, and the entire system's beside a native screen in `voice-check.mjs`. The same check shares a window on X11, whose app's sound is chosen and sent by itself, and checks that a screen starts with everything.
- **One app's sound on Windows** has been type-checked against Rust's Windows target, without LiveKit, and never built or run: listing the apps, which app a window belongs to, and process loopback.
- **Real networks:** a pre-encoded stream has one layer, so a viewer on a slow connection can't be dropped to a lower quality.
