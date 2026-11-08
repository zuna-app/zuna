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

