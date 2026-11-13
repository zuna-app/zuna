## Tests of the Linux platform's own logic

Written on 2026-11-13, at `01e7cbe`, after the native app's interface tests took the desktop's coverage to about 77%. Codecov's desktop coverage comes from `coverage.yml`'s `desktop` job, which runs `cargo llvm-cov --ignore-filename-regex '(^|/)(crypto|\.deps)/'` in `apps/desktop` on `ubuntu-latest`, so of `src/platform` it sees only what builds for Linux: 33.6% there, 578 of 1718 lines, at `01e7cbe`.

Most of what's left talks to the system (D-Bus, the portals, Wayland, PipeWire), which unit tests don't have. Leave that to `apps/desktop/test/linux-check.mjs` and `linux-voice-check.mjs`. These entries are only what can be computed with no system at all, worth about 100 to 150 lines. None of them changes what the app does.

`platform/linux` builds only on Linux, so work through this on a Linux machine. The tests are plain `#[test]`s in a `#[cfg(test)] mod tests` at the end of each file, as `desktop_entry.rs` and `ptt.rs` already have, with no GPUI or `crate::testing::App`.

Set up as CLAUDE.md says: `sh scripts/linux-build-deps.sh`, `npm install`, `npm run build:crypto`, `node apps/desktop/core-bundle/build.mjs`, `node scripts/webrtc-sys.mjs` and `node scripts/ffmpeg.mjs`, then `cargo test` in `apps/desktop`, or `cargo test --bin zuna -- platform::` for these alone. Measure `src/platform` before and after with the command above and `--lcov --output-path`, and say both in the last commit's body. Commits are `desktop: …`, and say "Built and tested on Linux only; Windows and macOS weren't built."

### The tray's icon and menu
- Where: apps/desktop/src/platform/linux/tray.rs (6.6%)
- Category: tests
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `ZunaTray`'s methods are pure, apart from `start` and `activate`, and untested.
- Suggested change: make a `ZunaTray { unread, events }` with an `unbounded` channel. Test `id`, `title`, `category`, `tool_tip` with and without unread messages, `icon_pixmap` (six sizes, ARGB, `w * h * 4` bytes each), and `menu()`: activating "Open Zuna" and "Quit" sends `TrayEvent::Open` and `TrayEvent::Quit`.
- Check after: `cargo test --bin zuna -- platform::linux::tray`

### Small ones, if there's room
- Where: apps/desktop/src/platform/linux/mod.rs (14%), apps/desktop/src/platform/unix/single.rs (0%), apps/desktop/src/platform/linux/ptt.rs (37%)
- Category: tests
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: a few more pure functions, untested or barely.
- Suggested change:
  - `set_activation_token` and `take_activation_token` (a second take is `None`), `main_activation`, `wayland_session`;
  - `socket_path`, the same for one folder and different for two;
  - `claim` in a temporary folder: a second claim in the same process should be `Claim::Running`, as a file's lock is per open file. Confirm that before a test relies on it.
  - more cases for `code_of` and `trigger_of` in the test `ptt.rs` has.
- Check after: `cargo test --bin zuna -- platform::`, then the whole `cargo test` in `apps/desktop`
