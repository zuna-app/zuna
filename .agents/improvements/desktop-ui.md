## Native desktop app: interface (`apps/desktop/src/ui`, `state.rs` and friends)

Covered: apps/desktop/src/ui/* (read chat.rs, message.rs, mod.rs, conversations.rs, components.rs, motion.rs, scrollbar.rs, text_input.rs, picker.rs, media_views.rs, side_panel.rs, voice_settings.rs; hot paths of voice_stage.rs, voice.rs, overlays.rs, notifications.rs, channel_message.rs), plus state.rs, models.rs, markup.rs, format.rs, theme.rs, settings.rs, main.rs, compared against packages/ui where behaviour differed. GPUI behaviour was checked in a local checkout of the fork (an older rev than the pin), so GPUI-dependent claims are marked.
Skipped or skimmed: onboarding.rs, the settings UI, server_settings.rs, server_voice.rs, soundboard.rs, stream_stats.rs, screen_picker.rs, invites.rs, shared_media.rs, selection.rs and menu.rs internals. Nothing was built or run.
Ordered roughly by value.

### Rebuild the chat's row context and markup cache only when something it uses changed
- Where: ui/chat.rs:317-323 (observer), 455-485 (`sync_rows` hashes every loaded message), 2502-2577 (`chat_context` clones `users` and `mentionable`), 2740-2745; ui/message.rs:62-64 (the `parsed` cache lives inside the context); state.rs:726 (`handle_event` always notifies)
- Category: perf
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong: any notification drops `context_cache` (presence on another server, typing elsewhere, a debounced "conversations" event before its data arrives, the media tick). The next draw clones the user map, re-parses every visible message (the parse cache goes with the context) and re-hashes the text of up to 20 pages of messages. The comments at chat.rs:2740-2741 and message.rs:62-63 say this happens only "when the chat's state changed", which overstates it.
- Suggested change: keep the parse cache in `ChatView`, keyed by (id, text hash, mentionable generation). Add generation counters to `ServerState` (users, conversations, prefs) and a `version` to `MessageList`; the observer skips work when this server's and this list's counters haven't changed. `handle_event` notifies only when it changed something. Fix the two comments.
- Check after: `npm run dev:windows` (a channel on the test server with bots talking); `npm run dev:linux` and apps/desktop/test/linux-check.mjs.

### Notify the view that owns a hover or tooltip instead of refreshing the whole window
- Where: ui/motion.rs:533-545 (`track_hover` calls `window.refresh()`); ui/components.rs:320 and ui/message.rs:1122 (refresh on every mouse move while a tooltip or emote card shows); ui/scrollbar.rs:175, 186, 192, 209
- Category: perf
- Severity: medium ; Effort: M ; Confidence: high (verified in the fork: `Window::refresh` sets `refreshing`, and `AnyView::cached` is bypassed while it's set, view.rs:551)
- What's wrong: every hover in or out of a button redraws the cached message list and conversation list in full; while any tooltip is visible every pointer move does too; so does dragging a scrollbar thumb.
- Suggested change: capture `window.current_view()` when the element is built and call `cx.notify(view)` in the handler (`track_hover` and `hover_layer` need `window` passed in). Tooltips and emote cards notify their own entity (via `cx.entity().downgrade()`). The scrollbar notifies the view that owns the scrolled content.
- Check after: `npm run dev:windows` (hover fades and tooltips still behave); Linux and macOS builds.

### Let finished transitions go from `TRANSITIONS`
- Where: ui/motion.rs:246-319, 550-560; per-message keys in ui/message.rs:533-571, 1140-1155
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every key `transition` or `tween` sees is kept forever. Each message row adds six keys (hover and color for each of three action buttons), each reaction two more, so the map grows by tens of thousands of entries over a session. `ROWS` has the same problem on a smaller scale. `FIRST_SEEN` already prunes itself.
- Suggested change: add a `last_used` time; above a size limit, keep only entries that are running or were used recently. Same for `ROWS`.
- Check after: `npm run dev:windows`.

### Decode data-URL thumbnails once, not on every draw
- Where: ui/message.rs:1259, 1438-1445, 1482; ui/media_views.rs:326, 381; ui/chat.rs:1721 (composer link preview, which renders every frame)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `data_url_image` base64-decodes the thumbnail and builds a new `Image` (which hashes all its bytes) on every draw of the row. In `attachments()` the thumbnail is decoded before checking whether the full picture is already there, so it's usually wasted.
- Suggested change: cache the decoded image by a hash of the data string; decode only in branches that show the thumbnail; keep the composer preview's decoded image inside `LinkDraft`.
- Check after: `npm run dev:windows`.

### Virtualize the conversation list and stop cloning per row
- Where: ui/conversations.rs:170-312 (174 peer clone, 178 `preview_for` runs the `plain_text` regexes, 282 `item.clone()`, 284 `prefs.clone()` per row), 548-556, 688-691
- Category: perf
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong: every row is built on every `AppState` notification. Each row clones its whole conversation and the server's preferences into its right-click closure, and runs nine regexes over the last message. Everyone on a server can be messaged from the start, so a few hundred people means a few hundred heavy rows per presence or typing event.
- Suggested change: build the menu lazily from state inside the handler; cache `preview_for`; move the rows into `gpui::list`/`uniform_list`, or skip building rows far off screen as the picker's `near` does.
- Check after: `npm run dev:windows` against a server with many users (add bots via packages/core/test/dev-bots.ts).

### Refresh the pins panel when pins change, and don't flash the empty state while loading
- Where: ui/side_panel.rs:115-133, 1071-1078; web: packages/ui/src/features/chat/SidePanel.tsx:627-638
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: pins are fetched once per panel and never again, so pinning or unpinning while the panel is open leaves the list stale. `pins` is set to an empty list before the call returns, so "No pinned messages yet." flashes on every open. The web reloads whenever the set of pinned ids changes, and shows nothing while loading.
- Suggested change: keep `None` while loading, and reload when the ids of pinned messages in the loaded list change. Consider the web's empty text: "Nothing is pinned yet. Right-click a message to pin it."
- Check after: `npm run dev:windows`; check iOS behaves the same.

### Scope named scroll handles to their owner instead of one global per name
- Where: ui/scrollbar.rs:53-65; used by "conv-list", "member-list", "modal-body"/"modal-flow", "new-group-people", "picker-body", "composer-scroll"
- Category: ux
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: each name maps to one handle forever, so scroll position carries over between unrelated instances: the conversation list keeps the previous server's offset; the member list keeps another channel's; dialogs and the picker reopen where the last one was scrolled; chats share the composer's scroll.
- Suggested change: make handles fields of the owning view (as `SidePanel` does at line 76), or key them by owner. Reset the picker's handle on open.
- Check after: `npm run dev:windows`.

### Mirror camera frames in place, without per-row allocations, on the UI thread
- Where: ui/voice_stage.rs:101-140 (110 full clone; 125-133 a `Vec` per row); ui/voice_settings.rs:256-274 (263-266)
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: for each new frame (up to 60/s), `render` clones the frame, may copy a crop, and mirrors your own camera by building a new vector for every row. media/round.rs:62-75 already mirrors in place by swapping pixels.
- Suggested change: swap pixels in place as round.rs does; crop by copying rows straight into the new buffer; ideally do both on the thread that fills `tile.feed`.
- Check after: `npm run dev:windows` and `npm run dev:linux` in a call with a camera; linux-voice-check.mjs.

### Don't tie the video-message preview's frame rate to an unrelated animation
- Where: ui/chat.rs:776-798, 916, 940-952
- Category: ux
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: the camera preview while recording a video message is pulled only when ChatView draws. It's smooth today only because the pulsing red dot asks for a frame every vsync. With Reduce motion on, the dot stops and the preview drops to the 100 ms tick (10 fps).
- Suggested change: call `window.request_animation_frame()` from `round_preview` while recording.
- Check after: `npm run dev:windows` with Reduce motion on.

### Keep the emoji/emote picker from rebuilding on every frame and hover
- Where: ui/picker.rs:154-158, 213-218, 234-260; ui/mod.rs:121-122, 879
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: while open, the picker renders on every Root frame, rebuilding ~430 emoji or the whole emote grid and cloning the emote set. Each hover over a cell notifies it, and Root observes it, so Root re-renders too.
- Suggested change: render it as a cached `AnyView`, borrow the emotes instead of cloning, drop Root's observe (`composer_may_focus` can check `picker::is_open` at event time), and make the hover footer its own small view.
- Check after: `npm run dev:windows` with a large emote set.

### Make the inline markup parser linear instead of re-scanning with every rule
- Where: apps/desktop/src/markup.rs:168-197
- Category: perf
- Severity: low ; Effort: M ; Confidence: medium
- What's wrong: each step runs all six regexes over the whole rest of the text and keeps only the earliest match, so cost grows with spans × length. Combined with re-parsing on every notification, a long span-heavy message can cost noticeable time per redraw. The algorithm mirrors packages/ui/src/lib/markup.tsx, so output must stay identical.
- Suggested change: remember each rule's next match and re-run a rule only when that match starts before the current position. Add a test with a long, span-heavy message.
- Check after: `cargo test` for markup in apps/desktop (needs the GPUI fetch). iOS has a related quadratic issue (see the iOS findings).

### Prune a call stage's frames for tiles that went away
- Where: ui/voice_stage.rs:101-140, 780-785
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `images` keeps full-size frames, and their `#cover` copies, for every tile ever shown until the stage is dropped, including cameras turned off and shares stopped.
- Suggested change: in `render`, retire entries whose tile is no longer among the current videos.
- Check after: `npm run dev:windows` in a call where cameras and shares start and stop; linux-voice-check.mjs.
