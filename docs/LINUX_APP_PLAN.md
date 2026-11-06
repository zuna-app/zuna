# The native app on Linux: plan

Status: planned 2026-11-06, nothing ported yet.

Scope: the native app in `apps/desktop`, drawn with GPUI, running on Linux from the same crate as on Windows. There's no second codebase: what differs between the two is behind `#[cfg(target_os = ...)]` in `src/platform` and `src/media`, and everything else is shared. Wayland comes first, as `CLAUDE.md` decides for Linux. What GPUI already does under X11 keeps working, and nothing is built for X11 alone except where noted.

## Summary

- **Most of the app is already portable.** The core's host (`src/host`), the interface (`src/ui`), voice (`src/voice`), `state.rs`, `markup.rs` and `models.rs` type-check on Linux unchanged. GPUI's own Linux backends, Wayland, X11 and Blade on Vulkan, are in the vendored copy, and Zuna's changes to it are either for Windows only or for every platform.
- **What isn't portable is in 16 files,** which call the `windows` crate with no `cfg`: all of `src/platform`, all of `src/media`, and a few lines of `ui/notifications.rs` and `ui/motion.rs`.
- **One dependency doesn't build on Linux:** `xattr` 0.2.3, which GPUI pulls in through `gpui_http_client` and `zed-async-tar`, uses `libc::ENOATTR`, which the `libc` in `Cargo.lock` no longer has on Linux.
- **Linux follows the Electron app there,** which is the reference for what the desktop does on Linux: the system's notifications rather than the app's own cards, `app.setBadgeCount`'s badge, the tray, closing to it, no automatic updates, and the same five packages.
- **Media goes through the FFmpeg the repository already pins** for `zuna-screenshare` (`scripts/ffmpeg.mjs`), in place of Media Foundation. It has everything needed, and its libraries are already in every package beside the screen capture.
- **Screen sharing, a share's sound and push to talk under Wayland** are `zuna-screenshare`'s, which already does all three on Linux for the Electron app. The native app starts it the same way.

## Where it stands

Checked on Arch (CachyOS) with KDE Plasma on Wayland, Rust 1.99 from the distribution:

- `cargo check` stops at `xattr` 0.2.3: `cannot find value ENOATTR in crate libc`, with `libc` 0.2.191.
- With `xattr` patched to use `ENODATA`, which is what `ENOATTR` means on Linux, every dependency checks: the vendored GPUI, LiveKit and its prebuilt libwebrtc, cpal, rquickjs, rusqlite and the crypto crate. The app itself then has 489 errors, all in these files: `media/encode.rs` (65), `platform/icons.rs` (64), `platform/screens.rs` (61), `media/record.rs` (48), `platform/mod.rs` (44), `platform/tray.rs` (42), `media/mf.rs` (41), `platform/updates.rs` (40), `platform/ptt.rs` (29), `media/player.rs` (24), `platform/single.rs` (14), `ui/notifications.rs` (4), `ui/motion.rs` (4), `platform/clipboard.rs` (4), `platform/quiet.rs` (3), `platform/location.rs` (2).
- Nothing has been linked or run on Linux. `zuna-screenshare` links the same LiveKit on Linux, so libwebrtc's system libraries are known to work there.
- `scripts/windows-app.mjs` exits on anything but Windows, so there's no command to build it on Linux yet.

## How the code is split

`src/platform` keeps the functions the rest of the app calls today, and gets a module for each system under it, chosen with `#[cfg(target_os)]` on the module, never inside the callers:

```
src/platform/mod.rs       the functions the app calls, each passing to the system's module
src/platform/windows/     today's code, moved
src/platform/linux/       the new code
```

The callers stay as they are, with three exceptions:

- **`HWND` leaves the interface.** `ui/notifications.rs` names `windows::Win32::Foundation::HWND` to make, place and hide its popup. The cards are Windows only (see Notifications), so that file's window handling goes behind `cfg(windows)` along with `make_popup`, `place_popup`, `hide_window`, `hwnd_of` and `work_area`.
- **What differs by design is a constant,** not a `cfg` in the interface: `platform::OWN_NOTIFICATIONS`, `platform::DEVICE_NAME` ("Windows PC", or "Linux PC" as Electron names it), `platform::SYSTEM_NAME` for "Version 1.0 for Windows" in About.
- **Wording names no system** where both have it: "Windows couldn't protect this device's key" in `ui/settings.rs` becomes the system's.

`src/media` gets the same split: `media/windows` is today's Media Foundation code, and `media/ffmpeg` the new one, used on Linux (see Voice and video messages).

`ui/motion.rs`'s question about animations moves into `platform`, as `platform::animations_off()`. `format.rs` and `host/device_key.rs` already have `cfg(not(windows))` versions, which become real ones.

## Each piece

### Building

- **`xattr`:** a `[patch.crates-io]` entry with the one line changed, in `vendor/xattr`, listed in `vendor/gpui/ZUNA.md` beside GPUI's changes. It goes once GPUI's dependencies move to `xattr` 1.
- **The script:** `scripts/windows-app.mjs` becomes `scripts/desktop-app.mjs`, with `npm run dev:native`, `build:native` and `dist:native` in place of the `:windows` names. On Linux it uses the default toolchain, with no MSVC check, and a target folder outside the checkout, as on Windows: `~/.cache/zuna-desktop-target`, since `apps/desktop/target` isn't ignored.
- **The crate's name:** `zuna-windows` becomes `zuna-desktop`, and `main.rs`'s first line stops saying "for Windows".
- **What a build needs:** Rust, Node, a C compiler, and the development files of `libxkbcommon`, `wayland`, `alsa-lib` (cpal, while it's used), `fontconfig` and `freetype`. Vulkan, PipeWire, D-Bus and libsecret are only needed while running. To be confirmed by a first build in a clean container.
- **Windows keeps building after each step.** One of the two people pushing works on Windows, so each change is checked there with `npm run build:native`, or from Linux with `cargo xwin check --target x86_64-pc-windows-msvc`, which hasn't been tried with this crate.

### The window and its title bar

The app draws its own title bar with Windows's three buttons, which Windows drags, snaps, minimizes, maximizes and closes through `window_control_area`. GPUI's Linux windows ignore that: `on_hit_test_window_control` does nothing in `platform/linux/wayland/window.rs` and `x11/window.rs`. So on Linux the title bar does each of those itself:

- **Dragging:** `window.start_window_move()` on a press in the drag area, `window.zoom_window()` on a double click, and `window.show_window_menu()` on a right click.
- **Buttons:** `minimize_window`, `zoom_window`, and closing as the close request does today.
- **Decorations drawn by the app:** `window_decorations: Some(WindowDecorations::Client)` in `WindowOptions`, since GNOME has no server-side ones and KWin's would put a second title bar above this one. The app then draws its edges: when `window.window_decorations()` says the window isn't tiled, a few pixels of margin with a shadow and rounded corners, `window.set_client_inset()`, and `window.start_window_resize(edge)` from each edge and corner, as Zed does.
- **The buttons stay as they are.** The Electron app on Linux draws the same ones (`titleBarStyle: "hidden"` with `titleBarOverlay` in `main/index.ts`), so the two look alike.
- **`app_id`** becomes the `.desktop` file's name, `zuna-native` (see Decisions), not "Zuna". KWin and Mutter find the window's icon by it, and the portals, notifications and the badge find the app by it.
- **The window's icon:** under Wayland it comes from the `.desktop` file. Under X11, GPUI sets no `_NET_WM_ICON`, which a small change to GPUI could add.

### One app at a time, and `zuna://` links

- **One for each data folder:** a lock on a file in the data folder (`File::try_lock`, in std since Rust 1.89), and a Unix socket in `$XDG_RUNTIME_DIR` named from the folder's hash, as the pipe is named now. A second start sends its link, or an empty line, and leaves.
- **Raising the window from a second start:** under Wayland only a token from `xdg_activation_v1` can bring a window to the front. A launcher hands one to the program it starts in `XDG_ACTIVATION_TOKEN`, so the second start sends it with the link, and the first activates its window with it. GPUI's `activate()` asks for a token of its own without a fresh serial, which compositors refuse, as its own comment says, so this needs a change to GPUI that activates with a given token.
- **`zuna://`:** the `.desktop` file has `MimeType=x-scheme-handler/zuna;` and `Exec=zuna-native %u`. A package installs it. An AppImage or a `.tar.gz` writes the person's own in `~/.local/share/applications` as it starts, and removes it once a package has one, as `main/desktop-entry.ts` does for the Electron app, which this ports.

### The device key

Sealed by the Secret Service, as Electron's safeStorage does with libsecret: GNOME Keyring, KWallet (this machine has `org.freedesktop.secrets` from KWallet), or KeePassXC. Through the `oo7` crate, which GPUI already uses on Linux for its own credentials, and which talks D-Bus itself, so libsecret isn't needed. The key is one item, found by attributes naming the app and the data folder's hash, so that `ZUNA_DATA_DIR` keeps working. With no Secret Service, as under a bare window manager, it's written alone with mode 0600 and counts as unprotected, as Electron's `basic_text` does, with Settings saying so. The key loads before GPUI starts, so this blocks on `oo7` once at start.

### Notifications, sound and the badge

- **The system's notifications,** as the Electron app shows on Linux: `org.freedesktop.Notifications` over D-Bus, through `zbus`, which is already in `Cargo.lock` through GPUI. The app's name and the `desktop-entry` hint give it its icon. The default action opens the conversation. A notification is closed with `CloseNotification` when its chat is read or its message deleted, which the Electron app doesn't do on Linux. KDE's inline reply (`inline-reply`, `NotificationReplied`) can come later.
- **The app's own cards stay Windows only.** Under Wayland an app can't place its window or keep it above others, and GNOME has no layer shell, so they can't work there. It goes under "Not possible or pointless there".
- **Quiet:** the notification server applies Do Not Disturb itself. The app's own sound asks the server's `Inhibited` property, which KDE has, and plays otherwise, as Electron shows them always on Linux.
- **The sound:** the same synthesized two tones, played through the app's sound output (see Sound devices) rather than `PlaySoundW`, with the `suppress-sound` hint so the server adds none.
- **The badge:** the count over the taskbar's icon through `com.canonical.Unity.LauncherEntry`, which `app.setBadgeCount` uses on Linux, and KDE's task manager and Ubuntu's dock show. The count is also drawn over the tray's icon.
- **Drawing attention:** `flash_main` becomes `window.activate_window()`, which under Wayland asks for activation without a serial. KWin and Mutter show that as wanting attention, as GPUI's comment says.

### The tray, and closing to it

- **The icon:** a StatusNotifierItem over D-Bus, through the `ksni` crate, with Open Zuna and Quit, and Open on a click. The picture is `icons::tray_icon(count, ratio)`, whose drawing is already independent of Windows. KDE shows it. GNOME needs the AppIndicator extension, as for the Electron app.
- **With no tray at all,** when nothing owns `org.kde.StatusNotifierWatcher`, closing quits, since there'd be no way back.
- **Hiding the window:** GPUI can't hide a window on Linux, so closing to the tray closes the window and keeps the app, and Open opens a new one. What lives in the window's views is lost with it, so anything that has to outlive it moves into `AppState` first, such as each chat's draft. The alternative, unmapping the window inside GPUI, is in Decisions.
- **`main_visible()`** becomes whether the main window is open and not minimized, as far as the compositor says.

### Whether the person is here

- **Idle time:** `org.freedesktop.ScreenSaver.GetSessionIdleTime` (KDE), `org.gnome.Mutter.IdleMonitor.GetIdletime` (GNOME), and under X11 the MIT-SCREEN-SAVER extension through `x11rb`, which GPUI already uses. `ext-idle-notify-v1` would cover other Wayland compositors, on a connection of its own.
- **Locked or asleep:** logind's `Lock`, `Unlock` and `PrepareForSleep` signals, as Electron's `powerMonitor` gives them.

### Small settings

- **Animations off:** the Settings portal, through `ashpd`, which GPUI already has: GNOME's `enable-animations`, and KDE's `AnimationDurationFactor` at 0.
- **The 12-hour clock:** `nl_langinfo(T_FMT)` for the person's `LC_TIME`, which shows `%I` or `%r` for one. `format.rs` says no today on anything but Windows.

### The clipboard and dropped files

- **Pasting files copied in Dolphin or Files:** they're offered as `text/uri-list`, which GPUI's Linux clipboards don't read. Wayland's reads text and pictures (`wayland/clipboard.rs`), and X11's has `URI_LIST` commented out. A change to GPUI reads it as paths, which `platform::clipboard_files()` then returns.
- **Dropping files:** GPUI's Wayland and X11 clients already take them.
- **Pasted pictures:** `save_pasted_image` is already the same on both.

### Location

GeoClue, through the location portal with `ashpd`, which works outside a sandbox too and asks in the system's own dialog where it asks at all. The Electron app's location on Linux has never been checked, and Chromium's needs a Google key, so this may be the first that works there. It needs `geoclue` installed, which the packages recommend rather than require.

### Sound devices

cpal 0.16's only Linux backend is ALSA (it's the only one in `Cargo.lock`), which reaches PipeWire or PulseAudio through their ALSA plugins. That plays and records, but its list of devices is ALSA's: "default", "pipewire", "sysdefault:CARD=…", "front:CARD=…,DEV=0", and opening one of the hardware ones takes the card away from the sound server. Settings can't offer that as a list of microphones and speakers.

So on Linux the sound devices go through PipeWire itself: devices listed by their `node.description`, chosen by `node.name`, and streams opened with `target.object`. `apps/screenshare/src/capture/pipewire.rs` already loads `libpipewire-0.3.so.0` at run time and binds the part it needs, which can move into a small crate both programs use. cpal stays on Windows, behind the same `voice/audio.rs` functions. A first step can play and record through cpal's "default" with no choice of device, so that voice works before the device lists do.

WebRTC's echo canceller hears the mixed output inside the app, as now, so it doesn't depend on which sound server is underneath. The app's own sound comes from its own process, so `zuna-screenshare --exclude-pid` keeps it out of a share's sound, as it keeps Chromium's out.

### Voice and video messages, videos and sound files

Today Media Foundation reads AAC, Opus and H.264 in MP4, writes AAC in MP4 for a voice message and H.264 and AAC in MP4 for a video message, and records from the camera, while waveIn and waveOut record and play the sound.

On Linux this goes through the FFmpeg that `scripts/ffmpeg.mjs` pins for `zuna-screenshare`: BtbN's 8.1, LGPL, shared libraries, checked against its SHA-256. That build has the H.264, AAC and Opus decoders, the AAC encoder, `libopenh264`, `h264_vaapi` and `h264_nvenc`, `libopus`, the MP4 muxer, and Video4Linux2 in `libavdevice`. `scripts/build-screenshare.mjs` already copies `libavcodec`, `libavformat`, `libavutil`, `libswresample` and `libswscale` into `apps/screenshare/dist`, which every package with the screen capture carries, so the app loads those same files and adds nothing but `libavdevice` for cameras.

- **Reading:** `libavformat` for MP4 and the other containers a sound or video file comes in, `libavcodec` to decode, `libswresample` to 48 kHz in one channel, and `libswscale` to BGRA.
- **Writing:** AAC in MP4 for a voice message, and H.264 Baseline (`libopenh264`) and AAC in MP4 for a video message, the same as Windows writes. Chromium on Linux writes Opus there, since it has no AAC encoder, which costs AVFoundation an eighth of a voice message and hasn't been tried in a video message on the iPhone, so AAC avoids both.
- **Binding it:** a small C file built with `cc` against the pinned headers, as `zuna-screenshare`'s `native/encoder.c` is, or generated bindings. Either way the libraries are loaded with an rpath of `$ORIGIN/screenshare`. Being shared libraries, they keep their Opus apart from the copy linked into libwebrtc, as long as the program exports none of its own symbols, which `nm -D` checks once it links.
- **Recording and playing sound** go through the app's own sound output and microphone (Sound devices) rather than waveIn and waveOut.
- **A soundboard sound** is read the same way, from anything FFmpeg reads.

The same code can later replace Media Foundation on Windows, where the same FFmpeg is pinned. That's for later, once it's been checked on Linux.

### Cameras

Video4Linux2, as Chromium uses on Linux: `libavdevice`'s `v4l2` input, or the `v4l` crate, which has no C at all. The list names each camera by its card name, `/dev/video*` by capabilities rather than every node. Cameras that only work through libcamera, as on some newer laptops, need PipeWire's camera portal, which can come later. They feed the same `Camera::start_feed`, for voice channels, the camera test in Settings and video messages.

### Push to talk

- **Under Wayland:** `zuna-screenshare --global-shortcuts` and `--push-to-talk KEY`, as `main/global-key.ts` runs them for the Electron app. The portal finds the app by the systemd scope it runs in, which a launcher names after the `.desktop` file. A development build started from a terminal has none, so there push to talk is greyed out and says why, as in the Electron app. Chromium makes its own scope, `app-<name>-<pid>.scope`, through systemd's `StartTransientUnit`, which the app could do as well.
- **Choosing the key** happens in the app's window, since nothing else sees keys under Wayland. GPUI's key events carry the key a layout makes, not the physical one that `KeyboardEvent.code` names, so either a change to GPUI passes the evdev code, or keys are named as on a US layout.
- **Under X11:** raw key events from XInput2 on the root window, through `x11rb`, named from evdev codes. The Electron app does this with `uiohook-napi`, unchecked, so this is optional.

### Screen sharing

`voice/screen.rs` already starts `zuna-screenshare` and speaks its protocol, so what changes is how a source is picked:

- **Under Wayland the portal's dialog picks.** The picker only offers its two tabs, a screen or a window, with no pictures, and the program gets `--source screen` or `--source window` in place of `--monitor-at` and `--window`. `--portal-sources` says first whether there's a portal and what it shares, as `portalSources` in `native-screen.ts` asks.
- **A window's sound:** the portal doesn't say whose window it is, so a window starts with no sound and the picker says to choose the app, as the Electron app does under Wayland.
- **The program's name** has no `.exe`, and it's looked for in `screenshare` beside the app, then in the package's `/usr/lib/zuna-native/screenshare`.
- **Under X11** the program can't capture, so there's no share. That's a known gap rather than something to build, X11 being legacy.

### Updates

None on Linux, as for the Electron app (`updates.ts` returns on Linux): packages update through the system, and an AppImage by downloading a new one. `updates::start` and `install_on_quit` do nothing there, and `VERSION` stays shared.

### Packages

The same five as the Electron app: a `.deb`, an `.rpm`, a pacman package, an AppImage and a `.tar.gz`, for x64.

- **Made with nfpm** for the three packages, from one file of its settings, run with `go run` at a pinned version, since Go is already needed for the server; the AppImage with `appimagetool`, pinned and checked by hash; and the `.tar.gz` by the script.
- **Laid out as:** `/usr/lib/zuna-native/zuna-native`, `/usr/lib/zuna-native/screenshare/` with the screen capture and FFmpeg's libraries, `/usr/bin/zuna-native` linking to the program, `/usr/share/applications/zuna-native.desktop`, and the icons in hicolor from `apps/desktop-electron-legacy/resources/icons`.
- **What they depend on:** `libxkbcommon`, `wayland`, `vulkan-icd-loader` and a Vulkan driver, `fontconfig`, `freetype2`, `pipewire` (or `alsa-lib` while cpal plays), `xdg-desktop-portal` with a backend for the session, and a color emoji font such as Noto Color Emoji. Recommended: a Secret Service and `geoclue`.
- **glibc:** the program needs the glibc it was built against or newer, so a release is built in an old enough container, such as Debian 12's or Ubuntu 22.04's, which the release workflow runs on tags.

## Changes to GPUI

Each marked `Zuna:` where it is, and listed in `vendor/gpui/ZUNA.md`, as the Windows ones are:

1. Activating a window with a given `xdg_activation_v1` token, for a second start and the tray.
2. Reading `text/uri-list` from the clipboard as paths, on Wayland and X11.
3. Optional: the physical key in key events, for choosing push to talk's key.
4. Optional, X11: `_NET_WM_ICON`, and `_NET_WM_STATE_DEMANDS_ATTENTION` for drawing attention.

And one to look at before deciding: Zuna's "Frames only when one is wanted" is Windows only. On Linux GPUI still presents again for a second after each input. How often the app wakes when idle on Linux is to be measured before anything is changed there.

## Phases

| | What | Done when |
|---|---|---|
| L0 | It builds and runs: the `xattr` patch, the split of `platform` and `media` with Linux versions that do nothing or say "not on Linux yet", the script and its npm names, `app_id`, the data folder, the device's name, the title bar and the window's edges | `npm run dev:native` on Linux signs in to the test server and chats, and Windows still builds |
| L1 | The desktop: one app at a time with `zuna://` and activation, the `.desktop` file written for an AppImage, the device key in the Secret Service, notifications, their sound, the badge, the tray and closing to it, idle and locking, animations off, the 12-hour clock, pasting copied files | Each checked on KDE under Wayland, against the Electron app's behavior on Linux |
| L2 | Voice: sound through PipeWire with device lists, voice channels and calls, cameras, push to talk through the portal | A call and a voice channel with the Electron app, both hearing and seeing the other, as the Windows app was checked |
| L3 | Screen sharing through the portal, and a share's sound | A screen and a window shared to the Electron app, with sound, on KDE |
| L4 | Voice and video messages, videos and sound files through FFmpeg, and the soundboard's sounds | The desktop's fixtures played, and messages recorded here played by the Electron app and the iPhone |
| L5 | The packages, and the release workflow building them | Each installed and run in a clean VM: Debian or Ubuntu, Fedora and Arch |
| L6 | Breadth: GNOME and a wlroots compositor, X11, location, KDE's inline reply | Each checked, or written up as a known gap |

L2 to L4 don't depend on each other once L0 is in, so they can be done side by side.

## Checks

- `cargo test` in `apps/desktop`. `updates.rs`'s tests are Windows's, and go behind `cfg(windows)`.
- `zuna-native --core-check` and `--core-eval` work unchanged, for the core without a window.
- Against the test server (`npm run dev:server`) with the Electron app as the second person, as the Windows app was checked.
- On KDE under Wayland first, which this machine runs, then GNOME under Wayland, Sway or Hyprland, and KDE under X11. GNOME and the rest in VMs, as `deploy/test/install-check.sh` uses Lima.
- With NVIDIA's driver and with Mesa, since GPUI draws through Vulkan.
- How the app looks beside the Electron app on Linux, and beside itself on Windows: GPUI lays text out with cosmic-text and fontconfig there rather than DirectWrite, so lines and spacing tuned on Windows can move.

## Feature parity and the docs

- `.agents/FEATURE_PARITY.md`: "The native Windows app" becomes "The native desktop app", with what's different on Linux in each row, and a Known gap for each piece still to come, removed in the commit that closes it, as the file asks. The app's own cards and a share under X11 go under "Not possible or pointless there".
- `docs/WINDOWS_APP.md` becomes `docs/DESKTOP_APP.md`, covering both.
- `CLAUDE.md`: the commands table, "on Windows so far" in the first paragraph, and the `.agents` path names.
- `apps/site` only says the app runs on Linux once it's been checked there.

## Decisions

1. **Side by side with the Electron app,** as on Windows: called Zuna Native, with `zuna-native` as its program, `.desktop` file, `app_id` and package, and its own data folder, `~/.local/share/zuna-native`, so it never takes the Electron app's. Once the Electron app is retired, it becomes `zuna`, with nothing kept for the old name. Recommended.
2. **Media through the pinned FFmpeg,** shared with `zuna-screenshare`, rather than GStreamer or the system's FFmpeg, whose codecs differ by distribution, as Fedora's own leaves several out, or separate crates for each codec. Recommended.
3. **Sound devices through PipeWire on Linux,** with cpal kept on Windows, rather than cpal's ALSA list. Recommended, with cpal's "default" as the first step.
4. **Closing to the tray closes the window,** and opening makes a new one, rather than changing GPUI to unmap it, which needs the renderer's surface made again on Wayland. Recommended, after what lives in the views is moved out.
5. **X11:** what GPUI does there works, push to talk through XInput2 is optional, and there's no screen share. As `CLAUDE.md` decides.

## Risks

- **GPUI on Linux is less used than on Windows and macOS.** Input methods (text-input-v3 under Wayland, XIM under X11), fractional scaling and NVIDIA under Wayland are the places to look first.
- **Vulkan is required.** GPUI 0.2.2 has no OpenGL renderer on Linux, so a machine without a Vulkan driver, such as a VM without one, can't open the window.
- **Portals differ by desktop.** File dialogs go through the FileChooser portal, which `xdg-desktop-portal-wlr` doesn't provide, so a wlroots session needs the GTK backend beside it.
- **The emoji font is the system's.** Color emoji depend on one being installed, which the packages ask for.
