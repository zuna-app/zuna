# Native screen sharing

The desktop app shares a whole screen or one window natively on every system, in its own process, from its own connection to the room. On Windows and Linux its `zuna-screenshare` crate (`apps/desktop/screenshare`) captures and encodes on the GPU, in H.264, or in AV1 as an experiment ([AV1](#av1)), and LiveKit only carries the result. On macOS the app captures through ScreenCaptureKit, picked in macOS's own picker, and VideoToolbox encodes it. Viewers decode in the app, or in the web app's browser.

```
Windows.Graphics.Capture ─┐                       ┌─ NVENC, AMF, Media Foundation ─┐
                          ├─ zuna-screenshare ────┤                                ├─ the app's own LiveKit connection ─ encrypted ─ media server ─ viewers
xdg portal and PipeWire ──┘                       └─ NVENC, VA-API ────────────────┘   (pre-encoded mode)

macOS's picker ─ ScreenCaptureKit ─ IOSurfaces ─ VideoToolbox ─ the app's own LiveKit connection ─ encrypted ─ media server ─ viewers
```

This exists because screen sharing through Chromium is poor on Linux: it reads every frame back to the CPU with `glReadPixels`, and has no supported hardware encoder there. [What the proof of concept measured](#what-the-proof-of-concept-measured) has the numbers. A 2560x1440 share at 60 fps takes about 5% of a core on the sender.

Only the web app goes through the browser's capture. The native app has no browser to fall back on: where a share can't start, it says why. It doesn't run under X11 at all. On Macs the crate only takes the computer's sound, beside the app's own capture, as [Sharing from a Mac](#sharing-from-a-mac) says. Every share in H.264 looks the same to whoever is watching, and one in AV1 only the native app can open. The iPhone and iPad share through LiveKit's Swift SDK, as [From an iPhone or iPad](#from-an-iphone-or-ipad) says.

## How the app runs it

Once the server has made room for the share, the app starts it on a thread of its own (`Share` in `apps/desktop/screenshare/src/lib.rs`, started from `apps/desktop/src/voice/screen/`), with what to make of the picture in `Options`. It opens the capture and the encoder, which on Linux waits for the portal's dialog, and says what it's capturing and at what size. The app then publishes an H.264 or AV1 track of that size from its own connection, in LiveKit's pre-encoded mode, and hands the share an `Output` (`LiveKitOutput`), which takes each encoded frame to LiveKit and brings LiveKit's requests for keyframes and its estimate of the network back to the encoder. It reports how it's going once a second, and stops when the app stops it, or by itself when what was shared goes, with what went wrong if anything did. If it doesn't start, the app says why. The stream stats window, the button at the top of a voice channel, has everything the share reports once it's going, frame by frame, for whoever is sending and whoever is watching.

The track goes out under the device's own key, as its microphone does, so it follows the room's keys with the rest of what the device sends, and viewers open it with no more help than that. It's named `screen`, which tells them it came from the desktop app: a browser's and the iPhone's are `screen_share`. A crash in a graphics driver or in FFmpeg now takes the app with it, where it used to end only the share.

The computer's sound can't come with its pictures. The app captures it apart and publishes it alongside, as [The computer's sound](#the-computers-sound) says.

## Choosing what to share on Linux

Under Wayland, nothing but the portal's dialog can say what there is to share, so the picker in the app offers one of each kind the ScreenCast portal says it shares, which the app asks the portal itself (`apps/desktop/src/platform/linux/screens.rs`), a screen or a window, with an icon in place of a picture, and the portal's own dialog picks once Share is pressed, as the share starts capturing. Where there's no portal, there's nothing to offer.

The portal only says whether a screen or a window was chosen, and the share says the same once it's capturing. A window can change size: PipeWire settles on the new size, and the share opens another encoder at it, keeping to the tallest that was asked, with a keyframe, so someone watching sees it at its new size at once. When the window closes, the compositor takes its PipeWire node away, which the share hears from PipeWire's registry, the same on every compositor, and it stops, so it ends without a word.

## Sharing a window on Windows

The picker lists windows itself on Windows (`apps/desktop/src/platform/windows/screens.rs`), with ids of the form `window:<HWND>:0`, and the share is given that HWND in `Options`. Windows.Graphics.Capture captures it from `CreateForWindow`, with its menus and popups from Windows 11 24H2, and the GPU is the one driving the screen it's mostly on.

It follows a window's size as Linux does: another encoder at the new size, keeping to the tallest that was asked, with a keyframe. A frame fills its pool's textures from the top left, so the pool is made as large as the window's screen, and only needs making again when a window grows past that. Dragging a window's edge then changes the size on almost every frame, and each goes out at its own size: measured with NVENC, a new encoder takes about 4 ms, and 28 of 30 fps went out while dragging. A screen whose resolution changes is followed the same way, where it used to end the share.

When the window closes, the share stops and ends without a word. `GraphicsCaptureItem.Closed` never fires for a window here, since the share's thread has no dispatcher queue, so it looks for the window itself while it waits for frames.

## The computer's sound

A share's sound goes out over the device's own connection, beside the picture, whichever way the picture goes:

| | Captured by | What can be chosen |
|---|---|---|
| Windows | The app, through process loopback (`screenshare/src/sound/windows.rs`): everything but Zuna's processes, or one app's | Everything but Zuna, or one app |
| Linux | The app, from PipeWire (`screenshare/src/sound/linux.rs`) | Everything but Zuna, or one app |
| macOS, on Apple silicon | The app, through Core Audio's process taps (`screenshare/src/sound/macos.rs`), from macOS 14.2 | Everything but Zuna, or one app |
| The web | The browser | Whatever its own picker offers |

`Sound::start` in `screenshare/src/sound/mod.rs` takes everything playing apart from the app's own process and those it started, or only one app's, by the id `sound::apps` or `sound::window_app` gives it. `pid:N` is a process and those it started.

What a share starts with follows what's shared: a screen, everything but Zuna, and a window, the sound of the app it belongs to. Windows and X11 say which process a window belongs to, which `sound::window_app` asks, so its sound is taken from that process and those it started. Wayland's portal doesn't, on any compositor, and the Electron app got no title or icon for a window chosen through it either (seen on KDE: `window:1:0:s`, with no name). So there a window starts with no sound, and the picker says to choose the app whose sound goes with it, from those playing now and the one chosen last. macOS's picker only says which window once Share is pressed, so a window starts with no sound there too. Settings' "Include audio" turns all of it off, and whatever's chosen in the picker holds until another source is.

On Linux, PipeWire has no stream of everything but one program, so the app makes a stream of its own that nothing connects to, and links each app's output into it as apps start and stop playing. The sound is taken as it leaves each app, after the app's own volume and before the system's, so where an app plays to makes no difference: speakers, headphones, or something like EasyEffects in between. Zuna's own sound plays from the app's process, so it's left out, and nobody in the call hears themselves back. The links belong to the share's own connection to PipeWire, and go when it closes.

The app starts it (`start_sound` in `apps/desktop/src/voice/screen/mod.rs`), on a thread of its own, which says once it's listening and then hands over only sound: 32-bit floats, two channels interleaved at 48 kHz, and only while something plays, which the app hands to the published track 10 ms at a time. That keeps 40 ms in hand, more when PipeWire hands over larger pieces, and drops what piles up past 150 ms more, so the sound doesn't fall behind the picture.

On macOS Core Audio's process taps take everything but a list of processes, or a mix of a few. The app reads one through a private aggregate device clocked by the output, and Apple's converter takes it to 48 kHz where the output runs at another rate. A process that starts later isn't in a tap, and macOS won't change one that's being read, so it makes a new one when Zuna's processes, the chosen app's, or the output change, which misses a moment of sound at most. The first capture asks the person whether Zuna may record the computer's sound (`NSAudioCaptureUsageDescription`), and the app waits 10 seconds for the answer before the share goes on without its sound. Without permission, macOS hands over silence rather than an error. An app is the process macOS holds responsible for another, so a browser's helpers go with it, and it's named after its bundle. Only Apple silicon is built for; on an Intel Mac a share's sound isn't offered.

On Windows an app is the first process of its program, found by walking up from the one with sound while the parent is the same program, so a browser's sound, which comes from a process it started, goes with it. Everything but Zuna is the same process loopback the other way round: all that plays apart from Zuna's processes, which Chromium's own audio comes from. Process loopback needs Windows 10 version 2004 or later, and before that a share goes without sound and says so.

The picker lists an app while it has a stream open on Linux, or a session on Windows, which for most is while it plays, and on macOS while it plays. A window's app is offered while it's quiet as well, since its sound is taken from whenever it starts.

What to make of the picture is in `Options` (`screenshare/src/capture/mod.rs`): the frame rate, the most it may send, the tallest it may be, the pointer, the encoder and the effort each frame gets, which the app leaves at Balanced, on Linux a screen or a window, which the portal's dialog offers, and on Windows the screen at a point on the desktop or a window's HWND.

## What a server says, and what a device chooses

Everything a share uses comes from what the person chose on this device, in Settings, Screen sharing, held to the server's limits. Resolution starts at the screen's own and the frame rate at 60. The bitrate is left to the app unless someone picks one: up to 20 Mbit/s (`SCREEN_AUTO_KBPS`), or the server's limit where that's lower, and the share sends less whenever the picture or the network needs less ([Bitrate and keyframes](#bitrate-and-keyframes)). The sound goes at 128 kbit/s. `screenTerms` in `packages/core/src/voice.ts` works it out, and the stream stats window says which limits it was held to. Servers used to suggest a size, frame rate and bitrate, and limit the sound's bitrate, and devices chose the sound's bitrate, what a share was showing and what gave first, until 2026-11-09: nobody could tell those apart, so the apps pick them.

**Server settings, Screen sharing,** for its admins. These are kept together in the `screen_share` setting and reach every app as part of `ServerInfo`:

| Rule | Held by |
|---|---|
| Who can share: everyone, admins or nobody | The media server |
| Whether sound can go with a share | The media server |
| How many can share at once, in a voice channel and on the server | The server, then the media server |
| Each voice channel's own say, when it's edited: off, or how many at once | The server, then the media server |
| The max resolution, frame rate and bitrate | The apps |
| Whether admins bypass the limits and how many at once | Both of those |

The first group holds whatever an app does. The token for coming into a voice channel doesn't allow a screen at all. To share, a device asks `POST /api/channels/{id}/voice/screen`, which keeps a place for it if the rules allow one. Only then is LiveKit told to let that device's own connection publish a screen. LiveKit refuses anything else, and takes down what's already going when that's revoked. Only `user.device` comes into a room: there's no participant of a share's own, as the desktop's separate program was until 2026-11-09, and the apps let none in.

So a share ends when it's stopped, when the device leaves the channel or makes a new connection, when an admin stops it, and when the rules stop allowing it. Limits on how many only hold for those starting after them.

The second group can't be held that way. The picture is encrypted and LiveKit doesn't check the rate of what it's sent, so the apps keep to these themselves, and a modified app could send more. A share already going keeps what it started with. Anyone worried about their bandwidth bill should also look at LiveKit's own `limit` settings, which apply to the whole media server.

**Settings, Screen sharing,** on each device:

| Setting | Native | The web app |
|---|---|---|
| Resolution, frame rate, max bitrate | yes | yes |
| Include audio | Captured beside the share by the app | yes, where the browser's picker gives audio |
| Whose audio: everything but Zuna, or one app, starting from what's shared | In the picker, on Linux, macOS and Windows | |
| Screen share volume, and whether one opens when it starts | Those are for whoever's watching, however it was sent | |
| Show cursor | yes | No: Chromium accepts `cursor: "never"` and goes on showing it, measured on Windows, so it isn't offered |
| Encoder and codec, under Advanced | On Windows and Linux: H.264, or AV1 as an experiment ([AV1](#av1)) | |

The rest is fixed. Native shares encode at the effort Balanced (`p4` on NVENC), in one layer, since they arrive already encoded. The web app has no picker of its own: Share opens the browser's, which asks what to share and whether with its audio. It sends H.264 where the browser can and VP8 otherwise, tells the browser it's showing detail (`contentHint`), keeps its resolution when the connection can't keep up, and sends one layer.

A native share that can't do what was chosen doesn't start, and the app says why.

**Making the picture smaller** happens on the GPU, keeping its shape and an even size:

| Route | How |
|---|---|
| Windows | D3D11's video processor, in `native/encoder.c`, which also makes NV12 for Media Foundation |
| Linux, NVENC from DMA-BUFs | An OpenGL blit, in `native/dmabuf_cuda.c` |
| Linux, VA-API | `scale_vaapi`, which the graph already had for its colours |
| NVENC or AMF from CPU memory, which is a compositor that can't share DMA-BUFs | It can't, so that share doesn't start, and says why |
| macOS | ScreenCaptureKit, which captures it no larger than asked |
| The web app | `height: { max }` in `getDisplayMedia` |

**The encoder** is the one that goes with the graphics card driving the screen, unless another is chosen. On Linux that's NVENC on NVIDIA and VA-API otherwise. On Windows it's NVENC on NVIDIA, AMF on AMD, and on Intel or any other GPU Media Foundation's (`h264_mf`), which is whatever encoder the card's driver gives Windows, in hardware only. Media Foundation's encoders only take NV12, so D3D11's video processor converts each frame on the GPU, as BT.709 at studio range, on the way. Their streams say nothing of what colours they're in, so FFmpeg's `h264_metadata` filter writes that into each SPS, where NVENC and AMF write it themselves. A new one takes longer to open than NVENC: a window dragged for a second went out at 11 sizes rather than 27. AV1 goes through the same four, as `av1_nvenc`, `av1_amf`, `av1_mf` and `av1_vaapi`, with the same choice of encoder in Settings, and `av1_metadata` in place of `h264_metadata`. NVENC encodes in VBR held to the bitrate, H.264 with a target quality ([Getting more out of H.264](#getting-more-out-of-h264)), and the others in CBR.

## Sharing from a Mac

On macOS the app shares through the system, with no Screen Recording permission (`apps/desktop/src/platform/macos/screen_capture.rs`, `start_screen_here` in `apps/desktop/src/voice/screen/share.rs`). macOS's own picker chooses a screen or a window, ScreenCaptureKit captures it on the GPU into IOSurfaces in NV12, already no larger than asked, and each frame goes to LiveKit as it was captured for VideoToolbox to encode, from the device's own connection, as on Windows and Linux. Only Apple silicon, from macOS 14.2, is built for. The share's sound comes from `zuna-screenshare`, as on Windows and Linux, as [The computer's sound](#the-computers-sound) says, and video that arrives is decoded by VideoToolbox and drawn from its buffer. A test build can share moving bars in place of a screen, past the picker, with `ZUNA_FAKE_SCREEN`, which `apps/desktop/test/mac-voice-check.mjs` uses.

## From an iPhone or iPad

The iPhone app shares over its own connection to the room, as a share through the browser does, so to whoever's watching it's like any other. What captures the screen depends on the version of iOS:

| | Captured by | What can be chosen |
|---|---|---|
| iOS 27 and later | ScreenCaptureKit, in the app (`apps/ios/Zuna/Voice/VoiceRoom.swift`) | The whole screen, or Zuna alone, in the system's picker |
| iOS 18 to 26 | ReplayKit, in a broadcast upload extension (`apps/ios/ZunaBroadcast`) | The whole screen, from the system's broadcast picker or Control Center |

Before iOS 27, only an extension can see past the app. It's a process of its own, held to 50 MB, so it only records: LiveKit's `LKSampleHandler` hands each frame to the app over a socket in the App Group, and the app encrypts and sends it, so the room's keys never leave the app. LiveKit finds it by name, the app's bundle ID with `.broadcast`, in `group.` and the app's bundle ID. A broadcast can also start from Control Center, without the app asking. The app then asks the server for a place, as the button does, and LiveKit is told never to publish one by itself (`shouldPublishTrack`), so nothing goes out before the server has made room. The app tells the extension whether a call took the broadcast (`BroadcastSignal`). With a refusal, or no answer within 15 seconds, as when the app isn't in a call or isn't running, the extension ends the broadcast and the system says why, rather than recording for nobody.

On iOS 27 the extension is still there for a broadcast started from Control Center, but the button uses ScreenCaptureKit. The `screen-capture` background mode keeps that capture going while another app is on screen, and `audio` keeps the call going.

The picture goes out in H.264, in one layer, encoded in hardware, keeping its sharpness over its frame rate, with the server's terms (`Voice.screenTerms` in `ZunaModels`, as `screenTerms`). It always goes at the screen's own size, unless the server's admins hold shares to less, where the limit holds the screen's shorter side, which a phone held upright has across, as a computer's screen has its height. Its max bitrate is chosen in Voice and video's settings, from the desktop's choices, or left to the app, as on the desktop. Its frame rate is 60, or the server's limit: ScreenCaptureKit on iOS picks its own, so that only holds the encoder.

Sound doesn't go with it. LiveKit's Swift SDK mixes a share's sound into the microphone's track, so it would go out whether the server allows a share's sound or not, at the person's own volume rather than a share's, and stop when they mute. So the app asks for a share without sound.

The simulator can't share at all, so the button isn't there. It has no ScreenCaptureKit on any version of iOS, and LiveKit's socket for the extension goes in the App Group's container, whose path has to fit in a socket's address, 104 bytes: on a device it takes 92, but the simulator's containers are deeper (`canShareScreen` in `VoiceRoom.swift`). Test builds share moving bars in place of the screen (`-ZunaFakeScreen`), past the picker, and `npm run test:ios:voice` checks that they reach the desktop app and decode there, on iOS 27 and 26 alike (`ZUNA_E2E_SIMULATOR` names a simulator on another iOS).

## Building it

It's built with the app, as a crate of the app's workspace (`apps/desktop/screenshare`), and needs nothing beyond what the app does. On Windows and Linux its build script compiles the encoder, `native/encoder.c`, as a library of its own against the FFmpeg the repository pins, and gathers it with FFmpeg's libraries into `lib` beside the app, from where the app loads it and the packages carry it (`npm run dist:windows`, `npm run dist:linux`). The app's scripts fetch that FFmpeg and check its SHA-256 before building, as `node scripts/ffmpeg.mjs` does by itself, into `apps/desktop/.deps` (`FFMPEG_DIR` in `apps/desktop/.cargo/config.toml`). They fetch LiveKit's `webrtc-sys` there too, with the patch AV1 needs ([AV1](#av1)), as `node scripts/webrtc-sys.mjs` does, without which the app's workspace won't load.

The crate needs neither LiveKit nor GPUI, so its Linux and macOS code can be checked from any system, as long as the target's standard library is there (`rustup target add`), and the patched `webrtc-sys` has been fetched for the workspace:

```bash
cd apps/desktop && ZUNA_CHECK_ONLY=1 cargo check -p zuna-screenshare --target x86_64-unknown-linux-gnu
```

**macOS** builds only the computer's sound, for Apple silicon, without FFmpeg. Zuna isn't built for Intel Macs.

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

`apps/desktop/test/key-log-check.mjs` shares the first screen, or a window, through the crate and LiveKit with someone watching, in `examples/share-check.rs`, and fails unless they decoded what was shared, as well as if the key turns up in the log. `ZUNA_SHARE_CODEC=av1` has it share in AV1. `apps/desktop/test/codec-check.mjs` runs the same in H.264 and then in AV1, with watchers from the start, late, with another key and without encryption, and compares them, and `screenshare/examples/codec-bench.rs` compares their pictures on a scene of its own ([AV1](#av1)).

## Watching

Whoever's watching in the native app decodes through LiveKit's libwebrtc, and on macOS draws what VideoToolbox decoded straight from its buffer. Whoever's watching in the web app decodes in their browser. On Linux, Chromium won't decode through VA-API on an NVIDIA GPU unless `VaapiOnNvidiaGPUs` is on, which the Electron app turned on under Wayland. That goes through nvidia-vaapi-driver, which NVIDIA doesn't ship, and where it isn't installed Chromium decodes in software as before. On X11 it stays off: there VA-API decodes every frame and paints each one white, seen on KDE through XWayland, both in the app and in a bare Electron page sending itself H.264. Measured in the app on Arch with KDE and an RTX 5080, at 1920x1080, a frame takes:

| Codec | Hardware | Software |
|---|---|---|
| H.264, every native share and most through the browser | 0.16 ms | 1.6 ms |
| VP8 | 0.2 ms | 2.0 ms |
| VP9 | 1.1 ms | 1.1 ms |
| AV1 | 0.4 ms | 0.9 ms |

Windows decodes in hardware without being asked, through D3D11. On Windows 11 with an RTX 5070 Ti, `voice-check.mjs` saw H.264 and VP9 decoded by `D3D11VideoDecoder`. The native app's libwebrtc decodes in software on Windows: H.264 through its own FFmpeg and AV1 through dav1d, which at 1602x932 and 60 fps took 1.1 and 1.5 ms a frame, and 13 and 18% of a core of a Ryzen 7 9800X3D, in `codec-check.mjs` ([AV1](#av1)). Intel and AMD GPUs on Linux haven't been checked here. macOS does too, through VideoToolbox, measured on Apple silicon: H.264, H.265 and VP9 in hardware, and VP8, which Macs have no hardware for, and AV1, which only M3 and later do, in software.

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

libwebrtc estimates what the network takes, and the share follows it up to the bitrate asked for, starting at 3 Mbit/s. Every change costs a keyframe, as FFmpeg resets NVENC to make it and the other encoders only take a bitrate when opened, and someone watching waits for each keyframe. So `Bitrate::follow` in `src/pipeline.rs` ignores changes under a quarter. A fall goes 2 seconds after the last change, or at once if it's to 60% or less. A rise goes 2 seconds after the last while the bitrate is first climbing, since libwebrtc only raises its estimate a little past what's sent.

Once it has had to fall, a rise is a guess. libwebrtc lets its estimate run to half as much again as what's sent, so it goes on offering more than the link has just taken: a share from Windows that had fallen to 32 Mbit/s was offered 47. Rising after each pause, a share from Windows at a 40 Mbit/s cap changed its bitrate 24 times in about two minutes, and rising with the next regular keyframe instead, within 10 seconds, someone watching saw its picture stop for about half a second, often. So a rise now waits 30 seconds after the last change, and twice as long again after each one that had to fall back within 30 seconds, up to 4 minutes, until one holds. On a link that takes 40 Mbit/s, with a 100 Mbit/s cap and an estimate that behaves so, the tests count 17 keyframes in ten minutes and 10 seconds of sending more than the link takes, where that rule made 105 and 98.

Otherwise a keyframe only goes when it's needed: when libwebrtc asks for one, for someone who joins or can't decode, at a new size, and with a new bitrate. There's no regular one, as each is a burst someone watching waits for, of up to a quarter of a second of the bitrate, and nothing needs it. The encoder's own come at most every minute's worth of frames. The legacy desktop app still asks for one, every 10 seconds unless it's set otherwise, with `--keyframe-seconds`, counted from the last keyframe of any kind.

How big a keyframe may be is the VBV, a quarter of a second of the bitrate (`vbv_size` in `native/encoder.c`). Measured with NVENC on an RTX 5080, on 2560x1440 of code that stood still and then scrolled, a keyframe took 128 ms of the bitrate at 15 Mbit/s and 107 ms at 40. A tenth of a second made those 78 and 75 ms, but cost a keyframe 4 to 5 dB of PSNR at 15 Mbit/s, which blurs text, so it stays a quarter. NVENC's H.264 with its target quality goes a little over it: in `codec-bench.rs` its keyframes took 109 to 124% of the VBV, where they'd taken 73 to 78% before.

## AV1

AV1 is an experiment, chosen in Settings, Screen sharing, Codec, on Windows and Linux. The share's own encoders encode it ([What a server says, and what a device chooses](#what-a-server-says-and-what-a-device-chooses)), where the graphics card has AV1, and where it doesn't, the share doesn't start and says to try H.264. Only the native app can watch it: the web app and the iPhone and iPad app can't open AV1 under encryption, so a share in AV1 shows them nothing. A Mac can't send it, as VideoToolbox has no AV1 encoder, but the app there should open one, through the same patched `webrtc-sys`.

### Under encryption

LiveKit's frame cryptor encrypts every byte of an AV1 frame, where it leaves H.264's NAL headers and VP8's first bytes out, and libwebrtc's AV1 packetizer then reads that ciphertext as OBUs. Most frames don't parse and are dropped, and the first byte of the rest is rewritten on the way, so they don't decrypt. Nor does anything ever see a keyframe: libwebrtc marks one only where a sequence header comes first, and LiveKit's server only where a frame header after that says so (`IsAV1KeyFrame` in LiveKit's `mediatransportutil`), and the server forwards a share to someone who comes later only from a keyframe. LiveKit's JS SDK refuses AV1 under encryption for this.

So the app builds LiveKit's `webrtc-sys` with a patch of Zuna's (`apps/desktop/patches/webrtc-sys.patch`, applied by `scripts/webrtc-sys.mjs`), which for AV1 alone puts what the cryptor makes inside OBUs of its own once it's encrypted, and takes it back out before the cryptor opens it:

```
keyframe   [sequence header] [frame header] [metadata 30: the ciphertext]
otherwise  [metadata 30: the ciphertext]
```

The first two are markers with nothing of the picture in them, which say only that it's a keyframe, as RTP's own header does. Every OBU carries its size, so the packetizer and the depacketizer take them apart and put them back as they were. The cryptor, its keys and how it encrypts are LiveKit's own, unchanged, and other codecs pass the envelope by. An app without the patch, as every browser and the iPhone are, can't open it.

`codec-check.mjs` shares the same window in each codec through LiveKit, with a native watcher in a process of its own. On Windows 11 with an RTX 5070 Ti and a Ryzen 7 9800X3D, from a release build, sharing FFmpeg's moving `testsrc2` in a 1602x932 window at 60 fps with up to 8 Mbit/s, for 30 seconds:

| | H.264 | AV1 |
|---|---|---|
| Encoder | `h264_nvenc` | `av1_nvenc` |
| Sent | 59.9 fps, 7.73 Mbit/s | 60.0 fps, 7.74 Mbit/s |
| Encoding a frame | 1.73 ms | 1.52 ms |
| The sender's CPU | 4.8% of a core | 4.0% of a core |
| The watcher's decoder | libwebrtc's FFmpeg, in software | dav1d, in software |
| Decoding a frame | 1.12 ms | 1.46 ms |
| The watcher's CPU | 12.9% of a core | 18.0% of a core |
| Freezes, keyframes asked for | none | none |
| A watcher 3 seconds late | decoded | decoded |
| A watcher with another key | nothing | nothing |
| A watcher without encryption, as the media server is | 8 frames of what it couldn't open | nothing |

H.264 leaves its SPS, PPS and NAL headers out of the encryption, so a decoder without the key makes a few frames of what it can't open, flat in one run and noise in another; nothing of AV1 is left out, and nothing comes of it. Media Foundation's `av1_mf`, NVIDIA's own, has run the same way, made smaller to 720 lines on the GPU on the way.

### Against H.264

`screenshare/examples/codec-bench.rs` encodes the same scene in both through the share's own encoder, at several bitrates, and measures what comes out against what went in, with the FFmpeg the repository pins. The scene is drawn by the program, the same each time, as a screen looks: code in an editor that scrolls for a quarter of it, stands still for a sixth or so with its caret blinking, has a video playing in a corner, has a window dragged across it, and last is a full screen game, a detailed landscape that the camera pans across. What's counted is what a share sends: H.264 after `h264.rs` has taken out NVENC's filler and SEI, and AV1 without the temporal delimiters and padding LiveKit takes out. PSNR and SSIM are in luma, on the picture the encoder was given made 4:2:0 with the matrix the streams say they're in, since in RGB what 4:2:0 loses of coloured text, the same for both, held both under 32 dB at any bitrate.

With `--through pipeline` it runs the encoder as a share does, through `pipeline.rs` at the frame rate, its bitrate starting at 3 Mbit/s and following an estimate of the network that's always the most it may send. On the same machine, for 40 seconds at 1920x1080 and 60 fps, with NVENC at the effort Balanced (`p4`), the default, and H.264 with its target quality ([Getting more out of H.264](#getting-more-out-of-h264)):

| The most it may send | H.264 sent | Luma PSNR | AV1 sent | Luma PSNR |
|---|---|---|---|---|
| 2 Mbit/s | 2.55 Mbit/s | 33.1 dB | 1.79 Mbit/s | 37.2 dB |
| 4 Mbit/s | 2.32 Mbit/s | 36.8 dB | 3.42 Mbit/s | 38.7 dB |
| 8 Mbit/s | 3.76 Mbit/s | 39.0 dB | 6.89 Mbit/s | 40.9 dB |
| 16 Mbit/s | 8.49 Mbit/s | 42.7 dB | 12.6 Mbit/s | 43.9 dB |

The game holds the whole scene's PSNR down. Each part, at 8 Mbit/s:

| At 8 Mbit/s | H.264 | AV1 |
|---|---|---|
| Scrolling code | 1.81 Mbit/s, 43.6 dB | 5.75 Mbit/s, 45.9 dB |
| Still, its caret blinking | 0.34 Mbit/s, 57.3 dB | 6.78 Mbit/s, 68.1 dB |
| A video in a corner | 3.74 Mbit/s, 56.4 dB | 7.08 Mbit/s, 62.1 dB |
| A window dragged | 1.97 Mbit/s, 56.8 dB | 6.35 Mbit/s, 66.5 dB |
| A full screen game | 8.01 Mbit/s, 34.2 dB | 8.07 Mbit/s, 36.0 dB |

- **At the same limit,** as a share asks for the most it may send, AV1 looks better throughout: 1.2 to 4.1 dB more at 1080p from 2 to 16 Mbit/s, and 1.1 to 4.2 dB at 2560x1440 from 4 to 32 Mbit/s. Mostly because it sends more of what it's allowed, above 2 Mbit/s half as much again or more, where H.264 sends what the picture needs.
- **For each bit sent, the two come out about even** over the scene: AV1 needed 3 to 4% more than H.264 for the same quality, averaged over the qualities both reached (Bjøntegaard's measure). AV1 needed 31 to 35% fewer bits for the game, and 40% fewer for the video at 1080p and 8% at 1440p; H.264 needed fewer for the scrolling code, 12% at 1080p and 24% at 1440p, and for the window dragged.
- **AV1 spends its bitrate on a still screen,** to make it all but perfect, where H.264 sent 0.03 to 0.7 Mbit/s. A share encodes at the full frame rate while anything changes, so a caret blinking keeps AV1 at its bitrate.
- **Neither can hold a game at too low a limit.** H.264's busiest second sent 4.4 times what it may at 2 Mbit/s at 1080p, and 2.8 times at 4 Mbit/s at 1440p, as even its coarsest quantizer can't make the picture smaller; AV1's, with a far finer range, 1.6 and 1.3 times. Above those, H.264's busiest second went 4 to 7% past the limit, and AV1's 12 to 39%.
- **H.264's keyframes are larger:** 109 to 124% of the VBV, where AV1's were 49 to 81%.
- **AV1 encodes faster** on this card: 2.7 ms a frame through the pipeline against 3.1 at 1080p, and 5.0 against 5.7 at 1440p.
- **Watching costs more:** the native app decodes both in software on Windows, and AV1 more slowly (the table above).

Straight to the encoder, at the bitrate asked for from the start, on the scene as it was before the game was added, for 10 seconds: NVENC's H.264 in CBR sent far less than it was asked for on a screen, the rest filler: asked for 8 Mbit/s, it sent 2.35 at 1080p, and asked for 32, 8.6 at 1440p. AV1 in CBR spent all of its bitrate whatever the picture, a still screen too, which is why `av1_nvenc` goes in VBR held to the bitrate (`is_capped_vbr` in `native/encoder.c`), better than CBR at every bitrate, by 0.2 to 1.6 dB at 1080p, and sending a little less. AV1 encoded about an eighth faster, 2.35 ms a frame against 2.67 at 1080p.

### Getting more out of H.264

NVENC's H.264 codes what's new on a screen coarsely, and carries what's still, and text moved by whole pixels, from frame to frame as it was first coded: at a constant QP of 20 the scene above (before the game) took 1.31 Mbit/s for 51.3 dB, where CBR asked for 8 sent 2.35 for 50.8. So it goes in VBR held to the bitrate, with a target quality of 8 (`H264_TARGET_QUALITY` in `native/encoder.c`). Through the pipeline, against H.264 as it was, in CBR:

| Scrolling code, luma PSNR | 2 Mbit/s | 4 Mbit/s | 8 Mbit/s | 16 Mbit/s | 32 Mbit/s |
|---|---|---|---|---|---|
| 1920x1080, before | 37.5 dB | 39.5 dB | 40.9 dB | 41.2 dB | |
| 1920x1080, now | 40.0 dB | 41.3 dB | 43.6 dB | 44.3 dB | |
| 2560x1440, before | | 35.8 dB | 37.4 dB | 37.9 dB | 37.9 dB |
| 2560x1440, now | | 36.3 dB | 38.4 dB | 39.0 dB | 39.1 dB |

For the same bits: the scroll sent the same, and the still screen, the video and the window came out 2.4 to 2.9 dB better at 2 Mbit/s and the same above it, as did the game. The busiest second was as before from 4 Mbit/s up; at 2 Mbit/s at 1080p, where neither holds the game, it sent 4.4 times the limit against 3.4. Keyframes came out about half as large again, a little over the VBV. A target of 14 or 20 held the video back at 16 Mbit/s, and 8 didn't.

What didn't help, with 8 Mbit/s asked for at 1080p straight to the encoder: VBR held to the bitrate by itself, two passes at a quarter or the full size, the tunes `ll` and `hq` and a lowest QP of 0 all sent the same for the same, temporal AQ sent 14% more for 0.3 dB more, and spatial AQ 3.1 Mbit/s for 48.6 dB. A highest QP, which FFmpeg only passes to NVENC in VBR, did the most for text, 55.7 dB on 2.33 Mbit/s with QP no higher than 20, but it outranks the bitrate and the VBV: through the pipeline, a highest QP of 22 had the game send 2.8 times the limit at 8 Mbit/s and 11 times at 2, with keyframes 2.7 to 4 times the VBV. One that followed what the share sent, coming down a step while it sent under 60% of its bitrate and going back up as soon as it sent more, was worse than none: FFmpeg can't change NVENC's QP range without opening it again, and each new encoder's keyframe threw away what H.264 had sharpened over the frames before, while the game, coming under a low ceiling, sent 2.3 times the limit for a second before it backed off.

## What the proof of concept measured

The native share began as a proof of concept, with a test window as the scene and the Electron app of the time as the viewer, which is in git history under `poc/screenshare`. A clock drawn in pixels at the test window's top left was read back out of the received video, which gave the real delay from screen to decoded frame, and colour swatches beside it were compared with what was drawn.

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

**On Linux,** on Arch with KDE Plasma 6.8 on Wayland, PipeWire 1.6, and an RTX 5080 with NVIDIA's 615 driver and a Ryzen 7 9800X3D, using NVENC with encryption on. The publisher, LiveKit and the viewer ran on one machine, and each row leaves out the first 10 seconds of a 60-second run. KWin's CPU counts here, since for shared memory it reads each frame back from the GPU. With the test window open and nothing captured, it used 15.4% of a core.

| Stream | Frames from | Sent | Encoding | Publisher's CPU | KWin's CPU | Screen to decoded, median / 95% |
|---|---|---|---|---|---|---|
| 2560x1440, 60 fps, up to 20 Mbit/s | DMA-BUFs | 60.0 fps, 18.0 Mbit/s | 3.8 ms | 6.7% of a core | 20.3% | 52 / 75 ms |
| The same | Shared memory | 60.0 fps, 19.8 Mbit/s | 5.2 ms | 14.9% of a core | 29.1% | 72 / 85 ms |

- No freezes, lost packets or dropped frames, and the clock read back from every frame. The monitor ran at 360 Hz, and KWin kept to the 60 fps asked for. nvidia-smi showed one encoder session, at about 9% use.
- Capturing cost KWin 4.9 points over the test window's 15.4 with DMA-BUFs, and 13.7 with shared memory. With the publisher's own, that's 11.6% of a core against 28.6%.
- Single runs vary: three from shared memory had the publisher at 14.3, 14.9 and 18.7%, and two with DMA-BUFs at 6.7 and 6.8%.
- Decoding took 3.7 to 4.1 ms a frame, against 0.7 on Windows, and the jitter buffer held 30 to 37 ms. That's in software: Electron 45 won't decode through VA-API on NVIDIA unless `VaapiOnNvidiaGPUs` is on.
- With `--viewer-features VaapiOnNvidiaGPUs`, through nvidia-vaapi-driver, decoding took 0.21 ms a frame against 3.58 in software, and the viewer used about a quarter of a core less. The test viewer itself uses over three cores, since it draws without a frame rate limit and reads every frame. The delay didn't improve: 59 / 87 ms against 54 / 74, with a jitter buffer of 40 ms against 32, over one run each.
- Colours were off by up to 6 out of 255, most in the darks. That's KWin: they match what was drawn with sRGB's curve re-encoded as gamma 2.2, to within 2.
- With the wrong key, 13.7 MB arrived in 20 seconds and no frame decoded. With no key, the viewer showed a solid green frame. The viewer that couldn't decrypt asked for 32 keyframes in those 20 seconds.

### What it found

- **LiveKit's static libwebrtc contains a private copy of FFmpeg,** with the same symbol names, so ours can't link into the same program as it. The encoder wrapper is a shared library loaded at runtime for this reason, and on Linux it's opened with `RTLD_DEEPBIND` so that it can't bind to the other copy.
- **FFmpeg resets NVENC and forces a keyframe on every bitrate change,** and the other encoders only take a bitrate when opened. libwebrtc revises its estimate several times a second, so `pipeline.rs` ignores changes under 25% and paces the rest. Even so, the climb costs 6 or 7 extra keyframes. Calling NVENC's API directly would avoid them.
- **The bitrate climbs slowly,** at about 1 Mbit/s each second after a quick start: about 7 Mbit/s after 3 seconds, and 20 Mbit/s after 12 to 21. A 40 Mbit/s limit wasn't reached in 30 seconds. The first seconds are the softest part of a share.
- **A viewer who can't decrypt asks for keyframes without end,** and the sender can only answer by sending them to everyone. That made 22 keyframes in 12 seconds, against 11 in 45 seconds normally. A key change during a call needs thought for this reason.
- **The keyframe bug under encryption ([rust-sdks#1573](https://github.com/livekit/rust-sdks/issues/1573)) doesn't affect NVENC,** which writes `slice_type` 2. `h264.rs` rewrites other encoders' keyframes, and that's only been tested on made-up ones, since no other encoder has run yet.
- **NVENC's output needs cleaning up first.** It mixes three- and four-byte start codes, and the frame cryptor needs four. It also adds filler and SEI, which `h264.rs` removes.
- **Native and browser encryption work together** when both use HKDF over the raw key: `KeyDerivationAlgorithm::HKDF` natively, and an `ArrayBuffer` passed to `setKey` in the browser. That also suits a key from the MLS exporter, which is already random.
- **A compositor sends frames at its own pace, a little unevenly.** Repeating the last frame once an interval had passed without a new one, as on Windows, put a repeat just before each late frame. That made 74 encodes a second at 60 fps, and 24 Mbit/s against a limit of 20, since NVENC budgets its bits for the frame rate. On Linux a repeat now waits one more interval after a new frame.
- **`cl.exe` can't open paths over 260 characters,** and LiveKit's headers pass that from a target folder inside a deep checkout, whatever Windows' long path setting says. So `demo.mjs` builds in `%LOCALAPPDATA%\zss`.
- **DMA-BUFs reach NVENC through EGL, OpenGL and CUDA,** in `dmabuf_cuda.c`, as in Sunshine and gpu-screen-recorder. EGL imports the compositor's buffer, a blit copies it into a texture CUDA has registered, and CUDA copies that into the encoder's frame, all on the GPU and in about 0.2 ms at 2560x1440. Shared memory cost the publisher two CPU copies of every frame and KWin a read back from the GPU.
- **Chromium decodes on NVIDIA under Linux only with `VaapiOnNvidiaGPUs`,** which is off by default, and it goes through nvidia-vaapi-driver, a community driver that NVIDIA doesn't ship. Without the feature it decodes in software, which costs viewers about a quarter of a core at 2560x1440 and 60 fps. What it does on a machine without the driver hasn't been tried.
- **NVIDIA's EGL offers only its own tiled modifiers** for XR24, and not linear, so offering linear alone, as for VA-API, would have got shared memory. KWin chose one of the tiled ones.

## What hasn't been checked

Inside the app, Windows and Linux with NVENC have run so far, and macOS through ScreenCaptureKit and VideoToolbox (`mac-voice-check.mjs`, and a real screen and a window by hand). Most of what follows ran while Windows and Linux shared through a program of their own, `zuna-screenshare`, as a participant of its own:

- **The share in the app's own process,** from its own connection, has only run on Windows 11 with an RTX 5070 Ti (2026-11-09): through `key-log-check.mjs`, a 626x352 window encoded by NVENC at the frame rate it drew, decoded by someone watching under the shared key, and stopped when asked, with the key nowhere in libwebrtc's log; and the computer's sound, everything but Zuna and one process's, at the full 48 kHz in stereo. And from the app, into a voice channel on the test server: that window shared, NVENC following LiveKit's estimate from 3 to 5.7 Mbit/s, the computer's sound published beside it, the stream stats window's rows, stopping it, and the share ending by itself as the window closed. Nobody watched that one, so someone watching a share from the app in another app is unchecked since. Linux and macOS have only been type-checked since.

- **Linux** has run from the app on Arch with KDE and an RTX 5080, over KRdp with its screen at 1920x1080, publishing over TLS to apps watching: NVENC from DMA-BUFs, 60 fps sent and 60 decoded at 2.3 ms a frame and 4% of a core, and 30 fps asked for gave 30.0. KWin offers any size from 200x200 to 10000x10000 with its screen's own as the default (seen in `pw-dump`), and scales to whatever's taken. PipeWire takes the consumer's default when the range allows it, so the program offers no size at all and gets the screen's own. Until it did, it offered 1920x1080. Since then, `voice-check.mjs` has shared a 2560x1440 screen natively at its own size.
- **VA-API and AMF** have never run. **Media Foundation** has only run on NVIDIA's own encoder for it, on an RTX 5070 Ti: from the app in `voice-check.mjs` with `VOICE_ENCODER=h264_mf`, a screen at 60 fps over TLS, under a new key, and a window at 60 fps, until that run was stopped partway; by itself, a screen made smaller, a window dragged, and colours within 2 of 255 of what was drawn, as NVENC's are. Intel's and other GPUs' haven't, nor has one of a laptop's two GPUs.
- **Making the picture smaller** has run natively on Windows with NVENC, at 1280x720 from 2560x1440 at about 3.5% of a core, and on Linux with NVENC from DMA-BUFs through the OpenGL blit, at 1280x720 from 1920x1080 and 60 fps, 1.4 ms a frame and 4% of a core. VA-API's `scale_vaapi` has never run.
- **Effort per frame** is Balanced since 2026-11-09, when it stopped being a setting. Its other two were run at each end on Windows with NVENC, where they cost little at these sizes, and nobody compared the pictures.
- **Leaving the pointer out natively** asks Windows and the portal to. Through KDE's portal it works: with the pointer over the tab bar, a frame someone watching received showed it with the pointer on, and not with it off. On Windows 11 it works too: with the pointer still over text, a frame encoded by NVENC showed its I-beam with the pointer on, and not with `--no-cursor`.
- **Sharing a window natively** has run on Linux with KWin, in the app on Arch with an RTX 5080: a 908x634 window at 60 fps from DMA-BUFs, the one app's sound chosen for it reaching someone watching, its picture following it to 1288x534 at once, and the share ending quietly as it closed. GNOME, wlroots compositors and Hyprland haven't run it. One that kept a window's stream at one size and marked the window in it as `SPA_META_VideoCrop` would need that read, which the program doesn't ask for. On Windows 11 with an RTX 5070 Ti it has run from the app in `voice-check.mjs`: a 222x181 window at 60 fps over TLS, decoded at 60 by someone watching. By itself, to a file: a window that grew, at once and while dragged, made smaller to 360 lines, and the program leaving as it closed.
- **The computer's sound on Linux** has run from the app beside a share through the browser, in the Electron app's `sound-check.mjs`, since removed, on Arch with KDE, PipeWire 1.6 and EasyEffects, and by itself against a player linked straight to a sink without EasyEffects. Beside a native share, one app's sound has run with a window shared through KDE's portal, and the entire system's beside a native screen in `voice-check.mjs`. The same check shares a window on X11, whose app's sound is chosen and sent by itself, and checks that a screen starts with everything.
- **The computer's sound on macOS** has run from the app beside a share through the browser, in the Electron app's `mac-sound-check.mjs`, since removed, on macOS 27 on Apple silicon: everything but Zuna, one app alone, and the picker's apps. In the native app, picked in macOS's picker on 2026-11-08: a real 3600x2338 screen at 60 fps with the entire system's sound, and QuickTime Player's window with its own, another program's left out. A whole screen with one app's sound hasn't run. The program by itself has also taken another program's speech while leaving out the app that started it, and its tone, and Apple's converter has taken 44.1 kHz to 48 kHz in a test. An output at another rate, and a change of output during a share, haven't run.
- **The computer's sound on Windows** has run from the app in the Electron app's `win-sound-check.mjs`, since removed, on Windows 11 (build 26300), beside a native share and one through the browser: everything but Zuna, with Zuna's own tone 46 dB under another app's, one app alone, the picker's apps, and a window starting with its app's. Its tones are at -60 dBFS, so that nobody hears them, and told apart by frequency. They play to the default output, and an app playing to another hasn't been tried.
- **Real networks:** a pre-encoded stream has one layer, so a viewer on a slow connection can't be dropped to a lower quality. How the bitrate follows a real link with no regular keyframes, and rises that wait longer after each that was too much, has only run against the tests' model of libwebrtc's estimate, not in a call.
- **AV1** has only run on Windows 11 with an RTX 5070 Ti, through NVENC in `codec-check.mjs`, `key-log-check.mjs` and `codec-bench.rs`, and through NVIDIA's Media Foundation encoder in `key-log-check.mjs` ([AV1](#av1)). Its row in Settings and a share from the app into a voice channel in AV1 haven't been seen, nor has anyone watching one in the app on macOS, which goes through the same patched `webrtc-sys`. Linux's AV1 has only been type-checked, and AMF's, VA-API's and Intel's AV1 have never run. A share in AV1 through a real network, where it would send more than H.264 at the same limit, hasn't run either.
- **NVENC's H.264 with its target quality** has run on Windows 11 with an RTX 5070 Ti, in `codec-bench.rs` and `codec-check.mjs`. On Linux it's the same options, and hasn't run there, nor on other NVIDIA cards.
