## iOS (`apps/ios`)

Covered by reading only (no Swift build on Windows): AppModel, MessageLists, ComposerState, CoreController, ZunaApp, the chat files (ChatScreen, MessageListController, MessageRow, MessageParts, MessageText, Composer, EmoteImages, Voice, Round, PhotoViewer, parts of AttachSheet), MainView, ChatListView, ServerListView, Notifications, PushStore, VoiceModel, SystemCall, CallPushes, SharedMedia, ShareInbox, CoreLock, AvatarView/ImageStore, OutgoingFiles, ShareSuggestions, UnlockView; in ZunaKit: Models, CoreAPI, CoreConnection, Drift, CoreRuntime, CryptoBridge, DatabaseBridge, NetworkBridge, WebBridge, EmoteFiles, Markup, PlainText; core-bundle's entry, wire and polyfills; Package.swift, project.yml, NotificationService. Models.swift and CoreAPI.swift were checked against types.ts, client.ts and session.ts: no field or argument drift, only one misplaced doc comment.
Skimmed: Settings, Details (apart from SharedMedia), Onboarding, Channels (apart from ChannelMessages), the call screens, the ZunaShare views, ZunaBroadcast and the UI tests.
Nothing was run. Severity is estimated user impact; Confidence says whether the problem is real as described. Any fix here needs a Mac to build, so an implementing agent on Windows must say so in the commit message.

### Reconfigure only the message rows whose content changed
- Where: apps/ios/Zuna/Chat/MessageListController.swift:120-171 (136, 142-143); apps/ios/Zuna/Chat/MessageRow.swift:6-29, 662, 693-697
- Category: perf
- Severity: high ; Effort: M ; Confidence: high
- What's wrong: every `update` rebuilds every row's context (two Calendar same-day checks per message) and reconfigures every visible cell with `reconfigureItems(Array(kept))`; each reconfigured cell runs `Markup.parse` and `MessageTextBuilder.build` again. `update` runs on every `ChatScreen` redraw, and `ChatScreen` reads `model.activeServer` and `model.list(...)` (ChatScreen.swift:46, 66), so any presence or typing change on the server, or a message in any other loaded chat, re-parses every visible message.
- Suggested change: make `MessageRowContext` Equatable, keep the previous contexts, and reconfigure only ids whose context changed. Reconfigure all visible ids only when a small row-environment value changes (self id, `mentionable`, emote set id, blocked list, accent, message size, the users shown). Pass rows that value rather than the whole `ServerState`, and skip `apply` when nothing changed. Precompute a day key per message.
- Check after: `npm run test:ios:ui -- --only ChatReadingTests,MessageActionsTests,ChannelsTests`, and the 2,000-message scroll measure from IOS_TESTING.md's performance layer.

### Split the fast-changing server state out of ServerState
- Where: apps/ios/Zuna/State/AppModel.swift:11-33, 138, 188, 405-447
- Category: perf
- Severity: medium ; Effort: L ; Confidence: high
- What's wrong: `servers` and `lists` are each a single observed property. Presence, typing (set, then cleared 5.1 s later), voice members and connection state redraw every view that reads any server: the chat list, every ChatRow, ChatScreen, the tab badges, ServerButton, the Composer, and the badge observer in Notifications.
- Suggested change: move typing, presence and voice into separate observable storage (top-level dictionaries on AppModel, or a small observable class per server), read only in the views that show them (ChatHeader, ChatRow.preview, ChannelTyping, AvatarView's online dot, CallBanner). Give each message list its own observable box.
- Check after: `npm run test:ios:ui -- --only PresenceTests,ConversationListTests,ChatReadingTests`. (The web has the same shape of problem with `useActiveServer`, see its findings.)

### Make the avatar cache aware of size
- Where: apps/ios/Zuna/Shared/AvatarView.swift:27-32, 100-117, 177-188
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the cache key is just the file id, but the image is shrunk for whichever view asks first. Seen first at 16 pt (a reaction chip at MessageParts.swift:308, or a channel reply at ChannelMessages.swift:372), the cached copy is ~96 px, and the 96 pt header in details or account screens draws it blurry.
- Suggested change: reload at the larger size when the cached image is too small for the request, or key the cache by size bucket.
- Check after: the DetailsTests screen tour.

### Take the RPC reply parsing off the core's thread and parse once
- Where: apps/ios/ZunaKit/Sources/ZunaModels/CoreConnection.swift:68-81, 105-138; apps/ios/ZunaKit/Sources/ZunaHost/CoreRuntime.swift:269-275
- Category: perf
- Severity: medium ; Effort: M ; Confidence: medium
- What's wrong: `post` calls `receive` synchronously on the core's queue, where `receive` parses the whole reply with JSONSerialization, serializes the value back to Data, and `call` decodes it a third time with JSONDecoder. For big replies (conversations, users, message pages), the JS thread waits through two extra full JSON passes.
- Suggested change: in `receive`, hop to a private serial queue (keeps replies and events in order); decode a small envelope (kind, id, ok, error) from the raw Data and resume with that Data, then decode `Reply<V> { value }` in `call`. Decode events in a single pass the same way.
- Check after: `swift test` (CoreConnectionTests, WireTests), `npm run test:ios`, `npm run test:ios:perf`.

### Put the session-call boilerplate in one helper and describe errors consistently
- Where: apps/ios/Zuna/State/AppModel.swift:279, 312, 574-661; apps/ios/Zuna/Onboarding/OnboardingComponents.swift:252-258; apps/ios/Zuna/Voice/VoiceModel.swift:435-439
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: seven AppModel methods repeat `Task { do/catch toast("Couldn't save that: \(error)") }`, interpolating the raw error (a decoding error would dump Swift debug text into a toast). The other 53 call sites use `OnboardingText.describe`, which lives in onboarding and turns any `Couldn't reach|fetch` message into "Check the address and your connection" (onboarding wording that then shows up in chats). `VoiceModel.describe` has two branches returning the same string.
- Suggested change: add an AppModel helper such as `perform(_ serverId:failure:_ op:)` for those seven methods and the two load toasts; move `describe` to a neutral `ErrorText`, keyed on `CoreCallError.code == "network"` rather than the regex; collapse `VoiceModel.describe`.
- Check after: `npm run test:ios:ui -- --only ConversationListTests,OnboardingTests`.

### Let message times and code scale with Dynamic Type
- Where: apps/ios/Zuna/Chat/MessageRow.swift:268-277, 476-512 (491, 504); apps/ios/Zuna/Channels/ChannelMessages.swift:181-184, 197; apps/ios/Zuna/Chat/MessageParts.swift:459
- Category: ux
- Severity: low ; Effort: M ; Confidence: medium
- What's wrong: message text scales, but the time and marks are fixed at 11 pt (and their reserved space is measured at 11 pt), "(edited)" in channels is 11 pt, and code blocks are 13 pt. Rows don't read `dynamicTypeSize`, so changing text size while running doesn't redraw rows on screen.
- Suggested change: scale the time font and its measurement with `UIFontMetrics(forTextStyle: .caption2)`, the same for "(edited)", a monospaced text style for code, and read `@Environment(\.dynamicTypeSize)` in `MessageRow`.
- Check after: the large-text screen tour in `npm run test:ios:ui`.

### Bound the loaded message lists, and clean up after removed servers
- Where: apps/ios/Zuna/State/AppModel.swift:188-202, 493-504; apps/ios/Zuna/State/MessageLists.swift:47-120; apps/ios/Zuna/State/ComposerState.swift:28-41
- Category: robustness
- Severity: low ; Effort: M ; Confidence: high
- What's wrong: `lists` keeps every chat opened, with every older page loaded, for the app's life, and each keeps receiving updates; link previews and thumbnails are inline images, so this grows by megabytes on a device iOS kills for memory. `removeServer` leaves behind that server's drafts (including staged files never deleted), in-place edits, saved positions, pending read positions and prefetch records.
- Suggested change: trim a chat's list to its newest page when the chat is left (`viewWillDisappear` knows when), or keep only the N most recent lists. In `removeServer`, filter all per-server dictionaries and discard the staged files.
- Check after: `npm run test:ios:ui -- --only ChatReadingTests,ShellTests`. Same issue on the web and desktop.

### Reuse the avatar already in memory for share suggestions
- Where: apps/ios/Zuna/Shared/ShareSuggestions.swift:12-15, 38-45; apps/ios/Zuna/State/ComposerState.swift:192-194
- Category: perf
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: every message sent has the core decrypt the chat's avatar again, then decodes, shrinks and re-encodes it before donating the share suggestion.
- Suggested change: cache the suggestion image by file id, or reuse the copy `ImageStore` holds.
- Check after: `npm run test:ios:ui -- --only ShareTests`.

