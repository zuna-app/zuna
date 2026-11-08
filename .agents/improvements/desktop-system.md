## Native desktop app: host, platform, voice, media, screenshare

Covered by reading: apps/desktop/src/{host,platform,voice,media}, main.rs, test_control.rs, build.rs, Cargo.toml and Cargo.lock, media-ffmpeg/, core-bundle/, installer/, test/*.mjs (session helpers and cleanup), apps/screenshare (main.rs, shortcut.rs, sound/mod.rs, Cargo.toml, a scan of the rest); the UI call sites where blocking happens (voice_settings.rs, chat.rs, state.rs); LiveKit and ksni sources in ~/.cargo/registry.
Skipped: src/ui/* beyond those call sites, test/driver, screenshare capture and encoder internals (pipeline.rs, capture/*, native/*.c, h264.rs), media/windows/{encode,mf}.rs, apple/camera.rs beyond device listing. Nothing built or run; perf claims come from reading code paths.

### Open the microphone and the camera off the window's thread
- Where: voice/mod.rs:584-589 (`connect` calls `open_microphone`), 565-582, 702-725 (`reopen_mic`, also from the 60 ms ticker at 688-691), 330-350 (`toggle_mic_test`); voice/audio.rs:367-389 (`Input::open` blocks on `started.recv()` until the device is found, built and played); media/camera.rs:55-60 (`record::open` on the caller's thread); callers ui/voice_settings.rs:246, ui/chat.rs:751, 765; dropping a `Camera` joins its reader thread (camera.rs:69-75), from `VoiceRoom::close` (room.rs:539) on the window's thread
- Category: perf
- Severity: medium ; Effort: M ; Confidence: high that it blocks, medium on how long
- What's wrong: joining a channel, reconnecting, switching mic or starting a recording waits on the device on the window's thread. On Windows, `find()` (audio.rs:27-36) enumerates every input by name when the chosen device isn't the default. On macOS the code's own comment (audio.rs:50-53) says Core Audio may "not answer at all". A Linux camera close can wait out V4L2's 500 ms dequeue timeout.
- Suggested change: build `AudioProcessingModule` and `Microphone` inside `background_executor().spawn` and hand back with `this.update`; keep creating `mic_source` synchronously so the join proceeds and the mic publishes when ready. Same for `reopen_mic`, `toggle_mic_test`, the camera test and the recorders. Drop `Camera` on a background thread, or make its `Drop` signal the reader and detach.
- Check after: linux-voice-check.mjs, mac-voice-check.mjs, `npm run dev:windows` (join with a non-default mic).

### Match Focus Assist's priority list against an ID the native app actually has
- Where: platform/windows/quiet.rs:15 (`APP_ID = "chat.zuna.app"`), 126; no code calls `SetCurrentProcessExplicitAppUserModelID` or the fork's `set_app_identity`; installer/zuna.nsi:86-88 creates shortcuts without an AppUserModelID
- Category: ux
- Severity: medium ; Effort: S ; Confidence: medium
- What's wrong: "chat.zuna.app" was the Electron app's AppUserModelID. The native process gets one derived by Windows, so `on_priority_list` can never match: under "Priority only", Zuna's cards are always held back, even after the person adds Zuna to the list.
- Suggested change: pick one ID (e.g. `chat.zuna.desktop`, the macOS bundle ID); set it at startup with `cx.set_app_identity` (gpui_windows/src/platform.rs:939); stamp it on the Start-menu shortcut in NSIS; use the same constant in quiet.rs.
- Check after: `npm run install:windows`, then Focus Assist "Priority only" with Zuna added. Note it in FEATURE_PARITY.

### Draw and write macOS notification pictures off the window's thread
- Where: platform/macos/notifications.rs:143-169 (`show` runs on the window's thread), 241-253 (decode, Lanczos resize, PNG encode, file write); platform/notification.rs:73-82 (the first set of initials calls `load_system_fonts()`)
- Category: perf
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: every macOS notification does image work and file IO on the window's thread, and the first can load every system font. Linux already does this on its own thread (linux/notifications.rs:67-84).
- Suggested change: move `picture_attachment` and `addNotificationRequest` to a background thread (`UNUserNotificationCenter` is thread-safe); warm the font options once on a worker, or load only Inter plus a small fallback set.
- Check after: mac-voice-check.mjs (`delivered`).

### Close the Linux location session when finding a position times out
- Where: platform/linux/location.rs:19-36, 38-51 (`recv_timeout` gives up after 20 s, but the thread keeps waiting on `updates.next()` with the portal session open); same shape in macos/location.rs:113-127 (up to 140 s) and windows/location.rs; caller ui/overlays.rs:813 runs it on GPUI's background executor
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: after a timeout, GeoClue keeps locating and the desktop's location indicator stays on until the app quits; each retry leaks another thread and session; a GPUI background thread is blocked for the whole wait. The `Found` enum and messages are copied three times.
- Suggested change: put the timeout inside `find` (`select` on `updates.next()` and a timer) so `session.close()` always runs; run `locate` on a dedicated thread with a oneshot back; optionally hoist `Found` and messages into platform/mod.rs.
- Check after: share a location with GeoClue off.

### Report a ScreenCaptureKit start failure instead of showing a share that sends nothing
- Where: platform/macos/screen_capture.rs:241-249 (the error from `startCaptureWithCompletionHandler` is only logged); voice/screen.rs:648-693 treats `Ok(Capture)` as sharing
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: if capture fails to start, the share is announced, the join sound plays and "sharing" shows, but no frames go out; viewers see a frozen or blank tile.
- Suggested change: share `on_stopped` through an `Arc` between `Output` and the `started` block and call it with the error; the watcher at screen.rs:675-687 then ends the share with a toast.
- Check after: mac-voice-check.mjs; by hand, close the picked window before capture starts.

### Re-enable the macOS push-to-talk event tap when macOS disables it
- Where: platform/macos/ptt.rs:154-184 (ignores `TapDisabledByTimeout` and `TapDisabledByUserInput`), 187-231 (keeps no handle to the port)
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: medium
- What's wrong: macOS turns a tap off after one slow callback or after secure input; push to talk then silently stops for the session.
- Suggested change: on either disabled event, `CGEvent::tap_enable(&port, true)` (port via `user_info` or a static); also reset `down` and tell the listener `false`.
- Check after: mac-voice-check.mjs (push to talk).

### Give up the screen-share slot and say why when there's no room key yet
- Where: voice/screen.rs:455-467 (`let Some(..) = room.current_key() else { return };` after `voiceScreenAccess` succeeded)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the click does nothing visible, `voiceScreenStop` is never called, and the server keeps counting a share slot that isn't in use.
- Suggested change: `share_failed(&server_id, &channel_id, "The voice key isn't ready yet.", cx)` instead of returning.
- Check after: linux-voice-check.mjs.

### Put a time limit on the share's sound start, and let it be cancelled
- Where: voice/screen.rs:243-255 (reads the program's first line a byte at a time, no timeout), 316-322 (`ask` uses `.output()`, no timeout)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: on macOS the program can wait up to two minutes for the audio permission (SCREEN_SHARE.md:66), blocking a GPUI background thread; stopping the share meanwhile can't reach the child (`share.sound` isn't set yet). A hung `--sound-apps` blocks the picker's worker forever.
- Suggested change: read the header on a dedicated thread with a deadline and kill the child on timeout; give `ask` a `try_wait` loop with ~5 s.
- Check after: mac-voice-check.mjs, linux-voice-check.mjs.

### Clear Linux's "minimized" flag from the window's activation, rather than polling every 250 ms
- Where: platform/linux/mod.rs:103-135; ui/mod.rs:110-120 already observes window activation
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: while minimized to the tray, the app wakes four times a second, possibly for hours (`idleCost` in the Linux check measures exactly this).
- Suggested change: add `platform::window_activated(bool)` (no-op on Windows and macOS), call it from the existing observer, delete the polling task.
- Check after: linux-check.mjs (tray, `idleCost`).

### Move the main-window command queue that Linux and macOS duplicate into platform/unix
- Where: platform/linux/mod.rs:32-171 and platform/macos/mod.rs:27-109 (same `Command` enum, `MAIN`, `COMMANDS`, `install`, `send`, `show`/`hide`/`flash_main`)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: move the shared parts to `platform/unix/window.rs`; keep only each system's `run`.
- Check after: linux-check.mjs, mac-voice-check.mjs.

### Build the notification WAV once for Windows and macOS
- Where: platform/windows/mod.rs:148-177 duplicates `notification_wav` in platform/mod.rs:231-251 (macOS-only)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: gate `notification_wav` with `cfg(any(windows, macos))` and use `WAV.get_or_init(super::notification_wav)` on Windows.
- Check after: `npm run dev:windows`.

### Use GPUI's resvg 0.46 instead of a second 0.45
- Where: apps/desktop/Cargo.toml:85-87 (`resvg = "0.45"`, commented "the resvg GPUI already has"); Cargo.lock has gpui on resvg 0.46.0 and the app on 0.45.1, so usvg, svgtypes, roxmltree, skrifa and read-fonts are duplicated
- Category: deps
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: the comment is false; two SVG stacks compile on Linux and macOS.
- Suggested change: bump to 0.46 and adapt platform/notification.rs:73-104 to any API changes.
- Check after: linux-check.mjs (initials), mac-voice-check.mjs.

### Move ashpd to 0.13 and oo7 to 0.6, as GPUI has them
- Where: apps/desktop/Cargo.toml:62-70 (`ashpd 0.11` commented "as GPUI's own portals", `oo7 0.5`); in Cargo.lock gpui_linux uses ashpd 0.13.13 and oo7 0.6.0, while oo7 0.5 pulls ashpd 0.12.3
- Category: deps
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: three copies of ashpd and two of oo7 build on Linux, and the comment says they're shared.
- Suggested change: move both to GPUI's versions (check which runtime feature gpui_linux selects); adapt linux/location.rs and device_key.rs:92-113.
- Check after: linux-check.mjs.

### Drop dependencies nothing uses
- Where: apps/desktop/Cargo.toml:43 (`anyhow`), 53 (`open`), 46 (env_logger's `humantime` feature, while main.rs:38-47 formats timestamps with chrono), 28 (`tokio-rustls`, which tokio-tungstenite already brings)
- Category: deps
- Severity: low ; Effort: S ; Confidence: high for anyhow and open, medium for the other two
- Suggested change: remove them; build on all three systems; if tokio-rustls turns out to pin a feature, say so in a comment.
- Check after: `npm run dev:windows`, `dev:linux`, `dev:macos` builds.

### Line up the app's HTTP, WebSocket and windows crates with LiveKit's and GPUI's
- Where: apps/desktop/Cargo.toml:27, 32 (tokio-tungstenite 0.30, reqwest 0.13) vs livekit-net's 0.29 and 0.12; Cargo.toml:95-98 (windows 0.61) vs gpui's 0.62
- Category: deps
- Severity: low ; Effort: M ; Confidence: medium
- Suggested change: move to windows 0.62 (screenshare already uses it). For tungstenite and reqwest, match LiveKit's versions or note in Cargo.toml that the duplication is deliberate until LiveKit moves.
- Check after: `npm run dev:windows`, linux-check.mjs.

### Ring with GPUI's timer, not a new OS thread per ring
- Where: voice/mod.rs:1099-1107, 1281-1288 (`smol_timer` spawns a sleeping thread every 2.6–3 s)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: clone `cx.background_executor()` and await `executor.timer(...)` inside the task; delete `smol_timer`.
- Check after: linux-voice-check.mjs (ringing).

### Save voice settings atomically, and not on every slider step
- Where: voice/settings.rs:100-109 (writes directly over the old file); voice/mod.rs:915-927, 942-946 (saves on every change, slider drags included, on the window's thread)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: a crash mid-write leaves truncated JSON, which loads as all defaults, silently losing every voice setting and per-person volume; slider drags do disk IO many times a second. (apps/desktop/src/settings.rs has the same non-atomic write; see desktop-ui.md.)
- Suggested change: write a `.partial` file and rename it, as device_key.rs:41-48 already does; debounce saves by ~300 ms and write on the background executor.
- Check after: `npm run dev:windows`.

### Remove the browser-share settings and the "native" flag the native app never reads
- Where: voice/settings.rs:40-49 (`screen_content`, `screen_priority`, `screen_native`, `screen_codec`, `screen_layers` never read); voice/mod.rs:48 (`ShareInfo::native`, always `true`, set at screen.rs:446, read at screen.rs:547 and ui/voice_stage.rs:817)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: these were for the Electron browser path; `native` is also true for macOS's in-app capture, which isn't the native program, so its meaning is muddled.
- Suggested change: delete the five fields and `native`, simplify the readers.
- Check after: `npm run dev:windows`, mac-voice-check.mjs.

### Cache the Linux tray's icons rather than decoding PNGs on every unread change
- Where: platform/linux/tray.rs:42-52 (`icon_pixmap` decodes and resizes six sizes per call); platform/mod.rs:220-229 (`app_icon` decodes per call); ksni 0.3.7 (service.rs:598-619) hashes `icon_pixmap()` on every update, and `set_unread` (tray.rs:95-99) triggers one
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: fill a `OnceLock<Vec<ksni::Icon>>` once; memoize `app_icon` by size (the Windows tray, overlay and notification drawing call it too).
- Check after: linux-check.mjs.

### Reuse the session bus for the portal's source types
- Where: platform/linux/screens.rs:10-31 (`shared_kinds` opens a new D-Bus connection per call, twice per picker)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: use `super::bus::session()` and read the source types once per picker.
- Check after: linux-voice-check.mjs.

### Free the macOS video message writer when recording fails part way
- Where: media/apple/ffmpeg.rs:74-111 (`RoundWriter` has no `Drop`); media/round.rs:41-42 (an early `?` drops it unfinished)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: on any encoder error, the library's FFmpeg contexts and an open file leak for the session.
- Suggested change: hold `Option<*mut c_void>`, take it in `finish`, free it in `Drop` (finish or a new `zuna_media_round_free` in ffi.rs).
- Check after: `cargo test` in media-ffmpeg, mac-voice-check.mjs.

### Hand decoded video frames across the macOS FFI without an extra copy
- Where: media/apple/ffmpeg.rs:165-179 (copies each BGRA frame into a new `Vec`, then frees the library's buffer; symbols looked up with `dlsym` on every call); consumer ui/media_views.rs:491-512
- Category: perf
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: an extra allocation and copy per frame (~240 MB/s at 1080p30), macOS only.
- Suggested change: a `next_into` that writes into a caller-allocated buffer; cache the function pointers.
- Check after: `cargo test` in media-ffmpeg, mac-voice-check.mjs.

### Share media's constants and `poster` between the app and media-ffmpeg
- Where: media-ffmpeg/src/lib.rs:5-44 copies `RATE`, `ROUND_SIZE`, `ROUND_FPS`, `Details`, `Frame` and `poster` from src/media/mod.rs:49-105
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: change one and the macOS library silently keeps the old values.
- Suggested change: move them into src/media/common.rs and include it in media-ffmpeg with `#[path]`, as it already does for mf.rs and encode.rs.
- Check after: `cargo test` in media-ffmpeg.

### Stop leaking entries in the Linux notification center
- Where: platform/linux/notifications.rs:186-192, 72-77 (a failed `Notify` leaves its `waiting` entry, which can hold an `Arc<Image>`); `shown` (line 46) only shrinks on close, click or clear
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: send `Heard::Failed { local }` on error and remove the entry; cap `shown` (e.g. newest 200).
- Check after: linux-check.mjs.

### Check the update's signer more strictly, and off the window's thread
- Where: platform/windows/updates.rs:30-48 (`WinVerifyTrust` over the whole exe at start, on the window's thread, from main.rs:205), 131-187 (compares only the certificate's simple display name), 117 (`WTD_REVOKE_NONE`)
- Category: robustness (security-adjacent)
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: hashing a large signed exe delays the first frames of installed, signed builds. Any valid Authenticode certificate, from any CA, whose display name matches the publisher's would be accepted, and the update then runs silently as the app quits.
- Suggested change: check in the `zuna-updates` thread; compare the full subject DN plus the issuer (don't pin thumbprints, which change on renewal); consider whole-chain revocation for the downloaded installer only. Releases carry no desktop installer right now (see the docs findings), so this matters once that job returns.
- Check after: the `reads_a_signed_program_s_publisher` test, `npm run install:windows`.

### Recover on Linux when the Secret Service wasn't there yet
- Where: host/device_key.rs:15-39 (a key once stored plain in `device-key.bin` is never sealed later), 104-126 (an unseal failure is final: main.rs:164-167 sets `Failed`, and the failed screen at ui/mod.rs:691 has no retry)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: an autostart at login can race the keyring. On a first start that leaves the key unprotected forever; on later starts the app fails until restarted by hand.
- Suggested change: wait (bounded, ~20 s) for `org.freedesktop.secrets` on the bus before trying; when `device-key.bin` exists and sealing now works, write `device-key.sealed` and remove the plain file, keeping the same key bytes. Asks nothing of the person, so CLAUDE.md's "no added step" rule holds.
- Check after: linux-check.mjs, plus a manual start with gnome-keyring stopped, then started.

### Make the macOS and Linux checks unable to hang or leave things behind
- Where: test/mac-session.mjs:112-120 (`send` has no timeout), 139, 144-146 (apps started with `open -n` are never killed); mac-voice-check.mjs:196-198; test/linux-session.mjs:176-183 (null sinks loaded into the person's own PipeWire), 251-271, 228-235 (`drive` has no timeout); no SIGINT or uncaughtException handler in any check
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: a hung app makes the mac check hang forever, even in its `finally`. Ctrl+C on a Linux check leaves `zuna_check_*` sinks loaded until logout, plus a nested KWin and a keyring daemon.
- Suggested change: race `send` and `drive` against a 30 s timeout; record each app's PID and kill it in `finish`; register an idempotent `finish` on SIGINT, SIGTERM and uncaughtException.
- Check after: Ctrl+C mid-run; `pactl list short modules` should be clean.

### Cap what the shared picture fetch downloads, and retry failed pictures
- Where: host/mod.rs:208-230 (`response.bytes()` with no size cap); state.rs:1265-1291 (`Picture::Failed` kept forever)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: a server icon or emote URL can return any amount of data into memory (link previews already cap at 5 MB, web.rs:159-169). A transient failure at start leaves an icon or emote blank until restart. (iOS has the same "failed forever" emote issue.)
- Suggested change: stream with `chunk()` and stop at ~8 MB; retry a failed picture after ~60 s.
- Check after: `npm run dev:windows`.

### Don't let repeating core timers burst after a stall
- Where: host/runtime.rs:299-308 (`interval_at` with tokio's default `MissedTickBehavior::Burst`)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: low
- What's wrong: after the core thread stalls (argon2, a big sync), or across sleep where the clock counts it, every missed tick is queued back to back, so JS `setInterval` callbacks run in a burst, which browsers never do.
- Suggested change: `set_missed_tick_behavior(MissedTickBehavior::Delay)` right after creating the interval.
- Check after: `npm run dev:windows`, idle across a sleep.

### Register zuna:// in one place on Windows
- Where: platform/windows/single.rs:90-107 (rewrites the registry with "URL:Zuna" on every start of the installed copy, main.rs:73-75); installer/zuna.nsi:100-103 (writes the same keys with "URL:Zuna invite link")
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: keep one, or make the strings match and comment why the app re-registers.
- Check after: `npm run install:windows`.

### Fix comments that point at removed Electron files or claim things that aren't so
- Where: host/web.rs:2 (`preview-proxy.ts`); host/mod.rs:3 ("the desktop's page and its Worker"); platform/linux/ptt.rs:3-4, 262 (`global-key.ts`, `zuna-screenshare --push-to-talk`); linux/screens.rs:3 (`native-screen.ts`); linux/desktop_entry.rs:5 (`desktop-entry.ts`); macos/menu.rs:1-2 (`main/index.ts`); windows/quiet.rs:3-4; windows/ptt.rs:2; macos/ptt.rs:2; host/device_key.rs:11 ("False only if Windows wouldn't", but Linux and macOS can return false too); core-bundle/build.mjs:1 ("the Windows app") and :39 (says `zuna-highlight.js` loads at the first code block; nothing in apps/desktop loads it, and FEATURE_PARITY lists highlighting as a gap); Cargo.toml:2, :6 (crate named `zuna-windows`, "Zuna's native Windows app"); installer/zuna.nsi:43-44 ("such as the desktop app"); many headers saying "as the desktop does" mean the Electron app (e.g. platform/mod.rs:32, 122, 179; voice/screen.rs:38-39)
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: say "the Electron app's (in git history before e55fd3c)", or drop the comparison; fix the factual ones. Renaming the crate from `zuna-windows` touches scripts/*-app.mjs and the bundle paths, so do it as its own commit, if at all.
- Check after: builds on each system.
