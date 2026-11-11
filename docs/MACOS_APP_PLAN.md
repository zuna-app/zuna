# The native app on macOS: plan

The Electron app this plan compares with was removed on 2026-11-08: its files, and what `packages/ui` did only for it, are in git history.

`zuna-screenshare`, which this plan has take a share's sound as a program of its own, has been a crate the app links since 2026-11-09 (`apps/desktop/screenshare`), so the bundle carries no second program, and the app itself reads the computer's sound. [SCREEN_SHARE.md](SCREEN_SHARE.md) has how it works now.

Status: M0 to M4 built (2026-11-08). Checked on this Mac by `apps/desktop/test/mac-voice-check.mjs` and the test control: signing in and chatting, the badge, the keychain, macOS's keys, closing to the Dock and `zuna://`; between two copies, a voice channel and a call each way, a screen share encoded and decoded on the GPU past the picker, and voice and video messages read and played through FFmpeg. Then, once allowed in macOS's dialogs (2026-11-08): notifications shown and clicked, also ones from before the app started again, the Mac's own camera, location, push to talk held in another app, macOS's picker on a real screen with the entire system's sound and on a window with one app's, a real microphone, the title bar dragged and double-clicked, and the menu bar's items. A camera other than the Mac's own is unchecked. Since then (2026-11-08) every bundle is signed under the hardened runtime, which `mac-voice-check.mjs` passed under, and `npm run dist:macos` signs a release with the Developer ID, with its timestamp, which `codesign --verify --strict` accepts, and Apple notarized the app and its DMG, both stapled. Gatekeeper accepts the DMG and the app in it as notarized, also with the DMG marked as downloaded by Safari, `syspolicy_check distribution` passes, and the stapled app started. Dragging it into Applications, a `zuna://` link from Safari and the media library loading in a notarized copy are unchecked. Updates are still to come.

Scope: the native app in `apps/desktop`, drawn with GPUI, running on macOS from the same crate as on Windows and Linux. There's no second codebase: what differs is behind `#[cfg(target_os = "macos")]`, in `src/platform/macos/` and a few lines beside it, and everything else is shared. Four rules hold throughout:

- **Apple silicon, macOS 14.2 and later.** As the Electron app's Mac builds and `zuna-screenshare`, nothing is built for Intel Macs. 14.2 is where Core Audio's process taps start, which a share's sound needs, and 14 is where ScreenCaptureKit's own picker does, so everything works on every Mac the app runs on. `LSMinimumSystemVersion` says so.
- **Windows and Linux don't change.** Code is added for macOS, never rewritten for it. Where a shared file needs lines of its own on macOS, they're behind `cfg`, and Windows and Linux compile what they did before. Where Windows's code serves macOS as it is, as cpal's does, its `cfg(windows)` becomes `any(windows, target_os = "macos")` and nothing else. Neither is built during the port, as Windows wasn't during Linux's: commit messages say so, and what breaks there is fixed there.
- **The interface doesn't change,** except where macOS has a way of its own that the Electron app follows there too: the window's three buttons, the menu bar, ⌘ in place of Ctrl, and the Dock in place of the tray. Anything else macOS can't do as Windows does, it does as the Electron app does on macOS, and nothing new is designed.
- **It always runs as an app bundle,** a development build too. macOS only asks for the microphone, the camera, the computer's sound and notifications on behalf of a bundle that says why in its `Info.plist`, and keeps the answers, and Keychain's trust, by the bundle's signature.

It's checked on this Mac, Apple silicon on macOS 27, and nowhere else.

## Summary

- **Most of the app is already portable.** The core's host (`src/host`), the interface (`src/ui`), voice (`src/voice`), `state.rs`, `markup.rs` and `models.rs` have no system's code in them, and GPUI's macOS backend, on Metal, is the one Zed itself is mostly used on.
- **What's missing is `platform` for macOS,** and a macOS arm for about a dozen pairs of `cfg(windows)` and `cfg(target_os = "linux")` in `main.rs`, `format.rs`, `host/device_key.rs`, `voice/audio.rs`, `voice/mod.rs`, `media/mod.rs` and `ui/mod.rs`, which leave a name undefined on macOS today.
- **Linux has already done half of it.** GPUI's macOS windows ignore `window_control_area`, as its Wayland windows do, so the title bar drags the window itself as `platform/linux/frame.rs` does. Notifications are the system's, as on Linux. One copy at a time outside a bundle is Linux's lock and Unix socket.
- **macOS follows the Electron app there:** no tray, closing hides the window and the Dock brings it back, the count on the Dock's icon, the system's notifications, a menu bar with the app's, Edit and Window menus, and the system's own picker for sharing a screen.
- **Sound devices go through cpal,** on Core Audio, with the same code Windows runs on WASAPI.
- **Media goes through FFmpeg,** with Linux's code in `media/ffmpeg`, from FFmpeg's source pinned by its hash and built on the Mac with VideoToolbox, since there's no build of it to pin for macOS. Cameras come through AVFoundation.
- **Video stays on the GPU, both ways.** A share's picture is captured in the app through ScreenCaptureKit, chosen in macOS's own picker, and handed to LiveKit as the `CVPixelBuffer` it comes in, which VideoToolbox encodes. What arrives is decoded by VideoToolbox and drawn from its `CVPixelBuffer` by GPUI's Metal renderer. Neither way does a frame pass through the CPU. A share's sound comes from `zuna-screenshare`, which already does that on macOS.
- **Development builds are signed** with the Apple Development identity in this Mac's keychain, so that the permissions and the device key's Keychain item survive each rebuild. An ad hoc signature is a new app to macOS every time. They run under the hardened runtime, as a release does.

## Where it stands

Checked on this Mac before the port began:

- **Tools:** Xcode 27.1 and Rust from Homebrew's rustup. GPUI compiles its Metal shaders while building (`xcrun metal`), which Xcode 26 and later only have once the Metal Toolchain is downloaded, 839 MB: `xcodebuild -downloadComponent MetalToolchain`. It's downloaded here. The script says how when it's missing.
- **`cargo check`** of `apps/desktop` as it is: every dependency checks, GPUI's macOS backend and its Metal shaders, LiveKit with its prebuilt libwebrtc for macOS on arm64, rquickjs, rusqlite and the crypto crate. The app itself has 98 errors, all names that only Windows and Linux define: modules of `media` (`record` 12, `mf` 6, `player` 4, `encode` 4), `ui::notifications` (9), modules of `platform` (`single` 6, `ptt` 5, `tray` 4, `updates` 3, `screens` 1), its constants and functions (`DEVICE_NAME`, `APP_ID`, `show_main`, `flash_main`, `notification_state` and the rest), `devices`, `open_input` and `open_output` in `voice/audio.rs`, `protect`, `unprotect` and `UNSEAL_FAILED` in `host/device_key.rs`, and `system_hour12` in `format.rs`, with a few mismatched types that follow from them. By file: `main.rs` 22, `state.rs` 21, `ui/chat.rs` 14, `ui/voice_settings.rs` 8, `host/device_key.rs` 5, `voice/room.rs` 4, `media/round.rs` 3, and one or two in 16 others.
- **Signing:** this Mac has an Apple Development identity, which development builds need, and no Developer ID Application one, which only a release would. The Developer ID was added to its keychain from the account's .p12 on 2026-11-08.
- **LiveKit's video on macOS,** read in `webrtc-sys` 0.3.53's source, the version in `Cargo.lock`: its encoder factory adds VideoToolbox through WebRTC's `RTCDefaultVideoEncoderFactory`, and its decoder factory puts WebRTC's VideoToolbox decoders first. `NativeBuffer::from_cv_pixel_buffer` hands it a frame without copying, and `get_cv_pixel_buffer` gives back what it decoded, which `mac-voice-check.mjs` has seen run, in NV12 at full range, the one format GPUI's Metal renderer draws.
- **Two things only running it found:** libwebrtc needs `-ObjC` when linking, or its categories on Foundation's classes are left out and the first voice channel stops the app; and libwebrtc carries Chromium's own FFmpeg, whose symbols the linker took for the app's own calls into FFmpeg, so on macOS those are made from a library of their own (see Voice and video messages).
- `scripts/windows-app.mjs` and `scripts/linux-app.mjs` exit on anything but their own system, so there's no command for macOS yet.

## How the code is split

`src/platform/mod.rs` keeps the functions the rest of the app calls, and gets a third module beside `windows/` and `linux/`:

```
src/platform/macos/       the new code
src/media/apple/          cameras through AVFoundation
```

- **Constants:** `DEVICE_NAME` "Mac", as the Electron app names it, `SYSTEM_NAME` "macOS", `APP_ID` `chat.zuna.desktop`, `DATA_FOLDER` "Zuna Native", and `KEY_WARNING` in macOS's words.
- **The notification cards stay Windows's.** `ui/mod.rs` takes `platform::notifications` on macOS as on Linux, with the same `install` and calls.
- **`format.rs` and `host/device_key.rs`** get a macOS arm each, as they got Linux's.
- **`files_on_clipboard` and `draws_title_bar`** get one too: GPUI's macOS pasteboard already reads files copied in Finder as `ClipboardEntry::ExternalPaths`, and the title bar is always the app's.
- **One app at a time** outside a bundle is Linux's `single.rs`, which is plain Unix but for the activation token. It moves into `platform/unix/single.rs` for both, in a commit with nothing else in it, and the token stays in Linux's own module.
- **Playing and recording for media** go through PipeWire in `media/ffmpeg/player.rs` and `record.rs`. Each instead asks `voice/audio.rs` for a stream, which has a body for PipeWire and one for cpal, so Linux's lines are moved rather than changed.
- **Video frames** are BGRA on Windows and Linux, converted from I420 on the CPU in `voice/room.rs` and drawn as a `RenderImage` in `ui/voice_stage.rs`. On macOS a tile holds the decoded `CVPixelBuffer` instead, which `voice_stage.rs` draws with GPUI's `surface`, behind `cfg`.

## Each piece

### Building

- **The script:** `scripts/macos-app.mjs`, with `npm run dev:macos`, `build:macos` and `dist:macos`, beside the other two. `bundle --test-control` makes the checks' bundle without starting it. It bundles the core, builds with cargo into `~/Library/Caches/zuna-desktop-target`, outside the checkout as the others keep theirs, and wraps the program in `Zuna.app`: `Contents/MacOS/zuna`, FFmpeg's libraries in `Contents/Frameworks`, the icon as `Resources/zuna.icns` from the desktop's sizes, and `Info.plist`. It signs the bundle, then starts it with `open`, so that macOS asks about Zuna, not the terminal, as `mac-sound-check.mjs` found for Electron, and passes `ZUNA_DATA_DIR` with `--env` and the log with `--stdout` and `--stderr`.
- **Its data:** `npm run dev:macos` keeps it in `.dev-data/native-app`, as `dev:windows` does, so `npm run dev:clean` starts it over.
- **`Cargo.toml`:** GPUI's features stay as they are. `gpui_platform`'s `font-kit` already turns on `gpui_macos/font-kit`. macOS's own dependencies go under `[target.'cfg(target_os = "macos")'.dependencies]`: `objc2` and its `objc2-foundation`, `objc2-app-kit`, `objc2-user-notifications`, `objc2-core-location`, `objc2-av-foundation`, `objc2-screen-capture-kit` and `objc2-core-video`, all at the versions GPUI already takes, `security-framework` for the Keychain, and `ffmpeg-next` as on Linux.
- **`build.rs`:** FFmpeg's libraries are found through `@executable_path/../Frameworks`, and in a debug build where the repository keeps them. The icon is the script's, as macOS takes it from the bundle rather than the program.

### The window and its title bar

- **macOS's three buttons:** the window keeps its title bar transparent (`appears_transparent`), which `main.rs` already asks for, so the app's own title bar is drawn under macOS's buttons, where `main.rs` already puts them, a point from the Electron app's. Windows's three buttons are left out, and the title bar starts 80 px in, as `.titlebar.is-mac` does in `base.css`. In full screen there are no buttons, and nothing is left for them.
- **Dragging:** `window.start_window_move()` on a press in the title bar, as on Wayland, which macOS carries out with `performWindowDragWithEvent`, and `window.titlebar_double_click()` on a double click, which does what the person chose for that in System Settings.
- **Resizing, Split View and full screen** are macOS's own.
- **The picture viewer** opens a window of its own over the whole screen, through which what's behind shows. It covers the menu bar and the Dock at a window level above them, to be seen in M0.

### The menu bar and shortcuts

- **Menus,** as the Electron app's on macOS (`appMenu`, `editMenu`, `windowMenu`), through `cx.set_menus`: Zuna (About Zuna, which opens Settings' About; Settings… ⌘,; Services; Hide Zuna ⌘H; Hide Others ⌥⌘H; Show All; Quit Zuna ⌘Q), Edit (Cut, Copy, Paste, Select All, as the text field's own actions; Undo and Redo once the field has them, which it doesn't anywhere yet), and Window (Minimize ⌘M, Zoom, Close ⌘W, which closes as the red button does, and Bring All to Front).
- **Shortcuts:** macOS's own beside Windows's, under `cfg`, so Windows and Linux keep theirs: ⌘A, ⌘C, ⌘V and ⌘X; ⌥← and ⌥→ by word and ⌘← and ⌘→ to the line's ends, each with ⇧ to select; ⌥⌫ for a word and ⌘⌫ to the line's start; ⌘↑ and ⌘↓ to the text's ends; ⌘Return to send; ⌘K for search; ⌘Q. ⌥↑ and ⌥↓ between chats stay. Copying a selected message's text already takes ⌘ (`modifiers.platform` in `ui/mod.rs`).
- **Words:** "Ctrl+Enter" in Settings, and any other key the interface names, comes from `platform`, as Linux's words do.
- **The pointer:** Control-click opens a menu as a right click does, and a pinch in the picture viewer zooms it, which GPUI gives as a `Pinch` event on macOS beside the Ctrl and wheel it reads now.

### One app at a time, `zuna://` and the Dock

- **In a bundle, macOS keeps one copy running:** opening the app again brings the running one forward, and a `zuna://` link comes to it as an Apple event, which GPUI hands to `on_open_urls`, registered before the app runs, into the same channel a second start's link goes into now. `Info.plist`'s `CFBundleURLTypes` claims `zuna`.
- **Outside one,** as `--core-check`, `--quit` and a program started from a terminal are, Linux's lock and socket keep one for each data folder, with the socket in `$TMPDIR`, which is the person's own on macOS.
- **The Dock's icon** brings the window back when it's hidden (`on_reopen`).
- **Closing hides the window,** as closing the Electron app's on macOS leaves it running with no window. GPUI can't hide one window, so the app hides itself (`cx.hide()`), as ⌘H does, and comes back with `cx.activate(true)`. "Keep running when closed" isn't shown on macOS, where there's no tray to keep running in, as the Electron app doesn't offer it there. ⌘Q quits.
- **`main_visible()`** is GPUI's `window.is_visible()`, kept from `observe_window_visibility`, which follows macOS's occlusion state, so a window that's hidden, minimized or covered counts as away.
- **Drawing attention:** `flash_main` becomes `window.request_attention()`, which bounces the Dock's icon once, as `flashFrame` does on macOS.

### The badge

The unread count on the Dock's icon through `NSApp.dockTile.badgeLabel`, as `app.setBadgeCount` puts it there, and none at zero. There's no tray, as the Electron app has none on macOS: `tray::start` gives a stream that never yields, and `tray::available` is false.

### The device key

- **In the login keychain,** as Electron's safeStorage keeps its own key there: one generic password item, named for the app and the data folder's hash, so that `ZUNA_DATA_DIR` keeps working, written through `security-framework`. `device-key.sealed` only names the item, as on Linux. The key loads before GPUI starts, so this blocks once at start, and the Keychain's own calls do anyway.
- **Without a keychain to write to,** it's kept alone with mode 0600 and counts as unprotected, and Settings says so, as on Linux.
- **The Keychain trusts the app that wrote an item** by its signature's designated requirement, so a build signed by the same identity reads its key without asking, and an ad hoc signed one is asked about each time it's rebuilt.

### Notifications and their sound

- **The system's,** as the Electron app's on macOS: `UNUserNotificationCenter` through `objc2-user-notifications`, which asks the person the first time one is shown. The chat's picture goes with it as an attachment, drawn as on Linux (its photo made round, or its initials on its color through the resvg GPUI already has), which macOS shows on the notification's right. The app's icon stays on its left: a sender's picture there needs Communication Notifications, an entitlement only a provisioning profile gives. A click opens the chat, and a notification is taken back with `removeDeliveredNotificationsWithIdentifiers` when its chat is read or its message deleted.
- **Notification Center keeps them after the app quits,** so each carries its server, chat and message in `userInfo`. A click opens the chat from those, once the app is ready, and at start the app asks what's still shown (`notified_earlier` in `state.rs`), to take those back as its own once their chats are read. With two copies of one bundle running, as in the checks, macOS hands a click to only one of them.
- **GPUI's own** (`system_notifications.rs`) has only a title, a body and buttons, so it's left unused. The app sets the center's delegate itself, and GPUI only touches the center once its own are used.
- **Only from a bundle:** the center stops a program that isn't in one, so a start with `--core-check`, or from a terminal, never shows one.
- **The sound goes with the notification,** so Focus and the person's own settings for Zuna in System Settings quiet both: `UNNotificationSound` names `notification.wav` in the bundle's `Resources`, which the script writes from `notification_tones()`. `play_notification_sound` only marks the next notification to carry it, and `notification_state` says to show and sound, as Electron's does on macOS, since only macOS knows about Focus.
- **No replying from one,** as on Linux: Windows's cards can, and macOS could with a text field in the notification, which can come later for both.

### Whether the person is here

Idle time from `CGEventSourceSecondsSinceLastEventType` with any input, which needs no permission.

### Small settings

- **Animations off:** `NSWorkspace`'s `accessibilityDisplayShouldReduceMotion`, which is what Chromium reads for `prefers-reduced-motion` on macOS.
- **The 12-hour clock:** `AppleICUForce24HourTime` and `AppleICUForce12HourTime` first, as the Electron app reads them, then whether the locale's time format has AM and PM (`NSDateFormatter`'s format for the template `j`).

### Location

CoreLocation through `objc2-core-location`: a `CLLocationManager` whose delegate gets one location from `requestLocation`, after `requestWhenInUseAuthorization` the first time, with the entitlement and the words the Electron app has. macOS asks in its own dialog. It answers on the main thread's run loop, which is GPUI's.

### Sound devices

cpal on Core Audio, with the code Windows runs on WASAPI in `voice/audio.rs`: microphones and speakers by name, the default first. Opening the first microphone makes macOS ask (`NSMicrophoneUsageDescription`). WebRTC's echo canceller hears the mixed output inside the app, as on the others. The app's own sound is kept out of a share's sound by `zuna-screenshare --exclude-pid`, as for the Electron app. The notification sound needs no output of its own, as it goes with the notification.

### Voice and video messages, videos and sound files

- **Linux's code:** `media/ffmpeg` reads every container and codec it does on Linux, so a WebM or an Ogg someone sent from a browser plays as it does there, and writes AAC in MP4 for a voice message, and H.264 Baseline with AAC in MP4 for a video message. The one difference is the H.264 encoder, `h264_videotoolbox` in place of `libopenh264`, named for each system in `encode.rs`, so a video message is encoded on the GPU.
- **Videos decoded on the GPU:** H.264 and HEVC through FFmpeg's VideoToolbox decoding (`hw_device_ctx` of `AV_HWDEVICE_TYPE_VIDEOTOOLBOX` in `mf.rs`), whose frames are `CVPixelBuffer`s that the player draws as a call's are. Posters and thumbnails, a frame each, are still made BGRA through `libswscale`, as on Linux. Anything VideoToolbox can't decode falls back to FFmpeg's own decoder.
- **FFmpeg itself:** BtbN publishes no macOS builds, so `scripts/ffmpeg.mjs` builds 8.1.3 from its source tarball, checked against the SHA-256 its release signing key signed, LGPL, as shared libraries naming each other through `@rpath`, with VideoToolbox and AudioToolbox and nothing found on the machine by itself, into `apps/desktop/.deps/ffmpeg` as on the other two. That takes a few minutes, once. The five libraries the app uses go into `Contents/Frameworks`, signed with the app.
- **In a library of its own:** libwebrtc carries Chromium's FFmpeg, built in with its symbols, which the linker found before the app's FFmpeg libraries and took for the app's calls, so files failed to open with "Protocol not found". So on macOS the app doesn't link FFmpeg at all: `apps/desktop/media-ffmpeg` builds the same `media/ffmpeg/mf.rs` and `encode.rs` into `libzuna_media_ffmpeg.dylib`, which only reaches the FFmpeg it was linked to, with a C interface the app calls through `media/apple/ffmpeg.rs`. Its tests run there.
- **Cameras through AVFoundation,** as Chromium reads them on macOS, in `media/apple/camera.rs`: each listed by `AVCaptureDevice.DiscoverySession` with its name, an iPhone through Continuity Camera too, opened by its unique ID at the size nearest 720p, and each frame taken as BGRA from an `AVCaptureVideoDataOutput` into the same `camera::Reader` that V4L2's feed. macOS asks the first time (`NSCameraUsageDescription`).
- **Playing and recording** go through cpal, as above.

### Screen sharing

- **The picker:** macOS's own, `SCContentSharingPicker`, as the Electron app uses it (`useSystemPicker`). The app's picker shows the two tabs it shows under Wayland, a screen or a window (`portal:screen` and `portal:window`, so `Source::system_picks` holds), and Share opens macOS's picker for that kind. What's picked there needs no Screen Recording permission, and macOS 15 and later don't ask each month whether Zuna may keep recording, as they do of an app that lists screens and windows itself.
- **The picture:** captured in the app by an `SCStream` on the filter the picker gives, and sent from the app's own LiveKit connection as a screen share track, as the Electron app sends Chromium's from its own on macOS. ScreenCaptureKit hands over each frame as NV12 in an IOSurface, already made no larger than the server's terms allow, on the GPU, and at the frame rate they allow. Each `CVPixelBuffer` goes to LiveKit's `NativeVideoSource` through `NativeBuffer::from_cv_pixel_buffer`, without a copy, and VideoToolbox encodes it from there: H.264 Baseline, which `LIVEKIT_CONFIG` takes, in one layer, keeping sharpness over frame rate (`DegradationPreference::MaintainResolution`), as the program's shares go on Windows and Linux. The server already lets a device's own participant publish a share once its rules say yes (`sourcesFor` in `server/internal/api/screen.go`).
- **Why not in the program:** `zuna-screenshare` could capture and encode as well, through `h264_videotoolbox` in `native/encoder.c`, which would keep `voice/screen.rs` the same everywhere. But macOS's picker belongs to an app with a window, which the program isn't, so it would list screens and windows itself, which needs Screen Recording permission, the app restarted once it's given, and macOS 15 asking again each month. In the app it's the same GPU path with none of that.
- **The sound:** `zuna-screenshare --sound`, which the program already does on macOS beside a share through Chromium: `voice/screen.rs` starts it for the sound alone on macOS, with everything but Zuna for a screen and nothing for a window, whose app the picker asks for, as under Wayland.
- **Stream stats:** a screen sent this way is one more local track, which `voice/stats.rs` already reads with `get_stats`, in place of the program's own lines.
- **Stopping:** the share ends when the picked window closes or macOS's own Stop in the menu bar is pressed (`SCStream`'s delegate).

### Video that arrives

- **Decoded on the GPU:** LiveKit's decoders on macOS are WebRTC's VideoToolbox ones first, so others' shares, which go out in H.264, are decoded in hardware, and `get_cv_pixel_buffer` gives back the `CVPixelBuffer` they're in.
- **Drawn from it:** GPUI's Metal renderer draws a `CVPixelBuffer` as it is (`surface`, which Zed draws its own shares with), so on macOS a tile keeps the buffer instead of `to_i420` and `i420_to_argb` into a `RenderImage` each frame. A frame that comes some other way, as a VP8 camera does from its software decoder, is drawn as now.
- **Cameras stay VP8,** as the desktop sends them everywhere, so a camera is still encoded and decoded on the CPU. Moving cameras to H.264 would bring them onto the GPU on every platform, and is a change of its own, not part of this port.
- **On Windows and Linux** frames still pass through the CPU to be drawn, which FEATURE_PARITY records as a Known gap once macOS has it.

### Push to talk

- **The key, held in any app:** a listen-only `CGEventTap` for keys, modifiers and mouse buttons, which macOS allows with Input Monitoring, asked for with `CGRequestListenEventAccess`. Without it, push to talk works only in Zuna's window, and Settings says why, as under Wayland.
- **Keys are named** as `KeyboardEvent.code` names them, from macOS's virtual key codes, as Windows names its own, so a setting reads the same in either app.

### The bundle

- **`Info.plist`:** `chat.zuna.desktop`, named Zuna, with its version, `LSMinimumSystemVersion` 14.2, `CFBundleURLTypes` for `zuna`, `LSApplicationCategoryType` social networking, and the Electron app's words for the microphone, the camera, the computer's sound and location.
- **Signed under the hardened runtime, every build:** with the entitlements it needs, `com.apple.security.device.audio-input`, for the microphone and for the computer's sound, read from a tap's aggregate device, `device.camera` and `personal-information.location`. The Electron app's `allow-jit` isn't needed, as QuickJS doesn't compile. Builds signed with the Apple Development identity add `get-task-allow`, for a debugger, which notarizing refuses. So development builds and the checks run under what a release does, and whatever the runtime refuses shows there first. An ad hoc signature has no team for the runtime to check the app's libraries against, so it goes without.
- **`npm run build:macos`** writes `dist/macos/Zuna.app`, signed with the Apple Development identity, to copy into Applications by hand.

### Packages

`npm run dist:macos` builds the release as `node scripts/macos-app.mjs release` does, signed ad hoc with the DMG's backgrounds beside it, then signs `Zuna.app` with the keychain's Developer ID Application identity instead (`signApp` and `packageApp` in `scripts/macos-dist.mjs`), with a secure timestamp, checks the signature with `codesign --verify --strict`, has Apple notarize a zip of it with `notarytool` and staples the ticket to it, so that it opens without asking Apple, offline too. Then it makes `Zuna-<label>-arm64.dmg`, the label a release's files carry, such as `0.1.0-nightly.1153`, with dmgbuild, from the bundle of it electron-builder publishes, pinned by its hash: the app beside a link to Applications, at 128 points, on `apps/desktop/resources/dmg-background.svg` drawn at 1× and 2× in the app's Inter, with the app's icon on the volume. The background is the site's dark page with its light and grain, and a card in the app's accent under each icon, as Finder names icons in black on any picture, in dark mode too. The DMG is signed, notarized and stapled itself. Beside it goes `Zuna-<label>-arm64.zip`, made with `ditto` as an update would be fetched, and last it asks `spctl` what Gatekeeper decides about both. Each goes in `dist/macos`, and the DMG's name is the one the site's downloads look for (`apps/site/src/downloads.ts`).

The private keys never leave the keychain, which signs for `codesign`, and notarizing takes the credentials `xcrun notarytool store-credentials zuna-notary` saved there, which the script names and never reads. Without the identity, `dist` stops before building, and without the credentials, before notarizing, saying how to save them.

Releases are made the same way on CI, the DMG without the zip: `.github/workflows/release.yml` builds the ad hoc release in a job holding no secret, and signs, notarizes and packages it in another, from the `macos` environment's Developer ID and an App Store Connect key, with `node scripts/macos-dist.mjs sign` ("The app on macOS" in `docs/RELEASES.md`).

### Later: updates

Updates go as on Windows: every six hours the newest release on GitHub, the zip unpacked with `ditto`, kept only if `SecStaticCodeCheckValidity` finds it signed by the same team as the app running, and put in place of the bundle as the app quits. A build that isn't signed that way doesn't update itself.

## Zuna's changes to GPUI on macOS

| Change | On macOS |
|---|---|
| `TextLayout::closest_index_for_position` | Works as it is |
| `Window::cursor_style_under_mouse` | Works as it is |
| Activating a Wayland window with a token | Linux only. macOS activates a window without one |
| Reading files copied from the Wayland clipboard | Linux only. GPUI's macOS pasteboard already reads them |
| Every frame of an animated WebP in memory | Works as it is |
| Counting what a cached view's own draw touched | Works as it is |
| An animation's next frame when it's due | Works as it is, to be seen against macOS's display link |
| Letting go of images out of every frame | Works as it is |
| A mouse wheel's notches gliding | A mouse's wheel comes as lines and glides; a trackpad's comes as pixels, with macOS's own momentum, and moves at once |
| A surface's corners rounded, as an image's are | macOS's own: video drawn from VideoToolbox's buffers rounds its corners in the Metal shader, as every other tile does |
| Frames only when a window wants one | Windows only. On macOS the main thread wakes about 19 times a second at rest with a chat open, not ProMotion's 120, and drawing runs a few times a second, so the fork needs no change for macOS |

## Phases

| | What | Done when |
|---|---|---|
| M0 | It builds and runs as a bundle: `platform/macos` with its constants and the rest doing nothing yet, the missing `cfg` arms, the script with signing and `Info.plist`, menus, ⌘ shortcuts, the title bar under macOS's buttons and its dragging, the data folder, and the check's setup (see Checks) | Signs in to the test server and chats with a bot both ways, each screen's screenshot beside the Electron app's on macOS at the same size, and the wakeups at rest counted |
| M1 | The desktop: one app at a time with `zuna://`, the Dock bringing the window back, closing hiding it, the badge, drawing attention, the device key in the Keychain, notifications with their picture and sound, idle time, animations off, the 12-hour clock, pasting copied files, location | Each checked as Checks says |
| M2 | Voice: cpal, voice channels, calls, cameras through AVFoundation, push to talk through an event tap | A call and a voice channel with the Electron app, each hearing and seeing the other |
| M3 | Screen sharing through macOS's picker, captured in the app and encoded by VideoToolbox, with its sound from the program, and video that arrives drawn from its `CVPixelBuffer` | A screen and a window shared to the Electron app, with sound, encoded in hardware as the stream stats say; a share from the Electron app drawn without a copy, and the CPU each takes measured |
| M4 | Media through FFmpeg: voice and video messages, videos, sound files and the soundboard's, video messages encoded and videos decoded through VideoToolbox | The desktop's fixtures played here, and messages recorded here played by the Electron app |
| Packages | `npm run dist:macos`: signed with the Developer ID, notarized and stapled, in a DMG and a zip | The DMG opened as a download, the app dragged into Applications and started, and a `zuna://` link from Safari opening it |
| Later | Updates | An update from a release served locally |

M2 to M4 don't depend on each other once M1 is in, apart from M4's playing and recording, which takes M2's cpal streams, and M3 and M4 both drawing from a `CVPixelBuffer`, which whichever comes first adds.

## Checks

There's no compositor to nest on macOS, so `apps/desktop/test/mac-voice-check.mjs`, with `mac-session.mjs`, runs two copies of the app, built with the `test-control` feature, on the person's own desktop, each with its own data folder, against a test server and a LiveKit of its own. It drives them over the test control's socket (`src/test_control.rs`), which no build anyone uses has, so it needs no permissions and leaves the pointer alone:

- **The other side** is the second copy of the native app.
- **Sound:** the app plays a test tone in place of a microphone (`ZUNA_FAKE_MIC`), and `RUST_LOG=zuna=debug` logs how loud each voice it decodes is, so each side's hearing the other needs no device. A share's sound between two copies on one Mac needs the watching one deafened, or what it plays is taken again and grows until it clips.
- **By hand,** for what only a person can answer or see: each permission's dialog the first time, notifications as macOS draws them and quieted by Focus, the Dock's badge and bounce, macOS's picker for a share, push to talk from another app, a camera, location, and the Keychain asking nothing after a rebuild.

| | Automatically | By hand |
|---|---|---|
| M0 | `cargo test`, `--core-check` without a window, the bundle starting with `zuna` in it, onboarding typed through, signing in, a chat with a bot both ways, screenshots of each screen, the title bar dragging the window and a double click zooming it, ⌘ shortcuts in the message box | The window on the real screen, at 2× and on an external screen at 1× |
| M1 | A second start handing over its link, `open zuna://…` reaching the running one, the Dock's reopen, closing and coming back, the badge's label, the device key's item and the same key after starting again, notifications' requests and their removal once read elsewhere, idle time, the clock under `LC_TIME`'s and macOS's 24-hour setting, files copied in Finder pasted as chips | Notifications and their sound, Focus quieting them, the badge, the bounce, the Keychain after a rebuild, location |
| M2 | Device lists, a voice channel and a call between the two copies, each hearing the other's tone, mute, deafen and volumes, ringing, answering and declining, the camera's frames reaching the other copy | A real microphone and camera, push to talk from another app |
| M3 | A share of moving bars past macOS's picker (`ZUNA_FAKE_SCREEN`) drawn by the other copy, and the stream stats on both sides naming VideoToolbox as the encoder and the decoder | A screen and a window through macOS's picker to another device, with sound and without Zuna's own, and stopping from the menu bar; the CPU sending and watching a 1440p share at 60 fps takes, from `top`, beside the program's on Windows |
| M4 | `cargo test` reading the fixtures in `apps/ios/ZunaKit/Tests/ZunaHostTests/Fixtures`, writing a voice and a video message and reading them back with FFmpeg, recording each in the message box and the other copy playing it to its end | Playing out loud |

## Feature parity and the docs

- `.agents/FEATURE_PARITY.md`: "The native desktop app" gets macOS in each row where it differs, and a Known gap for each piece still to come, removed in the commit that closes it. Under "Not possible or pointless there": the tray and the app's own notification cards on macOS, as the Electron app has neither there.
- `docs/WINDOWS_APP.md` covers macOS too, with how its checks run (its "On macOS").
- `CLAUDE.md`: the commands table, the first paragraph, and under "Decisions to keep" that the native app runs on Apple silicon from macOS 14.2.
- `apps/site` only says the app runs on macOS once it's been checked there.

## Decisions

Decided 2026-11-07:

1. **It's `Zuna.app`, `chat.zuna.desktop`,** apart from the Electron app's `chat.zuna.app` and the iPhone's `chat.zuna.mobile`, so the two desktop apps never share permissions, Keychain items or `zuna://`. Its data is in `~/Library/Application Support/Zuna Native`, the Windows app's folder name, as the Electron app's is `Zuna` there, and in `Zuna Native Dev` for a copy started from anywhere but Applications. The Electron app's Mac build becomes Zuna Legacy in `electron-builder.yml`, as it is on Windows and Linux.
2. **Media through FFmpeg,** with Linux's code, built from its pinned source with VideoToolbox, rather than AVFoundation, which would be new code for macOS alone and reads neither WebM nor Ogg. Cameras through AVFoundation.
3. **Encoding and decoding on the GPU wherever the Mac can,** and Apple silicon only. So a share's picture is captured in the app with macOS's picker and handed to VideoToolbox without a copy, and what arrives is drawn from VideoToolbox's buffers, rather than captured in `zuna-screenshare`, which would encode on the GPU too but needs Screen Recording permission and its monthly question without the picker.
4. **Local builds only, for now:** signed with the Apple Development identity on this Mac. Packages, notarization and updates wait for a Developer ID Application certificate. With the Developer ID in the keychain from 2026-11-08, `npm run dist:macos` makes the packages, since 2026-11-11 each release carries the DMG, made on CI, and updates are still to come.
5. **macOS 14.2 and later,** where everything the app does works.
6. **Windows and Linux aren't built during the port.** What breaks there is fixed there.
7. **Only this Mac is checked:** Apple silicon, macOS 27.

## Risks

- **Permissions in development.** Each rebuild with an ad hoc signature is a new app to macOS, which asks again for the microphone, the camera and the Keychain. The script signs with the Apple Development identity it finds, and says so when there's none.
- **Core Audio can hold a call forever.** Listing the devices once froze the window until they were read off its thread, and `zuna-screenshare --sound`, left with macOS's question about recording the computer's sound unanswered, never quit, stuck in `AudioDeviceDestroyIOProcID` as its tap closed. Both were seen with nobody at the Mac. Since the question was answered, the share's sound has started and stopped cleanly.
- **The picture viewer** over the menu bar and the Dock, transparent: GPUI's macOS windows may need a level set on the `NSWindow`.
- **Text looks heavier** through Core Text than through DirectWrite, so screenshots are compared with the Electron app on macOS, not with Windows.
- **Building FFmpeg** on each Mac takes a few minutes the first time, and its configuration is one more thing to keep with the version.
