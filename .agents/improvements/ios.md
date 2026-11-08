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

### Stop compiling regexes on every bubble redraw
- Where: apps/ios/ZunaKit/Sources/ZunaModels/Markup.swift:49-56, 312-314; apps/ios/Zuna/Chat/MessageRow.swift:268-282 (read at 372, 379-383, 436, 439, 446); apps/ios/Zuna/Channels/ChannelMessages.swift:186-192, 253; apps/ios/Zuna/Chat/Composer.swift:633; apps/ios/Zuna/State/ComposerState.swift:246
- Category: perf
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: `Markup.trimmed` compiles a new `NSRegularExpression` on every call, and `jumboSize` calls it; `MessageItem.jumbo` is a computed property read ~9 times per bubble body, so the regex compiles ~9 times per redraw. The Composer's `trigger` runs `try! NSRegularExpression` on every access, several times per keystroke. `mentions(in:)` compiles its regex on every send.
- Suggested change: make the `trimmed` pattern a `static let`; compute `jumbo` once per body or in `MessageRowContext`; move the Composer and `mentions(in:)` patterns to `static let`.
- Check after: `swift test` in apps/ios/ZunaKit (MarkupTests golden); `npm run test:ios:ui -- --only ComposerTests,ChatReadingTests`.

### Search inline markup without copying the rest of the text on every span
- Where: apps/ios/ZunaKit/Sources/ZunaModels/Markup.swift:111-157 (119-123)
- Category: robustness
- Severity: medium ; Effort: M ; Confidence: medium
- What's wrong: `renderInline` runs `let rest = ns.substring(from: position)` once per span found, so work grows with the square of the length. The core accepts texts up to 100,000 characters (`MAX_TEXT_LENGTH`), and parsing runs on the main thread on every reconfigure: one crafted message could freeze the chat. The comment at 120-121 says a search range "would still let lookbehinds see" the earlier text; with NSRegularExpression's default (non-transparent) bounds, lookbehind and `^` don't look past the range start, only `.withTransparentBounds` lets them.
- Suggested change: search the original NSString with `NSRange(location: position, length: ns.length - position)` and default options, keeping ranges absolute, and confirm against `markup-golden.json`. Cache parsed blocks per message id and text. Fix the comment.
- Check after: `swift test` (MarkupTests); add a case with ~20,000 `*a*` spans and a time limit.

### Prepare avatars without a full-resolution bitmap on the main thread
- Where: apps/ios/Zuna/Shared/OutgoingFiles.swift:104-123, 189-196; callers Settings/AccountSettings.swift:100, Details/ConversationDetails.swift:273, Settings/ServerSettingsView.swift:119
- Category: perf
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: `avatar(from:)` decodes the whole photo; for any photo not stored upright (most portrait shots), `cgImageOriented()` redraws it at full size (~190 MB for 48 MP) to make a 256 px square, from main-actor closures.
- Suggested change: `CGImageSourceCreateThumbnailAtIndex` with `kCGImageSourceCreateThumbnailWithTransform` and a max of ~2× target, then crop the centre square; make it nonisolated and call it from a detached task; delete `cgImageOriented()` once unused.
- Check after: `npm run test:ios:ui -- --only SettingsTests,DetailsTests`.

### Downsample photos for the viewer off the main thread
- Where: apps/ios/Zuna/Chat/PhotoViewer.swift:32-42, 337-345; apps/ios/Zuna/Chat/ChatScreen.swift:316-324
- Category: ux
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: `PhotoViewer.show` makes the 4096 px ImageIO thumbnail synchronously on the main actor before presenting, so tapping a large photo stalls.
- Suggested change: present immediately with the cached bubble image (`images.cachedAttachment`), and swap in the 4096 px version from a detached task.
- Check after: `npm run test:ios:ui -- --only ChatReadingTests`.

### Create the Composer's recorders when they're used, not on every redraw
- Where: apps/ios/Zuna/Chat/Composer.swift:19-20; Chat/Round.swift:39-49; Chat/AttachSheet.swift:42, 663-672; Chat/Location.swift:134
- Category: perf
- Severity: medium ; Effort: S ; Confidence: medium
- What's wrong: `@State private var round = RoundRecorder()` evaluates its initializer every time the Composer struct is created (every ChatScreen redraw). SwiftUI keeps only the first instance, but each extra one allocates and throws away an `AVCaptureSession`, a movie output, a queue and a delegate. `CameraFeed()` in AttachSheet and `LocationFinder()` (a CLLocationManager) follow the same pattern.
- Suggested change: hold them as optionals created on first use, or one shared `RoundRecorder` (one recording at a time). Create `CameraFeed` in `.task`.
- Check after: `npm run test:ios:ui -- --only ComposerTests` (roundStart/roundStop).

### Rebuild `mentionable` only when the people change, not on presence
- Where: apps/ios/Zuna/State/AppModel.swift:23-27, 438-440
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the `didSet` on `users` fires for any element change, so every presence event rebuilds the whole username map (lowercasing every username); `.presence` writes twice (`online`, then `lastSeenAt`), so twice per event. The comment "Changes only with the people, not with presence" is wrong as the code stands.
- Suggested change: drop the `didSet`; recompute `mentionable` in `init` and `refresh("users")`; apply presence through one mutating method that sets both fields in a single write.
- Check after: `npm run test:ios:ui -- --only PresenceTests,ComposerTests`.

### Write the app badge only when the count changes
- Where: apps/ios/Zuna/Notifications/Notifications.swift:376-393; apps/ios/Zuna/Shared/PushStore.swift:19-21, 91-94
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: the badge observer watches `model.totalUnread`, which reads `servers`, so it fires on every presence or typing change; each time it writes the App Group defaults (a new `UserDefaults(suiteName:)` per access) and calls `setBadgeCount`, even when the total hasn't changed.
- Suggested change: remember the last value and return early when unchanged; make `PushStore.defaults` a `static let`.
- Check after: `npm run test:ios:notify`; `npm run test:ios:ui -- --only NotificationTests`.

### Let failed emotes load again
- Where: apps/ios/Zuna/Chat/EmoteImages.swift:24-25, 50, 59-63
- Category: robustness
- Severity: medium ; Effort: S ; Confidence: high
- What's wrong: any failed load, including a moment without network, goes into `failed`, which is never cleared, so the emote shows its name for the rest of the app's life even after prefetching put the file on disk.
- Suggested change: store the failure time and retry after ~60 s; clear a server's entries when its prefetch finishes or the connection comes back.
- Check after: `npm run test:ios:ui -- --only ChatReadingTests`. Check the desktop's emote cache for the same pattern.

### Fix the emote view showing a stale emote after reuse
- Where: apps/ios/Zuna/Chat/EmoteImages.swift:130-145; apps/ios/Zuna/Chat/MessageText.swift:238-251
- Category: robustness
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: when the image is already cached, `EmoteImageView.show` sets it and returns without cancelling the running load or hiding the name label. `placeEmotes` reuses these views by position, so a load still running for the previous emote overwrites the cached one, and a name label from an earlier failure stays visible.
- Suggested change: in both branches, cancel the load first and hide the name label; clear the image before starting a new load.
- Check after: `npm run test:ios:ui -- --only ChatReadingTests`.

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

### Remove leftover compatibility in the saved settings
- Where: apps/ios/Zuna/State/AppSettings.swift:29-39, 74-78; apps/ios/Zuna/Voice/VoiceModel.swift:36-47
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: both settings structs keep hand-written decoders commented "Settings saved by an earlier version lack the newer fields", and `AppSettings.save()` deletes `UserDefaults.standard`'s copy on every save (left from moving settings into the App Group). CLAUDE.md's no-backward-compatibility rule says to remove this; `load()` already falls back to defaults.
- Suggested change: delete both custom `init(from:)` (and the then-unneeded `init() {}`), and drop the `standard` removal from `save()`.
- Check after: `npm run test:ios:ui -- --only SettingsTests`. Note: without a custom decoder, adding a field later makes old saved settings fail to decode and fall back to defaults entirely; that's acceptable under the rule but worth knowing.

### Put the session-call boilerplate in one helper and describe errors consistently
- Where: apps/ios/Zuna/State/AppModel.swift:279, 312, 574-661; apps/ios/Zuna/Onboarding/OnboardingComponents.swift:252-258; apps/ios/Zuna/Voice/VoiceModel.swift:435-439
- Category: cleanup
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: seven AppModel methods repeat `Task { do/catch toast("Couldn't save that: \(error)") }`, interpolating the raw error (a decoding error would dump Swift debug text into a toast). The other 53 call sites use `OnboardingText.describe`, which lives in onboarding and turns any `Couldn't reach|fetch` message into "Check the address and your connection" (onboarding wording that then shows up in chats). `VoiceModel.describe` has two branches returning the same string.
- Suggested change: add an AppModel helper such as `perform(_ serverId:failure:_ op:)` for those seven methods and the two load toasts; move `describe` to a neutral `ErrorText`, keyed on `CoreCallError.code == "network"` rather than the regex; collapse `VoiceModel.describe`.
- Check after: `npm run test:ios:ui -- --only ConversationListTests,OnboardingTests`.

### Announce toasts to VoiceOver
- Where: apps/ios/Zuna/State/AppModel.swift:665-673; apps/ios/Zuna/Shell/MainView.swift:139-166
- Category: ux
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: toasts carry errors and security warnings, but nothing posts an accessibility announcement, so VoiceOver users don't hear them.
- Suggested change: in `toast`, post `AccessibilityNotification.Announcement(message)`, high priority for errors and security toasts.
- Check after: `npm run test:ios:ui -- --only AccessibilityTests`. Check the web's toast region has `aria-live`.

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

### Load servers in parallel at launch
- Where: apps/ios/Zuna/State/AppModel.swift:258-266; apps/ios/Zuna/State/MessageLists.swift:90-101
- Category: perf
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: servers load one after another, so launch and every reload slow down with each server joined; `reloaded()` also refetches each loaded chat one at a time.
- Suggested change: a task group for both, keeping the server order.
- Check after: `npm run test:ios:ui -- --only LaunchAndUnlockTests,ShellTests`. The web loads servers sequentially too.

### Reuse the avatar already in memory for share suggestions
- Where: apps/ios/Zuna/Shared/ShareSuggestions.swift:12-15, 38-45; apps/ios/Zuna/State/ComposerState.swift:192-194
- Category: perf
- Severity: low ; Effort: S ; Confidence: medium
- What's wrong: every message sent has the core decrypt the chat's avatar again, then decodes, shrinks and re-encodes it before donating the share suggestion.
- Suggested change: cache the suggestion image by file id, or reuse the copy `ImageStore` holds.
- Check after: `npm run test:ios:ui -- --only ShareTests`.

### Fix the misplaced doc comment in CoreAPI.swift
- Where: apps/ios/ZunaKit/Sources/ZunaModels/CoreAPI.swift:410-425
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: "A group's name and description; nil fields stay as they are." sits above `MessagePlace`; `GroupMetaChanges` has no comment.
- Suggested change: move the line onto `GroupMetaChanges`.
- Check after: `swift build` in apps/ios/ZunaKit.

### Correct the stale comments in DatabaseBridge and MainView
- Where: apps/ios/ZunaKit/Sources/ZunaHost/DatabaseBridge.swift:25; apps/ios/Zuna/Shell/MainView.swift:4-6
- Category: docs
- Severity: low ; Effort: S ; Confidence: high
- What's wrong: DatabaseBridge says "a future notification extension", but the extension exists and reads the database. MainView says "A Calls tab comes with calls", but calls are built and there's no Calls tab.
- Suggested change: say "the notification extension", and drop the Calls-tab sentence.
- Check after: none.

