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

### Move ashpd to 0.13 and oo7 to 0.6, as GPUI has them
- Where: apps/desktop/Cargo.toml:62-70 (`ashpd 0.11` commented "as GPUI's own portals", `oo7 0.5`); in Cargo.lock gpui_linux uses ashpd 0.13.13 and oo7 0.6.0, while oo7 0.5 pulls ashpd 0.12.3
- Category: deps
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: three copies of ashpd and two of oo7 build on Linux, and the comment says they're shared.
- Suggested change: move both to GPUI's versions (check which runtime feature gpui_linux selects); adapt linux/location.rs and device_key.rs:92-113.
- Check after: linux-check.mjs.

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

