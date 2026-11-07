# Native screen sharing

On Windows and Linux, the desktop app shares a whole screen or one window from a small program of its own, which captures and encodes on the GPU and only uses LiveKit to carry the result. Viewers stay in Chromium, or the web app's browser, with nothing native.

```
Windows.Graphics.Capture ─┐                       ┌─ NVENC, AMF, Media Foundation ─┐
                          ├─ zuna-screenshare ────┤                                ├─ LiveKit SDK ─ encrypted ─ media server ─ viewers
xdg portal and PipeWire ──┘                       └─ NVENC, VA-API ────────────────┘   (pre-encoded mode)
```

This exists because screen sharing through Chromium is poor on Linux: it reads every frame back to the CPU with `glReadPixels`, and has no supported hardware encoder there. [The proof of concept's README](../poc/screenshare/README.md) has the measurements. A 2560x1440 share at 60 fps takes about 5% of a core on the sender.

Everything else goes through Chromium: macOS, the web app, a window under X11, and any build without the program. They all look the same to whoever is watching. On Macs with Apple silicon the program only takes the computer's sound, beside a share through Chromium. The iPhone and iPad share through LiveKit's Swift SDK, as [From an iPhone or iPad](#from-an-iphone-or-ipad) says.

## How the app runs it

`apps/desktop-electron-legacy/src/main/native-screen.ts` starts the program with `--control`. Its address, token and keys go over its standard input, one line of JSON at a time, since anything else on the computer could read a command line.

| Message | Means |
|---|---|
| `{"type":"start","url":…,"token":…,"key":…,"key_index":…}` | The first line: where to publish, and under what key |
| `{"type":"key","key":…,"key_index":…}` | The group moved on, so frames go under this from now on |
| `{"type":"stop"}` | Leave. Its standard input closing means the same, so it can't outlive the app |

It says `{"type":"ready",…}` on its standard output once it's publishing, `{"type":"stats",…}` once a second after that, and what's wrong on its standard error if it can't. If it doesn't start, the app shares through Chromium instead and says so, and the stream stats window, the button at the top of a voice channel, gives the reason. That window also has everything both routes report, frame by frame, for whoever is sending and whoever is watching.

It reaches the media server over TLS through rustls, trusting the system's certificates as Chromium does, so a server behind a private certificate authority works the same. `apps/desktop-electron-legacy/test/voice-check.mjs` runs its media server behind TLS for this reason: plain `ws://` works without any TLS in the program at all.

It joins the room as a participant of its own, `<user>.<device>.screen`, whose token only comes once the server's rules have said yes, can only publish a screen, and can't subscribe to anything. Like everyone else, it has a key of its own, derived from the room's key and that identity, so viewers can open what it sends with no help from it.

The computer's sound can't come with its pictures. The app captures it apart and publishes it alongside, as [The computer's sound](#the-computers-sound) says.

## Choosing what to share on Linux

Under Wayland, nothing but the portal's dialog can say what there is to share, so the native program asks it, and the picker in the app only offers its two tabs: a screen, or a window, which tells the portal which to list. Chromium's own list would ask the portal too, so a native share used to bring up the dialog twice. `portalSources` in `native-screen.ts` asks the program (`--portal-sources`) whether there's a portal and what it shares, once, and where there isn't one, as in a session under X11, the app lists screens and windows itself as before. A share that can't go natively after all asks the portal again, through Chromium.

The portal only says whether a screen or a window was chosen, and the program says the same once it's publishing. A window can change size: PipeWire settles on the new size, and the program opens another encoder at it, keeping to the tallest that was asked, with a keyframe, so someone watching sees it at its new size at once. When the window closes, the compositor takes its PipeWire node away, which the program hears from PipeWire's registry, the same on every compositor, and it leaves, so the share ends without a word.

## Sharing a window on Windows

The picker lists windows from Electron, whose id for one on Windows is `window:<HWND>:0`, and the program is given that HWND with `--window`. Windows.Graphics.Capture captures it from `CreateForWindow`, with its menus and popups from Windows 11 24H2, and the GPU is the one driving the screen it's mostly on.

It follows a window's size as Linux does: another encoder at the new size, keeping to the tallest that was asked, with a keyframe. A frame fills its pool's textures from the top left, so the pool is made as large as the window's screen, and only needs making again when a window grows past that. Dragging a window's edge then changes the size on almost every frame, and each goes out at its own size: measured with NVENC, a new encoder takes about 4 ms, and 28 of 30 fps went out while dragging. A screen whose resolution changes is followed the same way, where it used to end the share.

When the window closes, the program leaves and the share ends without a word. `GraphicsCaptureItem.Closed` never fires for a window here, since the program has no dispatcher queue, so it looks for the window itself while it waits for frames.

## The computer's sound

A share's sound goes out over the device's own connection, beside the picture, whichever way the picture goes:

| | Captured by | What can be chosen |
|---|---|---|
| Windows | This program, through process loopback (`src/sound/windows.rs`): everything but Zuna's processes, or one app's. A build without it, Chromium's loopback, which `restrictOwnAudio` keeps Zuna out of | Everything but Zuna, or one app |
| Linux | This program, from PipeWire (`src/sound/linux.rs`) | Everything but Zuna, or one app |
| macOS, on Apple silicon | This program, through Core Audio's process taps (`src/sound/macos.rs`), from macOS 14.2 | Everything but Zuna, or one app |
| The web | The browser | Whatever its own picker offers |

`--sound` writes everything playing apart from the process `--exclude-pid` names and those it started, and `--sound-from ID` only one app's, by the id `--sound-apps` or `--window-app` gives it. `pid:N` is a process and those it started.

What a share starts with follows what's shared: a screen, everything but Zuna, and a window, the sound of the app it belongs to. Windows and X11 say which process a window belongs to, which `--window-app` asks, so its sound is taken from that process and those it started. Wayland's portal doesn't, on any compositor, and Electron gets no title or icon for a window chosen through it either (seen on KDE: `window:1:0:s`, with no name). So there a window starts with no sound, and the picker says to choose the app whose sound goes with it, from those playing now and the one chosen last. A window on Windows without the program starts without sound too, since Chromium could only add everything. Settings' "Start with sound on" turns all of it off, and whatever's chosen in the picker holds until another source is.

On Linux, PipeWire has no stream of everything but one program, so the program makes a stream of its own that nothing connects to, and links each app's output into it as apps start and stop playing. The sound is taken as it leaves each app, after the app's own volume and before the system's, so where an app plays to makes no difference: speakers, headphones, or something like EasyEffects in between. Chromium plays Zuna's sound from a process under the app's, so it's left out, and nobody in the call hears themselves back. The links belong to the program, and go when it does.

`apps/desktop-electron-legacy/src/main/native-sound.ts` runs it. It writes one line of JSON once it's listening, and then only sound: 32-bit floats, two channels interleaved at 48 kHz, and only while something plays. The samples go to the page over a MessagePort, and straight on to the audio thread (`voice/share-sound.worklet.ts`), which plays them into the published track. That keeps 40 ms in hand, more when PipeWire hands over larger pieces, and drops what piles up past 150 ms more, so the sound doesn't fall behind the picture.

On macOS Core Audio's process taps take everything but a list of processes, or a mix of a few. The program reads one through a private aggregate device clocked by the output, and Apple's converter takes it to 48 kHz where the output runs at another rate. A process that starts later isn't in a tap, and macOS won't change one that's being read, so the program makes a new one when Zuna's processes, the chosen app's, or the output change, which misses a moment of sound at most. The first capture asks the person whether Zuna may record the computer's sound (`NSAudioCaptureUsageDescription`), and macOS asks about the app that started the program, so starting waits up to two minutes for the answer. Without permission, macOS hands over silence rather than an error. An app is the process macOS holds responsible for another, so a browser's helpers go with it, and it's named after its bundle. Only Apple silicon is built for; on an Intel Mac a share's sound isn't offered.

On Windows an app is the first process of its program, found by walking up from the one with sound while the parent is the same program, so a browser's sound, which comes from a process it started, goes with it. Everything but Zuna is the same process loopback the other way round: all that plays apart from Zuna's processes, which Chromium's own audio comes from. Process loopback needs Windows 10 version 2004 or later, and before that a share goes without sound and says so.

The picker lists an app while it has a stream open on Linux, or a session on Windows, which for most is while it plays, and on macOS while it plays. A window's app is offered while it's quiet as well, since its sound is taken from whenever it starts.

On Windows the program also answers one question that has nothing to do with sharing: `--notification-state` prints whether Windows wants quiet right now, and exits, since Node can't ask. The app draws its own notifications there, so they don't get the system's rules for full-screen apps, presentations and Do Not Disturb (`apps/desktop-electron-legacy/src/main/notifications.ts`). A build without the program shows notifications regardless.

On Linux it does the same for push to talk under Wayland, where nothing but the compositor sees a key held in another window. `--global-shortcuts` says whether the compositor has the global shortcuts portal and lets this app use it, and `--push-to-talk KEY` binds the key through it and says when it goes down and up, until the app closes its standard input (`src/shortcut.rs`, run by `apps/desktop-electron-legacy/src/main/global-key.ts`). The portal only gives a shortcut to an app it can name, by the .desktop file installed under the name of the systemd scope the app runs in, which Electron makes from `desktopName`: `zuna-legacy.desktop`. The .deb, .rpm and pacman packages install it, and an AppImage or a `.tar.gz` writes this person's own in `~/.local/share/applications` as it starts (`apps/desktop-electron-legacy/src/main/desktop-entry.ts`). A development build has none, so there push to talk is greyed out and says why, as it is where the compositor has no such portal.

It's told what to make of the picture on its command line, since none of that is secret: `--fps`, `--bitrate-kbps`, `--max-height`, `--no-cursor`, `--encoder`, `--quality`, on Linux `--source screen` or `--source window`, which the portal's dialog offers, and on Windows `--window` with a window's HWND.

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
| Sound: starting with it on, its quality | Captured beside the share by the program | yes, and by the program where there is one, as for a native share |
| Whose sound: everything but Zuna, or one app, starting from what's shared | Linux and Windows | Linux, macOS and Windows |
| How loud others' shares are, and whether one fills the stage when it starts | Those are for whoever's watching, however it was sent | |
| Capturing on the graphics card at all | yes | |
| Showing the pointer | yes | No: Chromium accepts `cursor: "never"` and goes on showing it, measured in Electron on Windows, so it isn't offered |
| Encoder, effort per frame | yes | |
| What it's mostly showing, what gives first when the connection can't keep up | | yes |
| Codec, and sending a smaller copy | No: H.264, one layer, since it arrives already encoded | yes |

A native share that can't do what was chosen doesn't fail: it goes through the browser, and stream stats says why.

**Making the picture smaller** happens on the GPU, keeping its shape and an even size:

| Route | How |
|---|---|
| Windows | D3D11's video processor, in `native/encoder.c`, which also makes NV12 for Media Foundation |
| Linux, NVENC from DMA-BUFs | An OpenGL blit, in `native/dmabuf_cuda.c` |
| Linux, VA-API | `scale_vaapi`, which the graph already had for its colours |
| NVENC or AMF from CPU memory, which is a compositor that can't share DMA-BUFs | It can't, so that share goes through the browser |
| Through the browser | `height: { max }` in `getDisplayMedia` |

**The encoder** is the one that goes with the graphics card driving the screen, unless another is chosen. On Linux that's NVENC on NVIDIA and VA-API otherwise. On Windows it's NVENC on NVIDIA, AMF on AMD, and on Intel or any other GPU Media Foundation's (`h264_mf`), which is whatever encoder the card's driver gives Windows, in hardware only. Media Foundation's encoders only take NV12, so D3D11's video processor converts each frame on the GPU, as BT.709 at studio range, on the way. Their streams say nothing of what colours they're in, so FFmpeg's `h264_metadata` filter writes that into each SPS, where NVENC and AMF write it themselves. A new one takes longer to open than NVENC: a window dragged for a second went out at 11 sizes rather than 27.

## From an iPhone or iPad

The iPhone app shares over its own connection to the room, as a share through the browser does, so to whoever's watching it's like any other. What captures the screen depends on the version of iOS:

| | Captured by | What can be chosen |
|---|---|---|
| iOS 27 and later | ScreenCaptureKit, in the app (`apps/ios/Zuna/Voice/VoiceRoom.swift`) | The whole screen, or Zuna alone, in the system's picker |
| iOS 18 to 26 | ReplayKit, in a broadcast upload extension (`apps/ios/ZunaBroadcast`) | The whole screen, from the system's broadcast picker or Control Center |

Before iOS 27, only an extension can see past the app. It's a process of its own, held to 50 MB, so it only records: LiveKit's `LKSampleHandler` hands each frame to the app over a socket in the App Group, and the app encrypts and sends it, so the room's keys never leave the app. LiveKit finds it by name, the app's bundle ID with `.broadcast`, in `group.` and the app's bundle ID. A broadcast can also start from Control Center, without the app asking. The app then asks the server for a place, as the button does, and LiveKit is told never to publish one by itself (`shouldPublishTrack`), so nothing goes out before the server has made room. The app tells the extension whether a call took the broadcast (`BroadcastSignal`). With a refusal, or no answer within 15 seconds, as when the app isn't in a call or isn't running, the extension ends the broadcast and the system says why, rather than recording for nobody.

On iOS 27 the extension is still there for a broadcast started from Control Center, but the button uses ScreenCaptureKit. The `screen-capture` background mode keeps that capture going while another app is on screen, and `audio` keeps the call going.

The picture goes out in H.264, in one layer, encoded in hardware, keeping its sharpness over its frame rate, with the server's terms (`Voice.screenTerms` in `ZunaModels`, as `screenTerms`). It always goes at the screen's own size, unless the server's admins hold shares to less, where the limit holds the screen's shorter side, which a phone held upright has across, as a computer's screen has its height. The most it may send is chosen in Voice and video's settings, from the desktop's choices, or left to the server. Its frame rate is the server's suggestion: ScreenCaptureKit on iOS picks its own, so that only holds the encoder.

Sound doesn't go with it. LiveKit's Swift SDK mixes a share's sound into the microphone's track, so it would go out whether the server allows a share's sound or not, at the person's own volume rather than a share's, and stop when they mute. So the app asks for a share without sound.

The simulator can't share at all, so the button isn't there. It has no ScreenCaptureKit on any version of iOS, and LiveKit's socket for the extension goes in the App Group's container, whose path has to fit in a socket's address, 104 bytes: on a device it takes 92, but the simulator's containers are deeper (`canShareScreen` in `VoiceRoom.swift`). Test builds share moving bars in place of the screen (`-ZunaFakeScreen`), past the picker, and `npm run test:ios:voice` checks that they reach the desktop app and decode there, on iOS 27 and 26 alike (`ZUNA_E2E_SIMULATOR` names a simulator on another iOS).

## Building it

```bash
npm run build:screenshare
```

On Windows and Linux this fetches a pinned FFmpeg build, checks its SHA-256, builds the program and gathers what it needs into `apps/screenshare/dist`, which `npm run dist` then packs into installers as a resource. Without it, the app shares through Chromium. Once it's built, `npm run dev` rebuilds it whenever its code changes, but the first build is always something to ask for.

**macOS** builds only the computer's sound, for Apple silicon, without FFmpeg or LiveKit, and needs Xcode's command line tools. Zuna isn't built for Intel Macs.

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

Whoever's watching decodes in Chromium, or in the web app's browser. On Linux, Chromium won't decode through VA-API on an NVIDIA GPU unless `VaapiOnNvidiaGPUs` is on, so the desktop app turns it on when it runs on Wayland (`apps/desktop-electron-legacy/src/main/index.ts`). That goes through nvidia-vaapi-driver, which NVIDIA doesn't ship, and where it isn't installed Chromium decodes in software as before. On X11 it stays off: there VA-API decodes every frame and paints each one white, seen on KDE through XWayland, both in the app and in a bare Electron page sending itself H.264. Measured in the app on Arch with KDE and an RTX 5080, at 1920x1080, a frame takes:

| Codec | Hardware | Software |
|---|---|---|
| H.264, every native share and most through the browser | 0.16 ms | 1.6 ms |
| VP8 | 0.2 ms | 2.0 ms |
| VP9 | 1.1 ms | 1.1 ms |
| AV1 | 0.4 ms | 0.9 ms |

Windows decodes in hardware without being asked, through D3D11. On Windows 11 with an RTX 5070 Ti, `voice-check.mjs` saw H.264 and VP9 decoded by `D3D11VideoDecoder`. Intel and AMD GPUs on Linux haven't been checked here. macOS does too, through VideoToolbox, measured on Apple silicon: H.264, H.265 and VP9 in hardware, and VP8, which Macs have no hardware for, and AV1, which only M3 and later do, in software.

On macOS a share through the browser is encoded on the GPU as well, through VideoToolbox, but only in H.264's Baseline profile: Chromium hands Constrained Baseline, which LiveKit takes by default, to OpenH264 in software, even at 720p. So LiveKit is set to take Baseline too (`LIVEKIT_CONFIG` in `scripts/lib.mjs`, and the same in `deploy/`), which Chromium offers first. Those watching who only declare Constrained Baseline, as the iPhone app does, get the same stream, which they decode. Sending a smaller copy as well, or layers in time, goes back to OpenH264, as Chromium won't encode H.264 simulcast on VideoToolbox. A server set up by hand without that, or not updated since, sends shares from a Mac in software, and the stream stats window says so. Cameras on the desktop go out in VP8, in software everywhere, as their three layers would lose hardware in H.264 too.

## Frame rate

What's sent depends on the screen changing: a still screen gets half a second at the full rate, for the encoder to sharpen it, and then a trickle, a frame every 120 ms. libwebrtc counts a frame that comes 150 ms later than they've been coming as a freeze, so a trickle of one every 200 ms made each still moment five freezes in the stream stats of whoever was watching. These are from Windows at 2560x1440 on a 240 Hz monitor, with something moving on the screen and 60 fps asked for:

| Route | Captured | Sent | Decoded by someone watching |
|---|---|---|---|
| Native, NVENC, over TLS | 60 | 60 | 60 |
| Chromium, OpenH264 | 57 | 57 | 57 |

Windows drops a frame that arrives inside its minimum interval, and at the screen's own refresh rate that's a lot of them: asking for 239 fps on that monitor got 208, and asking for half the interval got 239. So it asks for half the interval, and the program waits for each frame's turn itself.

On both systems a frame comes a little unevenly, so the last one is only repeated once an interval longer than usual has gone by without a new one. Without that, a repeat went out just before each late frame. On Windows the late frame then waited for the next turn, by which time a newer one had taken its place: a video playing at 60 fps went out as 30 new frames and 30 repeats, each new one 33.3 ms after the last, which someone watching saw as the picture stepping back to the frame before.

On Linux it asks the compositor for exactly the frame rate, since KWin keeps to that with a timer rather than the screen's refreshes, and it can't wait for a turn without holding on to the compositor's buffer. It asked for a quarter more until KWin was measured, which made it drop every fifth frame, so frames went out unevenly. Measured on KDE with something moving at 360 fps, frames going to the encoder:

| Screen, asked for | A quarter more | Exactly |
|---|---|---|
| 165 Hz, 30 fps | 33.3 ms apart, ±11.4 | 33.3 ms, ±0.1 |
| 165 Hz, 60 fps | 16.7 ms, ±5.8 | 16.7 ms, ±0.2 |
| 360 Hz, 30 fps | 33.3 ms, ±11.4 | 33.3 ms, ±0.3 |
| 360 Hz, 60 fps | | 16.7 ms, ±0.2 |

Someone watching a 30 fps share saw ±11.7 ms before, and ±5.3 after, as much as through the browser. A compositor that sends frames ahead of their turn still has those left out, and the stream stats window says how many, and how evenly frames come from the compositor.

Chromium needs asking as well. Without a frame rate in `getDisplayMedia` it captures at 30, and LiveKit leaves the frame rate out when the size is the screen's own, so `voice/room.ts` passes it itself.

Chromium's fake capture runs at 20 fps. `--use-fake-ui-for-media-stream` swaps it in for a screen even when a real one was chosen, so measuring with that flag only measures the fake.

## Bitrate and keyframes

libwebrtc estimates what the network takes, and the program follows it up to the bitrate asked for, starting at 3 Mbit/s. Every change costs a keyframe, as FFmpeg resets NVENC to make it and the other encoders only take a bitrate when opened, and someone watching waits for each keyframe. So `Bitrate::follow` in `src/pipeline.rs` ignores changes under a quarter. A fall goes 2 seconds after the last change, or at once if it's to 60% or less. A rise goes 2 seconds after the last while the bitrate is first climbing, since libwebrtc only raises its estimate a little past what's sent.

Once it has had to fall, a rise is a guess. libwebrtc lets its estimate run to half as much again as what's sent, so it goes on offering more than the link has just taken: a share from Windows that had fallen to 32 Mbit/s was offered 47. Rising after each pause, a share from Windows at a 40 Mbit/s cap changed its bitrate 24 times in about two minutes, and rising with the next regular keyframe instead, within 10 seconds, someone watching saw its picture stop for about half a second, often. So a rise now waits 30 seconds after the last change, and twice as long again after each one that had to fall back within 30 seconds, up to 4 minutes, until one holds. On a link that takes 40 Mbit/s, with a 100 Mbit/s cap and an estimate that behaves so, the tests count 17 keyframes in ten minutes and 10 seconds of sending more than the link takes, where that rule made 105 and 98.

Otherwise a keyframe only goes when it's needed: when libwebrtc asks for one, for someone who joins or can't decode, at a new size, and with a new bitrate. There's no regular one, as each is a burst someone watching waits for, of up to a quarter of a second of the bitrate, and nothing needs it. The encoder's own come at most every minute's worth of frames. The legacy desktop app still asks for one, every 10 seconds unless it's set otherwise, with `--keyframe-seconds`, counted from the last keyframe of any kind.

How big a keyframe may be is the VBV, a quarter of a second of the bitrate (`vbv_size` in `native/encoder.c`). Measured with NVENC on an RTX 5080, on 2560x1440 of code that stood still and then scrolled, a keyframe took 128 ms of the bitrate at 15 Mbit/s and 107 ms at 40. A tenth of a second made those 78 and 75 ms, but cost a keyframe 4 to 5 dB of PSNR at 15 Mbit/s, which blurs text, so it stays a quarter.

## What hasn't been checked

The proof of concept's README lists what has run where. Inside the app, Windows and Linux with NVENC have run so far:

- **Linux** has run from the app on Arch with KDE and an RTX 5080, over KRdp with its screen at 1920x1080, publishing over TLS to apps watching: NVENC from DMA-BUFs, 60 fps sent and 60 decoded at 2.3 ms a frame and 4% of a core, and 30 fps asked for gave 30.0. KWin offers any size from 200x200 to 10000x10000 with its screen's own as the default (seen in `pw-dump`), and scales to whatever's taken. PipeWire takes the consumer's default when the range allows it, so the program offers no size at all and gets the screen's own. Until it did, it offered 1920x1080. Since then, `voice-check.mjs` has shared a 2560x1440 screen natively at its own size.
- **VA-API and AMF** have never run. **Media Foundation** has only run on NVIDIA's own encoder for it, on an RTX 5070 Ti: from the app in `voice-check.mjs` with `VOICE_ENCODER=h264_mf`, a screen at 60 fps over TLS, under a new key, and a window at 60 fps, until that run was stopped partway; by itself, a screen made smaller, a window dragged, and colours within 2 of 255 of what was drawn, as NVENC's are. Intel's and other GPUs' haven't, nor has one of a laptop's two GPUs.
- **Making the picture smaller** has run natively on Windows with NVENC, at 1280x720 from 2560x1440 at about 3.5% of a core, and on Linux with NVENC from DMA-BUFs through the OpenGL blit, at 1280x720 from 1920x1080 and 60 fps, 1.4 ms a frame and 4% of a core. VA-API's `scale_vaapi` has never run.
- **Effort per frame** has been run at each end on Windows with NVENC, where it costs little at these sizes. Nobody has compared the pictures.
- **Leaving the pointer out natively** asks Windows and the portal to. Through KDE's portal it works: with the pointer over the tab bar, a frame someone watching received showed it with the pointer on, and not with it off. On Windows 11 it works too: with the pointer still over text, a frame encoded by NVENC showed its I-beam with the pointer on, and not with `--no-cursor`.
- **Sharing a window natively** has run on Linux with KWin, in the app on Arch with an RTX 5080: a 908x634 window at 60 fps from DMA-BUFs, the one app's sound chosen for it reaching someone watching, its picture following it to 1288x534 at once, and the share ending quietly as it closed. GNOME, wlroots compositors and Hyprland haven't run it. One that kept a window's stream at one size and marked the window in it as `SPA_META_VideoCrop` would need that read, which the program doesn't ask for. On Windows 11 with an RTX 5070 Ti it has run from the app in `voice-check.mjs`: a 222x181 window at 60 fps over TLS, decoded at 60 by someone watching. By itself, to a file: a window that grew, at once and while dragged, made smaller to 360 lines, and the program leaving as it closed.
- **The computer's sound on Linux** has run from the app beside a share through the browser, in `apps/desktop-electron-legacy/test/sound-check.mjs` on Arch with KDE, PipeWire 1.6 and EasyEffects, and by itself against a player linked straight to a sink without EasyEffects. Beside a native share, one app's sound has run with a window shared through KDE's portal, and the entire system's beside a native screen in `voice-check.mjs`. The same check shares a window on X11, whose app's sound is chosen and sent by itself, and checks that a screen starts with everything.
- **The computer's sound on macOS** has run from the app beside a share through the browser, in `apps/desktop-electron-legacy/test/mac-sound-check.mjs` on macOS 27 on Apple silicon: everything but Zuna, one app alone, and the picker's apps. What it shares is a moving picture standing in for the screen, as macOS's own picker can't be driven, so a real screen with its sound hasn't been seen together. The program by itself has also taken another program's speech while leaving out the app that started it, and its tone, and Apple's converter has taken 44.1 kHz to 48 kHz in a test. An output at another rate, and a change of output during a share, haven't run.
- **The computer's sound on Windows** has run from the app in `apps/desktop-electron-legacy/test/win-sound-check.mjs` on Windows 11 (build 26300), beside a native share and one through the browser: everything but Zuna, with Zuna's own tone 46 dB under another app's, one app alone, the picker's apps, and a window starting with its app's. Its tones are at -60 dBFS, so that nobody hears them, and told apart by frequency. They play to the default output, and an app playing to another hasn't been tried.
- **Real networks:** a pre-encoded stream has one layer, so a viewer on a slow connection can't be dropped to a lower quality. How the bitrate follows a real link with no regular keyframes, and rises that wait longer after each that was too much, has only run against the tests' model of libwebrtc's estimate, not in a call.
