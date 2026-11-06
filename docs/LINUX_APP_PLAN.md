# The native app on Linux: plan

Status: L0 done, and L1 built and checked in a nested KWin, waiting on its checks in the real Plasma session (2026-11-06).

Scope: the native app in `apps/desktop`, drawn with GPUI, running on Linux from the same crate as on Windows. There's no second codebase: what differs between the two is behind `#[cfg(target_os = ...)]` in `src/platform` and `src/media`, and everything else is shared. Three rules hold throughout:

- **Wayland only.** The app is built and checked for Wayland. Under X11 it doesn't start, and says so.
- **Windows doesn't change.** Its code is moved, never rewritten, and nothing added for Linux is compiled on Windows. Nobody checks Windows during the port: what breaks there anyway is fixed on Windows afterwards.
- **The interface doesn't change.** `src/ui` looks and behaves as it does on Windows. Where Linux can't do what Windows does, it does what the Electron app does on Linux, and nothing new is designed.

It's checked on KDE Plasma under Wayland, on this machine, and nowhere else.

## Summary

- **Most of the app is already portable.** The core's host (`src/host`), the interface (`src/ui`), voice (`src/voice`), `state.rs`, `markup.rs` and `models.rs` type-check on Linux unchanged. GPUI's Wayland backend and its Vulkan renderer, Blade, are in the vendored copy.
- **What isn't portable is in 16 files,** which call the `windows` crate with no `cfg`: all of `src/platform`, all of `src/media`, and a few lines of `ui/notifications.rs` and `ui/motion.rs`.
- **One dependency doesn't build on Linux:** `xattr` 0.2.3, which GPUI pulls in through `gpui_http_client` and `zed-async-tar`, uses `libc::ENOATTR`, which the `libc` in `Cargo.lock` no longer has on Linux.
- **Zuna's GPUI changes:** the ones in shared code already work on Linux. The one that matters most, frames only when one is wanted, is Windows only, and GPUI's Wayland backend has the same problem it fixed, so it gets a Wayland version (see "Zuna's changes to GPUI").
- **Linux follows the Electron app there:** the system's notifications rather than the app's own cards, `app.setBadgeCount`'s badge, the tray, no automatic updates, and the same five packages.
- **Media goes through the FFmpeg the repository already pins** for `zuna-screenshare` (`scripts/ffmpeg.mjs`), in place of Media Foundation. It has everything needed, and its libraries are already beside the screen capture.
- **Screen sharing, a share's sound and push to talk** are `zuna-screenshare`'s, which already does all three under Wayland for the Electron app. The native app starts it the same way.
- **Checked automatically in a KWin of its own,** started for each run inside the person's session, with the test server, LiveKit and the Electron app as the second person, and by hand in the real Plasma session for what needs a person's click.

## Where it stands

Checked on Arch (CachyOS) with KDE Plasma 6.8 on Wayland, Rust 1.99 from the distribution:

- `cargo check` stops at `xattr` 0.2.3: `cannot find value ENOATTR in crate libc`, with `libc` 0.2.191.
- With `xattr` patched to use `ENODATA`, which is what `ENOATTR` means on Linux, every dependency checks: the vendored GPUI, LiveKit and its prebuilt libwebrtc, cpal, rquickjs, rusqlite and the crypto crate. The app itself then has 489 errors, all in these files: `media/encode.rs` (65), `platform/icons.rs` (64), `platform/screens.rs` (61), `media/record.rs` (48), `platform/mod.rs` (44), `platform/tray.rs` (42), `media/mf.rs` (41), `platform/updates.rs` (40), `platform/ptt.rs` (29), `media/player.rs` (24), `platform/single.rs` (14), `ui/notifications.rs` (4), `ui/motion.rs` (4), `platform/clipboard.rs` (4), `platform/quiet.rs` (3), `platform/location.rs` (2).
- Nothing has been linked or run on Linux. `zuna-screenshare` links the same LiveKit on Linux, so libwebrtc's system libraries are known to work there.
- `scripts/windows-app.mjs` exits on anything but Windows, so there's no command to build it on Linux yet.

## Keeping Windows as it is

- **Moved, not rewritten.** Today's Windows code moves into `platform/windows/` and `media/windows/` as it is. Each move is its own commit, with nothing else in it, so `git diff -M --color-moved` shows only moved lines and the `mod` and `use` lines around them.
- **Linux code is only compiled on Linux.** New files sit under `platform/linux/` and `media/ffmpeg/`, behind `#[cfg(target_os = "linux")]` on the module.
- **GPUI's changes for Linux** go in `platform/linux/` where they can. Anything in GPUI's shared files is behind `cfg(target_os = "linux")`, so that Windows compiles the same code as before.
- **The same features on Windows.** GPUI's `x11` feature is turned off (see Building), which only means anything on Linux and FreeBSD. `font-kit` and `windows-manifest` stay on.
- **The same words and names on Windows.** "Windows PC", "Version … for Windows", "Windows couldn't protect this device's key", the data folder, `app_id`, the crate's name, `npm run dev:windows`, `build:windows` and `dist:windows`, and `scripts/windows-app.mjs` all stay. Linux gets its own words beside them, from `platform`.
- **No checks on Windows** during the port, as decided. The commit messages say that Windows wasn't built, and an agent on Windows fixes whatever broke.

## How the code is split

`src/platform` keeps the functions the rest of the app calls today, and gets a module for each system under it:

```
src/platform/mod.rs       the functions the app calls, each passing to the system's module
src/platform/windows/     today's code, moved
src/platform/linux/       the new code
```

The callers stay as they are, except:

- **The notification cards are Windows only.** `ui/notifications.rs` is compiled on Windows alone, with `make_popup`, `place_popup`, `hide_window`, `hwnd_of` and `work_area`. On Linux, `platform/linux/notifications.rs` gives the same `install` and the same calls, and shows the system's notifications (see Notifications).
- **What only differs in words or names comes from `platform`:** the device's name ("Linux PC" on Linux, as Electron names it), About's "Version … for Linux", and the sentence about an unprotected device key, each the same on Windows as now.
- **`ui/motion.rs`'s question about animations** moves into `platform::animations_off()`, with the same Windows code in it.
- **`format.rs` and `host/device_key.rs`** already have `cfg(not(windows))` versions, which become Linux's.

`src/media` gets the same split: `media/windows/` is today's Media Foundation, waveIn and waveOut code, and `media/ffmpeg/` the new one, used on Linux (see Voice and video messages).

## Each piece

### Building

- **`xattr`:** a `[patch.crates-io]` entry with the one line changed, in `vendor/xattr`, listed in `vendor/gpui/ZUNA.md` beside GPUI's changes. It's only compiled on Unix, so Windows doesn't see it.
- **No X11:** `gpui` is taken with `default-features = false` and `font-kit`, `wayland` and `windows-manifest`, which leaves out X11's client and its libraries. Without it, GPUI quietly runs with no window at all when there's no Wayland display (`guess_compositor` in `platform.rs` falls to "Headless"), so `main.rs` checks first: on Linux without `WAYLAND_DISPLAY`, it writes that Zuna needs a Wayland session to standard error, shows that as a system notification, and exits. `--core-check` and `--core-eval` run before that check, as they need no window.
- **The script:** `scripts/linux-app.mjs`, with `npm run dev:linux`, `build:linux` and `dist:linux`, beside the Windows one, which stays as it is. It bundles the core as the Windows one does, builds with the distribution's Rust, and keeps its target folder outside the checkout, in `~/.cache/zuna-desktop-target`, as the Windows script keeps its own.
- **What a build needs,** besides Rust, Node and a C compiler: the development files of `libxkbcommon`, `wayland`, `fontconfig` and `freetype2`. Vulkan, PipeWire and D-Bus are only needed while running. The first build in L0 says whether anything else is.

### The window and its title bar

The app draws its own title bar with Windows's three buttons, which Windows drags, snaps, minimizes, maximizes and closes through `window_control_area`. GPUI's Wayland windows ignore that: `on_hit_test_window_control` does nothing in `platform/linux/wayland/window.rs`. So on Linux the title bar does each of those itself, and looks the same:

- **Dragging:** `window.start_window_move()` on a press in the drag area, `window.zoom_window()` on a double click, and `window.show_window_menu()` on a right click, which Windows's own title bar does too.
- **Buttons:** `minimize_window`, `zoom_window`, and closing as the close request does today. The Electron app on Linux draws the same buttons (`titleBarStyle: "hidden"` with `titleBarOverlay` in `main/index.ts`).
- **Decorations drawn by the app:** `window_decorations: Some(WindowDecorations::Client)`, since KWin's would put a second title bar above this one.
- **Resizing:** `window.start_window_resize(edge)` from the outermost few pixels of each edge and corner, drawn as nothing but the resize cursor. A shadow or rounded corners, as Windows adds, would need a transparent margin around the window, which would change how it looks and where it is, so there's neither.
- **`app_id`** on Linux is the `.desktop` file's name, `zuna-native`. KWin finds the window's icon by it, and the portals, notifications and the badge find the app by it.

### One app at a time, and `zuna://` links

- **One for each data folder:** a lock on a file in the data folder (`File::try_lock`, in std since Rust 1.89), and a Unix socket in `$XDG_RUNTIME_DIR` named from the folder's hash, as the pipe is named now. A second start sends its link, or an empty line, and leaves.
- **Raising the window from a second start:** under Wayland only a token from `xdg_activation_v1` can bring a window to the front. A launcher hands one to the program it starts in `XDG_ACTIVATION_TOKEN`, so the second start sends it with the link, and the first activates its window with it. GPUI's `activate()` asks for a token of its own without a fresh serial, which compositors refuse, as its own comment says, so this needs a change to GPUI that activates with a given token.
- **`zuna://`:** the `.desktop` file has `MimeType=x-scheme-handler/zuna;` and `Exec=zuna-native %u`. A package installs it. An AppImage or a `.tar.gz` writes the person's own in `~/.local/share/applications` as it starts, and removes it once a package has one, as `main/desktop-entry.ts` does for the Electron app, which this ports.

### The device key

Sealed by the Secret Service, as Electron's safeStorage does with libsecret: KWallet here, which gives `org.freedesktop.secrets`. Through the `oo7` crate, which GPUI already uses on Linux for its own credentials, and which talks D-Bus itself, so libsecret isn't needed. The key is one item, found by attributes naming the app and the data folder's hash, so that `ZUNA_DATA_DIR` keeps working. With no Secret Service it's written alone with mode 0600 and counts as unprotected, as Electron's `basic_text` does, and Settings says so as it does on Windows. The key loads before GPUI starts, so this blocks on `oo7` once at start.

### Notifications, sound and the badge

- **The system's notifications,** as the Electron app shows them on Linux: `org.freedesktop.Notifications` over D-Bus, through `zbus`, which is already in `Cargo.lock` through GPUI. The app's name and the `desktop-entry` hint give it its icon. The default action opens the conversation. A notification is closed with `CloseNotification` when its chat is read or its message deleted, as the cards are taken back on Windows.
- **The app's own cards stay on Windows.** Under Wayland an app can't place its window or keep it above others, so they couldn't work. FEATURE_PARITY lists them under "Not possible or pointless there".
- **Quiet:** the notification server applies Do Not Disturb itself. The app's own sound asks the server's `Inhibited` property, which KDE has, and plays otherwise.
- **The sound:** the same synthesized two tones, played through the app's sound output (see Sound devices) rather than `PlaySoundW`, with the `suppress-sound` hint so the server adds none of its own.
- **The badge:** the count over the taskbar's icon through `com.canonical.Unity.LauncherEntry`, which `app.setBadgeCount` uses on Linux and KDE's task manager shows. The count is also drawn over the tray's icon.
- **Drawing attention:** `flash_main` becomes `window.activate_window()`, which asks for activation without a serial. KWin shows that as wanting attention, as GPUI's comment says.

### The tray, and closing to it

- **The icon:** a StatusNotifierItem over D-Bus, through the `ksni` crate, with Open Zuna and Quit, and Open on a click. The picture is `icons::tray_icon(count, ratio)`, whose drawing is already independent of Windows.
- **Closing minimizes the window,** with "Keep running when closed" on, since GPUI can't hide a window on Linux. It stays on the taskbar, and Open brings it back. Where the compositor says in xdg-shell's `wm_capabilities` that it can't minimize (GPUI's `window.window_controls()`), closing quits instead, and so does closing with no tray at all, when nothing owns `org.kde.StatusNotifierWatcher`. Neither happens on KDE.
- **Bringing it back** needs an activation token, as for a second start. KDE's tray hands one over through `ProvideXdgActivationToken` before `Activate`, which `ksni` may have to be taught, to be checked.
- **`main_visible()`:** Wayland doesn't tell a window it's minimized. The app knows when it minimized the window itself, so the window counts as away from then until it's active again. One the person minimized from the taskbar still counts as visible, unless GPUI learns xdg-shell's `suspended` state. Where it's used, whether the window has focus is asked too, so this only matters for a window in the background.

### Whether the person is here

- **Idle time:** `org.freedesktop.ScreenSaver.GetSessionIdleTime`, which KDE gives.
- **Locked or asleep:** logind's `Lock`, `Unlock` and `PrepareForSleep` signals, as Electron's `powerMonitor` gives them.

### Small settings

- **Animations off:** the Settings portal, through `ashpd`, which GPUI already has: KDE's `AnimationDurationFactor` at 0.
- **The 12-hour clock:** `nl_langinfo(T_FMT)` for the person's `LC_TIME`, which shows `%I` or `%r` for one. `format.rs` says no today on anything but Windows.

### The clipboard and dropped files

- **Pasting files copied in Dolphin:** they're offered as `text/uri-list`, which GPUI's Wayland clipboard doesn't read: it reads text and pictures (`wayland/clipboard.rs`). A change to GPUI reads it as paths, which `platform::clipboard_files()` then returns.
- **Dropping files:** GPUI's Wayland client already takes them as `text/uri-list` (`wayland/client.rs`).
- **Pasted pictures:** `save_pasted_image` is already the same on both.

### Location

GeoClue, through the location portal with `ashpd`, which works outside a sandbox too and asks in the system's own dialog where it asks at all. It needs `geoclue`, which the person installs here for the check, and which the packages recommend rather than require. The Electron app's location on Linux has never been checked, and Chromium's needs a Google key, so this may be the first that works there.

### Sound devices

cpal 0.16's only Linux backend is ALSA (it's the only one in `Cargo.lock`), which reaches PipeWire through its ALSA plugin. That plays and records, but its list of devices is ALSA's: "default", "pipewire", "sysdefault:CARD=…", "front:CARD=…,DEV=0", and opening one of the hardware ones takes the card away from PipeWire. Settings can't offer that as a list of microphones and speakers.

So on Linux the sound devices go through PipeWire itself: devices listed by their `node.description`, chosen by `node.name`, and streams opened with `target.object`. `apps/screenshare/src/capture/pipewire.rs` already loads `libpipewire-0.3.so.0` at run time and binds the part it needs, which can move into a small crate both programs use. cpal stays on Windows, behind the same `voice/audio.rs` functions. A first step can play and record through cpal's "default" with no choice of device, so that voice works before the device lists do.

WebRTC's echo canceller hears the mixed output inside the app, as now, so it doesn't depend on what's underneath. The app's sound comes from its own process, so `zuna-screenshare --exclude-pid` keeps it out of a share's sound, as it keeps Chromium's out.

### Voice and video messages, videos and sound files

On Windows, Media Foundation reads AAC, Opus and H.264 in MP4, writes AAC in MP4 for a voice message and H.264 and AAC in MP4 for a video message, and records from the camera, while waveIn and waveOut record and play the sound.

On Linux this goes through the FFmpeg that `scripts/ffmpeg.mjs` pins for `zuna-screenshare`: BtbN's 8.1, LGPL, shared libraries, checked against its SHA-256. That build has the H.264, AAC and Opus decoders, the AAC encoder, `libopenh264`, `h264_vaapi` and `h264_nvenc`, `libopus`, the MP4 muxer, and Video4Linux2 in `libavdevice`. `scripts/build-screenshare.mjs` already copies `libavcodec`, `libavformat`, `libavutil`, `libswresample` and `libswscale` into `apps/screenshare/dist`, which every package with the screen capture carries, so the app loads those same files and adds `libavdevice` for cameras.

- **Reading:** `libavformat` for MP4 and the other containers a sound or video file comes in, `libavcodec` to decode, `libswresample` to 48 kHz in one channel, and `libswscale` to BGRA.
- **Writing:** AAC in MP4 for a voice message, and H.264 Baseline (`libopenh264`) and AAC in MP4 for a video message, the same as Windows writes. Chromium on Linux writes Opus there, since it has no AAC encoder, which costs AVFoundation an eighth of a voice message and hasn't been tried in a video message on the iPhone, so AAC avoids both.
- **Binding it:** a small C file built with `cc` against the pinned headers, as `zuna-screenshare`'s `native/encoder.c` is, or generated bindings. Either way the libraries are loaded with an rpath of `$ORIGIN/screenshare`. Being shared libraries, they keep their Opus apart from the copy linked into libwebrtc, as long as the program exports none of its own symbols, which `nm -D` checks once it links.
- **Recording and playing sound** go through the app's own sound output and microphone (Sound devices) rather than waveIn and waveOut.
- **A soundboard sound** is read the same way, from anything FFmpeg reads.

### Cameras

Video4Linux2, as Chromium uses on Linux, through `libavdevice`'s `v4l2` input: each camera named by its card name, listing only the `/dev/video*` nodes that capture. It feeds the same `Camera::start_feed`, for voice channels, the camera test in Settings and video messages.

### Push to talk

- **The key, held in any window:** `zuna-screenshare --global-shortcuts` and `--push-to-talk KEY`, as `main/global-key.ts` runs them for the Electron app. The portal finds the app by the systemd scope it runs in, which a launcher names after the `.desktop` file. A development build started from a terminal has none, so there push to talk is greyed out and says why, as in the Electron app. Chromium makes its own scope, `app-<name>-<pid>.scope`, through systemd's `StartTransientUnit`, which the app could do as well.
- **Choosing the key** happens in the app's window, since nothing else sees keys under Wayland. GPUI's key events carry the key a layout makes, not the physical one that `KeyboardEvent.code` names, so either a change to GPUI passes the evdev code, or keys are named as on a US layout.

### Screen sharing

`voice/screen.rs` already starts `zuna-screenshare` and speaks its protocol, so what changes is how a source is picked, as the Electron app does it under Wayland:

- **The portal's dialog picks.** The picker only offers its two tabs, a screen or a window, with no pictures, and the program gets `--source screen` or `--source window` in place of `--monitor-at` and `--window`. `--portal-sources` says first whether there's a portal and what it shares, as `portalSources` in `native-screen.ts` asks. The picker's look in that case comes from `ScreenPicker.tsx`'s, which the Electron app shows under Wayland.
- **A window's sound:** the portal doesn't say whose window it is, so a window starts with no sound and the picker says to choose the app, as the Electron app does.
- **The program's name** has no `.exe`, and it's looked for in `screenshare` beside the app, then in the package's `/usr/lib/zuna-native/screenshare`.

### Updates

None on Linux, as for the Electron app (`updates.ts` returns on Linux): packages update through the system, and an AppImage by downloading a new one. `updates::start` and `install_on_quit` do nothing there, and `VERSION` stays shared.

### Packages

The same five as the Electron app: a `.deb`, an `.rpm`, a pacman package, an AppImage and a `.tar.gz`, for x64.

- **Made with nfpm** for the three packages, from one file of its settings, run with `go run` at a pinned version, since Go is already needed for the server; the AppImage with `appimagetool`, pinned and checked by hash; and the `.tar.gz` by the script.
- **Laid out as:** `/usr/lib/zuna-native/zuna-native`, `/usr/lib/zuna-native/screenshare/` with the screen capture and FFmpeg's libraries, `/usr/bin/zuna-native` linking to the program, `/usr/share/applications/zuna-native.desktop`, and the icons in hicolor from `apps/desktop-electron-legacy/resources/icons`.
- **What they depend on:** `libxkbcommon`, `wayland`, `vulkan-icd-loader` and a Vulkan driver, `fontconfig`, `freetype2`, `pipewire`, `xdg-desktop-portal` with a backend for the session, and a color emoji font such as Noto Color Emoji. Recommended: a Secret Service and `geoclue`.
- **Built here, for now:** `npm run dist:linux` makes them, and the release workflow stays as it is until it's decided otherwise.
- **glibc:** the program needs the glibc it was built against or newer. Packages built on this machine need Arch's, which is fine here. Once they're published, they'll have to be built in an old enough container, such as Debian 12's or Ubuntu 22.04's.

## Zuna's changes to GPUI

The vendored GPUI differs from 0.2.2 on crates.io in these files, compared file by file with the published crate: `app.rs`, `window.rs`, `platform.rs`, `elements/div.rs`, `elements/img.rs`, `elements/list.rs`, `elements/mod.rs`, the new `elements/smooth.rs`, and in the Windows backend `vsync.rs`, `platform.rs`, `util.rs` and `directx_devices.rs`. Nothing else in `src` was changed or removed. Each change, and what it means on Linux:

| Change (`vendor/gpui/ZUNA.md`) | Where | On Linux |
|---|---|---|
| Frames only when one is wanted | Windows's vsync thread, with `frame_wanted()` called from `window.rs` and `app.rs`; the second of presenting the same scene after input turned off on Windows | **Same problem, not fixed.** `WaylandWindow::frame()` asks for the next frame callback every time it runs, and `complete_frame` commits the surface each time, so a window on screen wakes the app at the display's refresh rate while nothing changes. After each input the same scene is presented again for a second. Gets a Wayland version (below) |
| The first frame after a rest drawn at once | Windows's `platform.rs` | **Same need,** once the above is in: a window at rest waits for a frame callback before drawing what input changed. Drawn at once instead, and the callback asked for after it |
| One Direct3D device at startup | `directx_devices.rs` | Nothing to port: the Wayland client makes Blade's Vulkan context once (`BladeContext::new` in `wayland/client.rs`). How long starting takes is measured, in case Vulkan's driver load needs the same care |
| `Window::cursor_style_under_mouse` | `window.rs`, every platform | Works as it is, for a double click to reply except on something clickable |
| Animated WebP from bytes | `platform.rs`, every platform | Works as it is |
| An animation's next frame when it's due | `elements/img.rs`, every platform | Works as it is. Until frames are only drawn when wanted, the window still wakes on every callback, but no longer draws the view each time |
| Smooth wheel scrolling | `elements/smooth.rs`, `div.rs`, `list.rs`, every platform | Works as it is: Wayland's client sends a notch as `ScrollDelta::Lines`, `value120 / 120 × 3`, as Windows sends three lines, so it glides 100 px; a touchpad's `Axis` events come as pixels and move at once. A high-resolution wheel's part of a notch glides its part. Each step asks for the next frame through `on_next_frame`, which the Wayland version of `frame_wanted()` has to answer |
| A cached view's own dependencies | `app.rs`, every platform | Works as it is: it fixed GPUI's own logic, not Windows's |

The Wayland version of "frames only when one is wanted", all of it behind `cfg(target_os = "linux")`:

- `frame_wanted()` gets a Linux branch: each window not already waiting for one asks for a frame callback, and commits so that the compositor sends it.
- `WaylandWindow::frame()` asks for the next callback only while something wants one: a dirty window, `request_animation_frame`, `on_next_frame`'s callbacks, or a scene still to present. Otherwise the surface is left alone.
- The second of presenting the same scene after input is turned off on Linux too, as on Windows.
- The first frame after a rest is drawn at once, as above.

What it's for is measured before and after (see Checks).

The changes Linux needs besides, each marked `Zuna:` where it is and listed in `vendor/gpui/ZUNA.md`:

1. Activating a window with a given `xdg_activation_v1` token, for a second start and the tray.
2. Reading `text/uri-list` from the Wayland clipboard as paths.
3. Optional: the physical key in key events, for choosing push to talk's key.

## Phases

| | What | Done when |
|---|---|---|
| L0 | It builds and runs: the `xattr` patch, GPUI without X11 and the refusal without Wayland, the moves into `platform/windows` and `media/windows`, Linux's `platform` and `media` doing nothing yet or saying "not on Linux yet", the script, `app_id`, the data folder, the device's name, the title bar and the window's edges, and the test setup (see Checks) | The app signs in to the test server and chats in the test KWin, each screen's screenshot matches the Electron app's layout, and the frame clock is measured as it is upstream |
| L1 | The desktop: frames only when wanted, one app at a time with `zuna://` and activation, the `.desktop` file, the device key, notifications, their sound, the badge, the tray and closing to it, idle and locking, animations off, the 12-hour clock, pasting copied files, location | Each checked as Checks says |
| L2 | Voice: sound through PipeWire with device lists, voice channels and calls, cameras, push to talk through the portal | A call and a voice channel with the Electron app, each hearing and seeing the other |
| L3 | Screen sharing through the portal, and a share's sound | A screen and a window shared to the Electron app, with sound |
| L4 | Voice and video messages, videos and sound files through FFmpeg, and the soundboard's sounds | The desktop's fixtures played here, and messages recorded here played by the Electron app |
| L5 | The packages, built here by `npm run dist:linux` | The pacman package installed and run here, the AppImage and the `.tar.gz` run here, the `.deb` and `.rpm` read |

L2 to L4 don't depend on each other once L1 is in.

## Checks

Everything is checked on this machine: KDE Plasma 6.8 under Wayland, with an RTX 5080 and NVIDIA's driver. Other desktops and compositors stay unchecked, and FEATURE_PARITY says so.

### A KWin of its own

`apps/desktop/test/linux-check.mjs` runs the app where it can't touch the person's own desktop, and runs every check that needs no person:

- **Its own session bus,** from `dbus-run-session`, so that nothing it registers or listens to reaches the person's own.
- **Its own KWin,** `kwin_wayland --virtual --socket zuna-test --width 1280 --height 832`, the Windows app's own size, at a scale of 1, then 2. The app is started in it with `WAYLAND_DISPLAY=zuna-test` and a throwaway `ZUNA_DATA_DIR`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME`.
- **A driver,** `apps/desktop/test/driver`, a small Rust program of its own, outside the app's crate: it moves the pointer, clicks, scrolls and types through KWin's `org_kde_kwin_fake_input`, takes screenshots through KWin's `org.kde.KWin.ScreenShot2`, and reads each window's state (active, minimized, its `app_id`, where it is) through KWin's scripting. KWin only gives the first two to a program whose `.desktop` file names them (`X-KDE-Wayland-Interfaces`, `X-KDE-DBUS-Restricted-Interfaces`, as Spectacle's does), so the run puts one for the driver in its `XDG_DATA_HOME`. That this is enough in a nested KWin is the first thing L0 checks.
- **Services standing in for the desktop's,** in the driver, on the private bus: a notification server that records each `Notify` and `CloseNotification` and invokes actions; a `StatusNotifierWatcher` with a host that reads the tray's icon, tooltip and menu, and clicks them; a listener for `LauncherEntry`'s signal; a `ScreenSaver` that answers with an idle time the check chooses; and a Settings portal that answers with the animations setting it chooses.
- **A real Secret Service:** `gnome-keyring-daemon` on the private bus, unlocked with a throwaway password, and runs without any.
- **The other side,** as `voice-check.mjs` starts it (`scripts/lib.mjs`): the test server, LiveKit, the core's bots, and the Electron app driven by Playwright as the second person.
- **Sound nobody hears:** the person's own PipeWire, with a sink and a source made for the run and removed after, as `sound-check.mjs` does it. What the app plays is recorded from the sink with `pw-record`, and a tone from `pw-play` goes into the source, each told apart by frequency.
- **A camera:** a `v4l2loopback` device, fed FFmpeg's `testsrc2` pattern. The person installs `v4l2loopback-dkms` and loads the module once, as it needs root.
- **Screenshots** saved for each screen and step, which are looked at, not only compared.

### In the real Plasma session

For what only the whole desktop shows, or what needs a person to click in a system dialog: the tray and the badge as plasmashell draws them, KWallet, the portals' dialogs for sharing a screen, binding push to talk's key and choosing a file, dragging a file in from Dolphin, minimizing from the taskbar and coming back, a scale of 125% and 150% on the real screen, the window on NVIDIA under the real compositor, and notifications as Plasma draws them. Screenshots come from `spectacle -b -n -o`. Where a dialog needs a click, the person is asked to make it, since the portal asks again each time and isn't told to remember.

### What's checked in each phase

| | In the test KWin | In the real session |
|---|---|---|
| L0 | `cargo test`. Starts, with a window whose `app_id` is `zuna-native`. Started with no `WAYLAND_DISPLAY`, exits with the message. `--core-check` without a window. Onboarding typed through, signing in, a chat with a bot both ways. Each screen's screenshot at a scale of 1 and 2, beside the Electron app's at the same size: the layout is the same, and only glyphs may differ, since GPUI draws text with cosmic-text and fontconfig there. The title bar: a drag moves the window, a double click maximizes and restores, each button works, and each edge and corner resizes | The window on the real screen |
| L1 | Frames: see below. A second start with a link hands it over, and the window becomes active. `xdg-open zuna://…` with the `.desktop` file in the throwaway `XDG_DATA_HOME`. The device key: an item in the keyring, the same key after starting again, and without a keyring a 0600 file and Settings' sentence. Notifications: what `Notify` was given, the default action opening the chat, `CloseNotification` once a bot reads it elsewhere, and with `Inhibited` no sound. The sound recorded from the sink, at 880 and 1174.66 Hz. The badge's counts. The tray's icon with the red count, `Activate` bringing the window back, Quit taking the icon away. Closing minimizes, and Open restores. Idle past 30 s, from the stand-in `ScreenSaver`, reported as away. Animations off stilling a menu, seen in screenshots taken while it opens. The 12-hour clock under `LC_TIME=en_US.UTF-8`, and the 24-hour one under `pl_PL.UTF-8`. A `text/uri-list` put on the clipboard with `wl-copy`, then Ctrl+V, making file chips | KWallet. The tray and badge in plasmashell. Coming back from the taskbar. Locking the screen with `loginctl lock-session`. Location, once `geoclue` is installed |
| L2 | Each device listed by its name, the run's own among them. A voice channel and a call with the Electron app: each hears the other's tone, by frequency, both ways. Choosing another device during a call. Mute, deafen and each person's volume. Ringing, answering, declining and a missed call. The camera both ways: the Electron app shows the test pattern, and the app shows the Electron app's fake camera. Settings' microphone test and camera test | Push to talk: the key bound in KDE's dialog, then pressed through `kglobalaccel`'s D-Bus, as the Electron app's was checked, heard as talking and stopping |
| L3 | The picker in its portal form, beside the Electron app's under Wayland | A screen and a window shared to the Electron app, which shows them, through KDE's dialog. A tone played by one app heard as the share's sound, with Zuna's own left out. Stopping, and closing the shared window ending it |
| L4 | `cargo test` reading the desktop's fixtures, `apps/ios/ZunaKit/Tests/ZunaHostTests/Fixtures`: `chromium-opus.m4a`, `firefox-opus.m4a`, `chromium-round.mp4` and `firefox-round.mp4`, with their length, samples, frames and poster. Writing a voice message and a video message, read back with the pinned `ffprobe` (AAC, H.264 Baseline, MP4) and decoded again. Recording each from the run's source and the test camera in the message box, sending it, and the Electron app playing it to its end. Its messages played here. A soundboard sound added from an M4A, an MP3 and a WAV | Playing out loud |
| L5 | | The pacman package installed, started from the menu with its icon, a `zuna://` link from a browser opening it, push to talk no longer greyed out, and removed. The AppImage and the `.tar.gz` run, each writing its `.desktop` file. The `.deb` and `.rpm` read with `dpkg-deb` and `rpm`, not installed |

### Frames and speed

Measured in the test KWin, before GPUI's Wayland change and after, and written into `vendor/gpui/ZUNA.md` beside the change:

- **At rest:** a chat on screen, nothing moving. Frame callbacks a second, counted from `WAYLAND_DEBUG=client`, and the CPU used, from `pidstat`. Upstream it should be the refresh rate. After the change, none.
- **After input:** the surface's commits for a key pressed and a menu opened. No commit without something new drawn.
- **From input to screen:** the time from the key's event to the commit that shows it, from the same log, at rest and while something else moves.
- **Scrolling:** a wheel's notch sent through the driver, and the list's offset each frame, from a debug log: 100 px a notch, eased out over about 150 ms, and notches during a glide adding to it.
- **An animated emote** keeping its own frame rate, from when its view is drawn.
- **Starting:** from starting the program to the first frame on screen.

### Shared code

- **The interface:** `git diff --stat` for each phase shows no change under `src/ui` but `ui/notifications.rs` (compiled on Windows alone), `ui/motion.rs` (its question moved into `platform`), `ui/settings.rs` (two sentences from `platform`) and `ui/screen_picker.rs` (the portal's form).
- **Windows:** not built or run during the port, as decided. Commit messages say so.

## Feature parity and the docs

- `.agents/FEATURE_PARITY.md`: "The native Windows app" becomes "The native desktop app", with what's different on Linux in each row, and a Known gap for each piece still to come, removed in the commit that closes it, as the file asks. Under "Not possible or pointless there": the app's own cards on Linux, and X11. Each Linux row says it was checked on KDE alone. Closing to the tray minimizing rather than hiding is written in the Linux row.
- `docs/WINDOWS_APP.md` becomes `docs/DESKTOP_APP.md`, covering both, with how the checks above run.
- `CLAUDE.md`: the commands table, "on Windows so far" in the first paragraph, and under "Decisions to keep" that the native app runs on Linux under Wayland only.
- `apps/site` only says the app runs on Linux once it's been checked there.

## Decisions

Decided 2026-11-06:

1. **Side by side with the Electron app,** as on Windows: called Zuna Native, with `zuna-native` as its program, `.desktop` file, `app_id` and package, and its own data folder, `~/.local/share/zuna-native`, so it never takes the Electron app's. Once the Electron app is retired, it becomes `zuna`, with nothing kept for the old name.
2. **Media through the pinned FFmpeg,** shared with `zuna-screenshare`, rather than GStreamer or the system's FFmpeg, whose codecs differ by distribution, or separate crates for each codec. Media Foundation stays on Windows.
3. **Sound devices through PipeWire on Linux,** with cpal kept on Windows, rather than cpal's ALSA list or PulseAudio's library. cpal's "default" is the first step.
4. **Closing to the tray minimizes the window,** rather than hiding it as the Electron app does, which GPUI can't do on Linux, closing it and opening a new one, which loses what lives in its views, or changing GPUI to unmap it, which needs the renderer's surface made again.
5. **Wayland only.** No X11 client, and no start under X11.
6. **The system's notifications on Linux,** never the app's own cards.
7. **Windows isn't checked during the port.** What breaks there is fixed there.
8. **Only KDE is checked.** Other desktops and compositors are left unchecked.
9. **Cameras are checked through `v4l2loopback`,** and location through GeoClue, each installed here by the person.
10. **The interface is compared with the Electron app on Linux,** at the same size, since there are no screenshots of the Windows app to compare with.
11. **The packages are built here,** not by the release workflow, for now.
12. **Nobody else is changing `apps/desktop`** while the port starts, so L0 moves the Windows code at once.

## Risks

- **GPUI on Linux is less used than on Windows and macOS.** Input methods (text-input-v3), fractional scaling and NVIDIA under Wayland are the places to look first.
- **Vulkan is required.** GPUI 0.2.2 has no OpenGL renderer on Linux, so a machine without a Vulkan driver can't open the window.
- **The nested KWin may not give the driver what it asks for.** If fake input or screenshots are refused there, the checks fall back to the RemoteDesktop portal and Spectacle, which a person has to allow.
- **The emoji font is the system's.** Color emoji depend on one being installed, which the packages ask for.
