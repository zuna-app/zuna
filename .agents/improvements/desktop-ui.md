## Native desktop app: interface (`apps/desktop/src/ui`, `state.rs` and friends)

Covered: apps/desktop/src/ui/* (read chat.rs, message.rs, mod.rs, conversations.rs, components.rs, motion.rs, scrollbar.rs, text_input.rs, picker.rs, media_views.rs, side_panel.rs, voice_settings.rs; hot paths of voice_stage.rs, voice.rs, overlays.rs, notifications.rs, channel_message.rs), plus state.rs, models.rs, markup.rs, format.rs, theme.rs, settings.rs, main.rs, compared against packages/ui where behaviour differed. GPUI behaviour was checked in a local checkout of the fork (an older rev than the pin), so GPUI-dependent claims are marked.
Skipped or skimmed: onboarding.rs, the settings UI, server_settings.rs, server_voice.rs, soundboard.rs, stream_stats.rs, screen_picker.rs, invites.rs, shared_media.rs, selection.rs and menu.rs internals. Nothing was built or run.
Ordered roughly by value.

### Virtualize the conversation list and stop cloning per row
- Where: ui/conversations.rs:170-312 (174 peer clone, 178 `preview_for` runs the `plain_text` regexes, 282 `item.clone()`, 284 `prefs.clone()` per row), 548-556, 688-691
- Category: perf
- Severity: medium ; Effort: M ; Confidence: high
- What's wrong: every row is built on every `AppState` notification. Each row clones its whole conversation and the server's preferences into its right-click closure, and runs nine regexes over the last message. Everyone on a server can be messaged from the start, so a few hundred people means a few hundred heavy rows per presence or typing event.
- Suggested change: build the menu lazily from state inside the handler; cache `preview_for`; move the rows into `gpui::list`/`uniform_list`, or skip building rows far off screen as the picker's `near` does.
- Check after: `npm run dev:windows` against a server with many users (add bots via packages/core/test/dev-bots.ts).

