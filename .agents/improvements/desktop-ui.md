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

### Bound the media, picture and message caches in `AppState`
- Where: state.rs:207, 218-230 (`lists`, `media_files`, `clips`, `videos`, `paused_at`, `pictures`), 1347-1432; ui/media_views.rs:370-378, 446-469
- Category: robustness
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong: nothing is ever removed from these maps while the app runs. `clips` keeps decoded i16 PCM for every sound (~57 MB for a 10-minute file); every video message's sound is decoded just for scrolling past it. `videos` keeps one `VideoPlayer` entity per video ever shown, each with a full-size last frame. `pictures` keeps the encoded bytes of every photo, avatar and emote. `lists` keeps every loaded page of every chat opened.
- Suggested change: LRU on `clips`, `videos` and `media_files` (never evict what's playing or visible; delete the temp file with the entry). Trim a closed chat's list back to its newest page. Cap `pictures` by total bytes.
- Check after: `npm run dev:windows` (scroll a media-heavy chat and watch memory); Linux and macOS builds. The web and iOS have the same unbounded lists (see their findings).

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

### Cancel an in-flight chat search when the query is cleared
- Where: ui/side_panel.rs:92-113 (contrast conversations.rs:144-151)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: clearing the query clears the results but leaves the earlier search running, and it refills the list when it lands.
- Suggested change: set `self.searching = None;` there too.
- Check after: `npm run dev:windows`.

### Show senders' pictures in search results and pinned messages
- Where: ui/conversations.rs:583-594 and ui/side_panel.rs:1007 (`image: None`); web: ConversationList.tsx:404 and SidePanel.tsx:566 pass `avatar={sender?.avatar}`
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: these lists always draw initials, even for people with a profile picture.
- Suggested change: use `decrypted_picture`, as the member list does (chat.rs:240).
- Check after: `npm run dev:windows`; check iOS.

### Reset the conversation search when switching servers
- Where: ui/conversations.rs:33-51, 144-168, 557-615; web: Shell.tsx:200 remounts the list per server
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the query and message hits survive a server switch. Clicking an old hit selects a conversation on the new server using the old server's ids, and the toast says "That message isn't available."
- Suggested change: when `active_server` changes, clear the query, `hits`, `searching`, `drag_order` and `hovered_channel`.
- Check after: `npm run dev:windows` with two servers.

### Scope named scroll handles to their owner instead of one global per name
- Where: ui/scrollbar.rs:53-65; used by "conv-list", "member-list", "modal-body"/"modal-flow", "new-group-people", "picker-body", "composer-scroll"
- Category: ux
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: each name maps to one handle forever, so scroll position carries over between unrelated instances: the conversation list keeps the previous server's offset; the member list keeps another channel's; dialogs and the picker reopen where the last one was scrolled; chats share the composer's scroll.
- Suggested change: make handles fields of the owning view (as `SidePanel` does at line 76), or key them by owner. Reset the picker's handle on open.
- Check after: `npm run dev:windows`.

### Refetch the server icon when the server's settings change
- Where: ui/mod.rs:230-233; state.rs:650-657, 1276-1291; compare ui/server_settings.rs:281 (`?v=`) and server/internal/api/admin.go:174 (`max-age=300`)
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the rail's icon is cached by URL for the whole run, so a new icon only appears after a restart. Browsers refetch it every 5 minutes.
- Suggested change: drop the cached `/api/icon` picture on the "settings" event, or append an icon generation as `?v=`.
- Check after: `npm run dev:windows` with two clients.

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

### Use one helper for emote URLs and remove the unused `AppState::emote_url`
- Where: state.rs:1457-1459 (never called); the URL is written out at chat.rs:2454, channel_message.rs:667, message.rs:751, 988, 1016, 1167, picker.rs:198, 296, server_settings.rs:512
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: a free function `emote_url(server_url, id, scale)` used everywhere; delete the method.
- Check after: `npm run dev:windows`.

### Deduplicate emote-reference JSON and the group-admin check
- Where: emote maps at chat.rs:1317-1324, 2245-2248, state.rs:1206-1216, message.rs:546; the admin check at chat.rs:816, 1360, 2356, 2508
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: add `Emote::to_ref()`, `EmoteSet::refs_in(text)` and `ConversationView::is_admin(self_id)` in models.rs and call them from every site.
- Check after: `npm run dev:windows`.

### Remove dead code and unused-warning shims
- Where: chat.rs:3094-3095 (`fn unused`); menu.rs:371-379 (`label`, `right_click`); onboarding.rs:818-821; settings.rs:924-927 (`radius`); components.rs:403-405 (`px_f`); message.rs:1559 (`let _ = format_full;`), 984 (`_size`), 879 (`_cx`); chat.rs:746, 2257 (`let _ = window;`); scrollbar.rs:183 (`let _ = which;`); notifications.rs:271, 277 (`keys`); text_input.rs:264-267 (`set_disabled`, never called); models.rs:221-225 (`seq_or`, never called)
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: these exist only to keep imports or parameters from warning, or are leftovers nobody calls.
- Suggested change: delete them and fix the imports and parameters they were covering.
- Check after: `npm run dev:windows`, `npm run dev:linux`, `npm run dev:macos` (warnings can be per-platform).

### Fix doc comments that are wrong or attached to the wrong item
- Where: state.rs:1481 (`load_server`'s doc is "Takes notifications back…"); chat.rs:2100-2101 (`channel_typing` carries the member list's old first line); main.rs:209-211 (`quit`'s doc is attached to `const QUIT`); components.rs:418 (the corners line sits above `AspectFill` and belongs on `round_corners` at 475); chat.rs:2740-2741 and message.rs:62-63 (overstate the caching)
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: rewrite or move each one.
- Check after: a build.

### Update comments that point at the removed Electron app or call packages/ui "the desktop's"
- Where: ui/notifications.rs:1-2, settings.rs:466-467 and format.rs:42-43 mention the Electron app. About 39 comments use "the desktop's" to mean packages/ui, e.g. state.rs:1-2, ui/mod.rs:45, chat.rs:121, 461, 1412, 1897, 2689, 2752, components.rs:20, 270, 278, 293, 310, conversations.rs:42. docs/WINDOWS_APP.md:18 uses the same wording.
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the Electron app exists only in git history, and CLAUDE.md calls packages/ui the web's interface. These comments send an agent looking for a desktop that isn't there.
- Suggested change: say "the web's X (packages/ui/…)" instead, and drop the Electron references. A grep for `desktop's` and `Electron` under apps/desktop/src finds them all.
- Check after: a build.

### Move hard-coded colors into theme tokens
- Where: ui/mod.rs:151, 155 (`0xa0a0a6`, which is `theme.text2`); mod.rs:539-540 (toast backgrounds); chat.rs:238, 1987 and channel_message.rs:19-25 (`0x8b8b92` and `0x505057`, which are `--channel-muted` and `--spine` in packages/ui/src/styles/channel.css:7-8); chat.rs:2311, 2874 (`0x45454b`); `0xe8d3a2` at chat.rs:3023, message.rs:188, settings.rs:568; `0xf4bcbe` at message.rs:302, 622, overlays.rs:530, channel_message.rs:362
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- Suggested change: add `channel_muted`, `spine`, `amber_text`, `danger_text` and `bg5_hover` to `Theme`, and use `text2` for `0xa0a0a6`.
- Check after: `npm run dev:windows` (visual compare).

### Reuse format.rs for a channel message's stamp and day line
- Where: ui/channel_message.rs:27-41 vs format.rs:58-70
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `format_stamp` and `format_day` re-implement the local-time conversion and day difference format.rs already has.
- Suggested change: move both into format.rs, built on `local()` and `days_ago()`.
- Check after: `npm run dev:windows`.

### Save settings atomically
- Where: apps/desktop/src/settings.rs:53-63
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: `std::fs::write` overwrites `settings.json` in place. A torn write leaves a file that won't parse, and `load` then silently resets every setting to its default.
- Suggested change: write a `.tmp` file and rename it over the original; log when an existing file fails to parse.
- Check after: `npm run dev:windows`.

### Stop waiting forever to open a link when the app failed to start
- Where: apps/desktop/src/main.rs:127-144 (138-140)
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: a `zuna://` link polls every 200 ms until the phase is `Ready`. If boot failed, it polls for the rest of the run, and later links queue behind it.
- Suggested change: break out when the phase is `Failed`, or wait on a oneshot instead of polling.
- Check after: `npm run dev:windows`.

### Commit the sidebar width once at the end of a resize
- Where: ui/mod.rs:741-778
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: every mouse move during a resize writes `settings.list_width` into `AppState` and notifies all its observers. (The web has the same issue, see its findings.)
- Suggested change: keep the live width in `Root` while dragging and call `update_settings` once on mouse up.
- Check after: `npm run dev:windows`.

### Prune a call stage's frames for tiles that went away
- Where: ui/voice_stage.rs:101-140, 780-785
- Category: robustness
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: `images` keeps full-size frames, and their `#cover` copies, for every tile ever shown until the stage is dropped, including cameras turned off and shares stopped.
- Suggested change: in `render`, retire entries whose tile is no longer among the current videos.
- Check after: `npm run dev:windows` in a call where cameras and shares start and stop; linux-voice-check.mjs.
