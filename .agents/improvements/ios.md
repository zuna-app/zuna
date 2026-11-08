## iOS (`apps/ios`)

Covered by reading only (no Swift build on Windows): AppModel, MessageLists, ComposerState, CoreController, ZunaApp, the chat files (ChatScreen, MessageListController, MessageRow, MessageParts, MessageText, Composer, EmoteImages, Voice, Round, PhotoViewer, parts of AttachSheet), MainView, ChatListView, ServerListView, Notifications, PushStore, VoiceModel, SystemCall, CallPushes, SharedMedia, ShareInbox, CoreLock, AvatarView/ImageStore, OutgoingFiles, ShareSuggestions, UnlockView; in ZunaKit: Models, CoreAPI, CoreConnection, Drift, CoreRuntime, CryptoBridge, DatabaseBridge, NetworkBridge, WebBridge, EmoteFiles, Markup, PlainText; core-bundle's entry, wire and polyfills; Package.swift, project.yml, NotificationService. Models.swift and CoreAPI.swift were checked against types.ts, client.ts and session.ts: no field or argument drift, only one misplaced doc comment.
Skimmed: Settings, Details (apart from SharedMedia), Onboarding, Channels (apart from ChannelMessages), the call screens, the ZunaShare views, ZunaBroadcast and the UI tests.
Nothing was run. Severity is estimated user impact; Confidence says whether the problem is real as described. Any fix here needs a Mac to build, so an implementing agent on Windows must say so in the commit message.

### Split the fast-changing server state out of ServerState
- Where: apps/ios/Zuna/State/AppModel.swift:11-33, 138, 188, 405-447
- Category: perf
- Severity: medium ; Effort: L ; Confidence: high
- What's wrong: `servers` and `lists` are each a single observed property. Presence, typing (set, then cleared 5.1 s later), voice members and connection state redraw every view that reads any server: the chat list, every ChatRow, ChatScreen, the tab badges, ServerButton, the Composer, and the badge observer in Notifications.
- Suggested change: move typing, presence and voice into separate observable storage (top-level dictionaries on AppModel, or a small observable class per server), read only in the views that show them (ChatHeader, ChatRow.preview, ChannelTyping, AvatarView's online dot, CallBanner). Give each message list its own observable box.
- Check after: `npm run test:ios:ui -- --only PresenceTests,ConversationListTests,ChatReadingTests`. (The web has the same shape of problem with `useActiveServer`, see its findings.)

