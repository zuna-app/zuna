# Feature parity

For agents, not people. `CLAUDE.md` says how to keep this current. Keep it terse.

- **Status:** `yes`, `partial`, `no`. A row that's different by design says so in its notes.
- **Paths:** desktop and web paths start at `packages/ui/src/`, and iOS paths at `apps/ios/Zuna/`, unless they're written out in full.
- **Web** shares the desktop's interface (`@zuna/ui`), so its rows follow the desktop's unless a note says otherwise. What only the web does is in "The web app" below.
- **Android** doesn't exist yet (`docs/ROADMAP.md`). Add a column when it does.
- **Last full check:** 2026-11-01, by reading and searching the code on Windows. Nothing was run for it, and Swift can't be built on that machine, so iOS `yes` means the code is there. `docs/IOS_PLAN.md`'s phase reports record what iOS was tested with on a Mac.
- **Web check:** 2026-11-01 on macOS 27, `apps/web/test/web-check.mjs` in Chromium and WebKit: signing up, the title's count, reading from the first unread message, sending with a link preview, a picture, a voice message, a reload, a second tab and "Use here", the narrow-window notice, the web's settings, and signing in again on a cleared browser. Firefox wasn't run: neither Playwright's nor Mozilla's Firefox starts on macOS 27 ("Could not find profile folder").

## Known gaps

Things one platform should have and doesn't.

- **iOS: no channels or voice channels.** Not built, as asked, and nothing in the app knows about them. `ios` hosts don't set `channels` on `ZunaClient`, so the phone's core ignores channels, its device takes no part in their MLS groups, and the server sends no push for a channel's messages. A person's other devices keep working. To build it: set `channels`, add `ChannelView`, `VoiceMember` and the session's channel and voice methods to `ZunaModels`, and LiveKit's Swift SDK with per-participant keys from `voiceKey` and `voiceSenderKey`.
- **Web, Firefox: unchecked.** Nothing has been run in Firefox yet (see "Web check" above). Its `MediaRecorder` may only record WebM with Opus, which the iPhone app can't play (`apps/ios/Zuna/Chat/Voice.swift` plays AAC in MP4). `web-check.mjs` reports what each browser records and whether Apple's decoder reads it.

## Accounts and servers

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Join by invite link with a preview, or an open server by address | yes | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/OnboardingSteps.swift`, `Onboarding/JoinFlow.swift` | |
| `zuna://` links | yes | yes | no | `App.tsx`, `apps/desktop/src/main/index.ts` | `ZunaApp.swift` | Web: by design, `#join=<invite link>` instead (`apps/web/src/platform.ts`) |
| Set up a new server | yes | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/JoinFlow.swift` | |
| Sign up: 8+ character password, strength meter | yes | yes | yes | `lib/password.ts` | `apps/ios/ZunaKit/Sources/ZunaHost/PasswordMeter.swift` | One estimator, `packages/core/src/password.ts` (zxcvbn-ts, common, English and Polish lists; under 10^9 guesses refused), also for recovery and changing the password. iOS runs it from `zuna-password.js` in its own JSContext. iOS checked with `swift test` on a Mac against the desktop's values |
| Recovery key shown and saved | yes | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/OnboardingSteps.swift` | Desktop saves a file, iOS uses the share sheet. The web downloads the file |
| Sign in, recovery with a new password | yes | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/OnboardingSteps.swift` | |
| Several servers, unread count per server | yes | yes | yes | `features/shell/ServerRail.tsx` | `Shell/ServerListView.swift`, `Shell/MainView.swift` | By design: a rail on the desktop, a list like Mail's mailboxes on iOS |
| Reorder servers | yes | yes | yes | `features/shell/ServerRail.tsx` | `Shell/ServerListView.swift` | By design: dragged on the rail, Edit on iOS. The desktop has no keyboard way yet |
| Sign out, erasing local data | yes | yes | yes | `features/overlays/ServerSettings.tsx`, `features/shell/Shell.tsx` | `Settings/ServerSettingsView.swift`, `State/AppModel.swift` | |
| Signed out by the server: data kept, sign in again or clear | yes | yes | yes | `features/shell/Shell.tsx` | `Shell/ChatListView.swift` | |
| Connection state | yes | yes | yes | `App.tsx` | `Shell/ChatListView.swift`, `Shell/ServerListView.swift` | The web has no title bar, so it shows at the top of the conversation list (`components/ui.tsx`, `ConnectionStatus`) |
| Security alerts from the core | yes | yes | yes | `state/store.ts` | `State/AppModel.swift` | Among them, a message the server denies that the next one from its device names (`after` in each body; `lookForEarlier`, `findMissing` in the core) |

## Channels and voice channels

Desktop and web only for now (see Known gaps). Paths are under `features/voice/` and `voice/` in `packages/ui/src/` unless written out. Checked on Windows with `apps/desktop/test/voice-check.mjs` in Electron against a real LiveKit, and `apps/web/test/web-check.mjs` in Chromium, which connects and encrypts but only has one person in a call.

| Feature | Desktop | iOS | Web | Desktop and web code | Notes |
|---|---|---|---|---|---|
| Channels in the list: headings that fold, a Channels tab, unread marks, "@" for mentions | yes | no | yes | `features/voice/ChannelList.tsx`, `features/shell/ConversationList.tsx` | From `getChannels` in the core, apart from `getConversations`. A channel's unread counts mark it and the rail, and only mentions count toward the badge |
| Making, editing, ordering and deleting channels, for server admins | yes | no | yes | `features/voice/ChannelDialog.tsx`, `features/voice/ChannelList.tsx` | Name, topic, heading; for voice, audio quality and how many people fit. Names and topics sealed with the community key, signed by the device (`packages/core/src/channels.ts`) |
| Everything a group chat does, in a text channel | yes | no | yes | `features/chat/*` | Replies, reactions, files, pins, search and so on. No read ticks, as where someone has read to stays on their own devices. Server admins can delete others' messages |
| Comes into every channel without being asked, with its history | yes | no | yes | `packages/core/src/session.ts` (`joinChannels`, `grantChannelHistory`) | External commit; any member online hands over the older keys. Until one does, older messages wait for keys |
| Notified only about what's said to you in a channel, unless it's muted | yes | no | yes | `packages/core/src/session.ts` (`maybeNotify`) | |
| Voice channels: click to join, who's in each shown to everyone, speaking rings, a panel that stays while looking elsewhere | yes | no | yes | `features/voice/VoicePanel.tsx`, `features/voice/VoiceStage.tsx`, `voice/room.ts`, `voice/store.ts` | One at a time across all servers; joining on a second device ends it on the first. Leaving goes back to what was open before. The channel's chat opens beside the call, and new messages there show as a dot on its button: a voice channel's row is only marked for a mention |
| Encrypted media, keyed from the channel's MLS group, with a key per sender | yes | no | yes | `voice/room.ts`, `packages/core/src/voice.ts`, `voiceKey` in the core | Moves to a new key whenever someone joins the group or is removed, listening at once and sending 1.5 s later |
| Noise cancelling (RNNoise), voice activity detection and a gate, by level or by speech | yes | no | yes | `voice/mic.worklet.ts`, `voice/mic.ts` | In an AudioWorklet, adding about 40 ms. RNNoise needs 48 kHz, which Firefox may not let a page have: there it passes sound through by level alone (unchecked) |
| Push to talk, with a release delay | yes | no | partial | `voice/ptt.ts`, `apps/desktop/src/main/global-key.ts` | Web: only while the tab is in front. Desktop: anywhere, through `uiohook-napi`, checked on Windows in `voice-check.mjs`. It can't work under Wayland, where only the window hears it |
| Mute, deafen, choosing devices, how loud each person is, muting someone for yourself, join and leave sounds | yes | no | yes | `features/voice/VoiceStage.tsx`, `features/voice/VoicePanel.tsx`, `voice/settings.ts`, `voice/sounds.ts` | |
| Muting someone for everyone, and disconnecting them, for server admins | yes | no | yes | `features/voice/VoiceStage.tsx`, `server/internal/api/voice.go` | LiveKit enforces it, as their token no longer allows a microphone |
| Cameras | yes | no | yes | `voice/room.ts` | Checked with Chromium's fake camera |
| Sharing a screen natively, on the GPU | yes | no | no | `apps/desktop/native/screenshare`, `apps/desktop/src/main/native-screen.ts`, `features/voice/ScreenPicker.tsx` | Windows and Linux, whole screens. Run from the app on Windows with NVENC only; Linux only in `poc/screenshare`. See `docs/SCREEN_SHARE.md` |
| Sharing through the browser, with its sound on Windows | yes | no | yes | `voice/room.ts`, `apps/desktop/src/main/index.ts` (`setDisplayMediaRequestHandler`) | Windows on the desktop, whatever isn't native, and everything on the web, which uses the browser's own picker. `restrictOwnAudio` leaves out Zuna and keeps other programs, measured in Electron on Windows. macOS has not been run |
| Voice and video settings, with a microphone test and a live meter | yes | no | yes | `features/voice/VoiceSettings.tsx` | Per device |

## Conversation list

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Everyone and groups, saved messages, rows with previews and unread counts | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Filters: All, People, Groups, Unread | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Search people, groups and messages | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| "@" on a group with unread mentions of you or replies to you | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` (`badge`) | Groups only, and in muted ones too, as in Telegram |
| Pin, hide, "Hidden (n)" | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Mute for a time | yes | yes | yes | `lib/mute.ts` | `Shared/Mute.swift` | |
| A group set to notify only about mentions and replies | yes | yes | no | `features/chat/SidePanel.tsx` (`PreferenceRows`) | `Details/ConversationDetails.swift` | In the synced preferences (`mentionsOnly`, `setMentionsOnly`); checked by `onlyMentionsNotify` in `maybeNotify` and `push.ts`, which also let a reply to you through, in a muted chat too. Its unread messages still count, unlike a muted chat's. The server can't tell mentions apart, so a phone without the filtering entitlement (`sendMuted`) doesn't send these groups to it and is notified about everything in them (`docs/PUSH_RELAY.md`). Web: by design, no notifications. Core in `chat-controls.test.ts`, desktop in `ui-check.mjs`, iOS in the simulator on a Mac (`ZunaUITests/Tests/ChatControlsTests.swift`) |
| Mark as unread, mark as read without opening | yes | yes | yes | `features/shell/ConversationList.tsx` (`rowEntries`), `state/store.ts` (`countedUnread`, `selectConversation`) | `Shell/ChatListView.swift` (swipe and menu), `State/AppModel.swift` (`openChat`, `ServerState.unread`) | As in Telegram: a mark in the synced preferences (`markedUnread`, `setMarkedUnread` in the core), not a read position, so nobody else sees it. Opening the chat takes it off; it counts as one unread in the badges. "Mark as read" reads to the newest message (`markChatRead`). Only for chats with a group. Core in `chat-controls.test.ts`, desktop in `ui-check.mjs`, iOS in the simulator on a Mac (`ZunaUITests/Tests/ChatControlsTests.swift`) |
| A preview for a message that can't be shown | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shared/Format.swift` | |

## Chat: reading

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Header, status, changed-key banner | yes | yes | yes | `features/chat/ChatView.tsx` | `Chat/ChatScreen.swift` | |
| Message list: days, grouping, jumping, scroll button | yes | yes | yes | `features/chat/MessageList.tsx` | `Chat/MessageListController.swift`, `Chat/MessageRow.swift` | |
| A chat with unread messages opens at the first, under an "Unread messages" line, and reads as far as has been on screen, as Telegram's | yes | yes | yes | `features/chat/MessageList.tsx` (`unreadLine`, `seenIn`), `state/store.ts` (`loadList`, `isUnread`) | `Chat/MessageListController.swift` (`placeOpening`, `noteSeen`), `Chat/MessageRow.swift`, `Chat/ChatScreen.swift`, `State/MessageLists.swift` | Unread as the core counts them: others' messages after `ownRead`. Up to 20 pages are loaded back to the first; with few after it, the chat opens at the newest with the line on screen. With none unread, at the newest or the place it was left at. The line stays until the chat is left. A message counts as read once all of it, or most of the screen, has been on screen in a focused window or the active app; at the newest message, everything. Read positions go one at a time, the furthest so far next. Desktop checked in `send-check.mjs`, web in `web-check.mjs`, iOS in the simulator on a Mac (`ZunaUITests/Tests/ChatReadingTests.swift`, `testLoadsOlderMessagesAndReturnsToTheNewest`) |
| "@" button in a group: jumps to the oldest unread message that mentions you or replies to you, then the next, with a count | yes | yes | yes | `features/chat/MessageList.tsx` (`MentionButton`) | `Chat/ChatScreen.swift` (`MentionButton`) | From the local index (`unreadMentions(groupId, after)`, `markMentionSeen` in the core), asked from where the chat is read, so mentions read by scrolling past them drop out; hidden at the newest message. A reply counts if this device holds the message replied to. Which ones were jumped to stays on that device; the list's "@" clears everywhere once the chat is read. Checked in `send-check.mjs` on the desktop, and on iOS in the simulator on a Mac (`ChatReadingTests.swift`, `testGoesToUnreadMentionsOneByOne`) |
| Markup | yes | yes | yes | `lib/markup.tsx` | `apps/ios/ZunaKit/Sources/ZunaModels/Markup.swift`, `Chat/MessageText.swift` | Kept in step by the golden files |
| Code blocks with highlighting | yes | yes | yes | `components/CodeBlock.tsx` | `Chat/MessageParts.swift`, `apps/ios/ZunaKit/Sources/ZunaHost/Highlighter.swift` | Only the first 500 lines or 20,000 characters are colored, and lines up to 1,000 characters; the same limits in `lib/highlight.ts` and `apps/ios/core-bundle/src/highlight.ts`. The desktop and the web color 50 lines at a time, giving the interface its turn between; iOS does it off the main thread |
| 7TV emotes: animated, zero-width, large, card | yes | yes | yes | `components/Emote.tsx` | `Chat/EmoteImages.swift`, `Chat/MessageText.swift` | The card opens on hover on the desktop, long press on iOS |
| Whole emote set fetched in the background | yes | yes | yes | `lib/media.ts`, `features/shell/Shell.tsx` | `apps/ios/ZunaKit/Sources/ZunaHost/EmoteFiles.swift`, `Chat/EmoteImages.swift`, `State/AppModel.swift` | iOS keeps them on disk in Caches, since `URLSession`'s cache is too small. None on Low Data Mode, as the desktop skips it to save data |
| Read ticks | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| Who read your message in a group: "Read by n" in its menu, each name opening a chat with them | yes | yes | yes | `features/chat/MessageItem.tsx` (`readersOf`) | `Chat/MessageRow.swift` (`menu`), `Chat/ChatScreen.swift` (`readers`) | From each member's read position (`readBy`), worked out as the menu opens; people who turned off read receipts never show. No times, as positions don't carry them. Core in `chat-controls.test.ts`, desktop in `ui-check.mjs`, iOS in the simulator on a Mac (`ZunaUITests/Tests/ChatControlsTests.swift`) |
| Deleted, waiting for keys, unverified, invalid | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| Reply quote, jumping to the original | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| "Forwarded from" | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/Forwarding.swift` | |
| Link card showing the link's real host | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/Forwarding.swift` | |
| Pictures: grid, viewer that zooms, saving | yes | yes | yes | `features/chat/MessageItem.tsx`, `features/overlays/Overlays.tsx` | `Chat/MessageParts.swift`, `Chat/PhotoViewer.swift` | iOS shares instead of saving |
| Very large pictures wait to be asked for | yes | yes | yes | `lib/media.ts` | `Chat/MessageParts.swift` | |
| Videos and files, upload progress | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageParts.swift`, `Chat/FilePreview.swift` | |
| Voice messages: playing | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/Voice.swift` | |
| Reactions | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageParts.swift` | |
| System messages | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| "You were removed from this chat", with clearing | yes | yes | yes | `features/chat/ChatView.tsx` | `Chat/ChatScreen.swift` | |
| A warning when a message's time looks wrong | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | iOS not compiled yet: written without a Mac. Explained in a tooltip on the desktop, in the long-press menu on iOS |

## Chat: writing and actions

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Message box: draft per chat, grows with its text | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/Composer.swift`, `State/ComposerState.swift` | |
| Outbox: sending, try again, discard | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/ChatScreen.swift` | The queue itself is in the core |
| Reply and edit | yes | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | iOS also swipes to reply. Each edit signs a `revision`, and a device keeps the latest it has seen (`nextRevision`, `editedSince` in the core) |
| Autocomplete for `:emote` and `@person` | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/Composer.swift` | |
| Emoji and emote picker | yes | yes | yes | `features/chat/EmotePicker.tsx` | `Chat/EmojiPicker.swift` | |
| Attachments: up to 10, previews, size limit | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/OutgoingFiles.swift`, `Chat/Composer.swift` | |
| Metadata taken out of photos, videos and drawings before they're sent | yes | yes | yes | `packages/core/src/metadata.ts`, called by `sendWithAttachments` | (the core) | JPEG, PNG, WebP, GIF, HEIC, AVIF, MP4, MOV, 3GP, WebM, MKV, SVG, by rewriting the file, never compressing again: keeps orientation and color profiles, zeroes films' dates and timed metadata tracks. Not voice messages. Checked with fixtures from exiftool (`packages/core/test/metadata.test.ts`), the phone sending from disk to the desktop (`tests/e2e/test/cross-client.test.ts`), and by hand on macOS: the same frames in ffmpeg, the same orientation in ImageIO, the same pixels in Chromium and WebKit |
| Pasting and dragging files in | yes | yes | yes | `features/chat/ChatView.tsx`, `features/chat/Composer.tsx` | `Chat/Composer.swift`, `Chat/ChatScreen.swift` | iOS pastes pictures, and dragging is mostly for iPad |
| Refusing a message too long to send | yes | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | The desktop checks first, iOS shows the core's error |
| Message menu: reactions, copy, edit, pin, delete | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/ChatScreen.swift` | Deleting signs a deletion in the core (`deleteSigned`); a copy is only erased for one its author or a group admin signed, otherwise hidden and kept 30 days (`deletionProven`) |
| Forwarding | yes | yes | yes | `features/overlays/Overlays.tsx` | `Chat/Forwarding.swift` | |
| Picking several messages | yes | yes | yes | `features/chat/MessageItem.tsx`, `features/chat/Composer.tsx` | `Chat/ChatScreen.swift` | |
| Voice messages: recording | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/Voice.swift` | By design: click to start on the desktop, hold on iOS |
| Sharing a location: this device's position, shown before it's sent, from the attach menu | yes | yes | yes | `features/overlays/ShareLocation.tsx`, `lib/location.ts`, `features/chat/Composer.tsx` | `Chat/Location.swift` (`ShareLocationSheet`, `LocationFinder`), `Chat/Composer.swift` | `location` in the message body, checked in `validate.ts`. Desktop and web use the browser's geolocation: Electron allows it in `apps/desktop/src/main/index.ts`, `zuna-web` sends `geolocation=(self)`. Checked with the position emulated, in Electron on macOS (`ui-check.mjs`) and in Chromium and WebKit (`web-check.mjs`), so whether each OS gives Electron a real one is unchecked (see "The desktop on each OS"). iOS: CoreLocation, when in use; checked in the simulator on a Mac with a set location |
| A shared location: a card with the coordinates and how far off they may be, opening a map | yes | yes | yes | `features/chat/MessageItem.tsx` (`LocationCard`) | `Chat/Location.swift` (`LocationCard`), `Chat/MessageRow.swift` | No map is drawn, as nothing in a message may load anything. Opens OpenStreetMap on the desktop and the web, Apple Maps on iOS |
| Link previews while writing | yes | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | Where each fetch really connected is checked: the desktop dials through `apps/desktop/src/main/preview-proxy.ts` unless the system has a proxy for the link, iOS reads `URLSessionTaskMetrics` in `apps/ios/ZunaKit/Sources/ZunaHost/WebBridge.swift` (checked with `swift test` on a Mac), the web host as it dials (`server/internal/webhost/address.go`) |
| Pinned messages, in a list only | yes | yes | yes | `features/chat/SidePanel.tsx` | `Chat/ChatExtras.swift` | Pins and unpins are signed in the core (`setPinned`); only one a member's device signed counts, and only a later one replaces it (`pinState`) |
| Search in a chat | yes | yes | yes | `features/chat/SidePanel.tsx` | `Chat/ChatExtras.swift` | |
| Disappearing messages: a timer per chat (off, 1 hour, 1 day, 1 week, 1 month), a line when it changes, a mark on each message and in the header | yes | yes | yes | `features/chat/SidePanel.tsx` (`DisappearingRow`), `lib/disappearing.ts`, `features/chat/MessageItem.tsx`, `features/chat/ChatView.tsx` | `Details/ConversationDetails.swift` (`disappearing`), `Shared/Format.swift`, `Chat/MessageRow.swift`, `Chat/ChatScreen.swift` | In the chat's signed details (`disappearAfter`): either person in a DM, admins in a group. Each message signs `expiresIn`, and the core erases it when due (`expireMessages`, the `expired` table); the server removes its copy within a minute (`expires_at`). Only offered on a server that says `disappearing`. iOS checked in the simulator on a Mac: the picker, the line, the header's mark and a message's |
| Keyboard shortcuts | yes | yes | yes | `features/chat/Composer.tsx`, `lib/focus.ts` | `Chat/Composer.swift` | iOS: hardware keyboards only |

## Details, groups and verification

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Details of a person | yes | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| Details of a group: members, roles, leaving, deleting | yes | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| A chat's photos, videos, files, audio files, shared links and voice messages, and groups in common, as in Telegram | yes | yes | yes | `features/chat/SharedMedia.tsx` | `Details/SharedMedia.swift`, `Details/ConversationDetails.swift` | Counted and paged by the core from a local index (`packages/core/src/media.ts`, `mediaCounts`, `loadMedia`), sorted as the message shows attachments. A message with links counts once; links in code and spoilers don't count (iOS: `Markup.sharedLinks`, `Attachment.mediaKind` in `ZunaModels`). No GIFs, which aren't a kind of their own. A video's tile shows its picture unblurred, then a frame taken from the video once it's loaded by itself (`useVideoFrame` in `lib/media.ts`; iOS `ImageStore.videoFrame`), and plays where it was sent; right click shows any item in the chat, a long press on iOS. iOS opens files and audio files in QuickLook, as its chat does |
| Labels when members and keys disagree | yes | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| New group, adding members | yes | yes | yes | `features/overlays/Overlays.tsx` | `Details/GroupSheets.swift` | |
| Invites | yes | yes | yes | `features/overlays/Overlays.tsx` | `Details/InviteSheet.swift` | |
| Blocking someone: from their details or a group's members, a list in Privacy to unblock | yes | yes | yes | `features/chat/SidePanel.tsx` (`BlockRow`, member menu), `features/overlays/Settings.tsx` (`PrivacySection`), `features/chat/ChatView.tsx`, `features/chat/MessageItem.tsx`, `features/shell/ConversationList.tsx` | `Details/ConversationDetails.swift`, `Settings/AccountSettings.swift` (`PrivacyView`), `Chat/ChatScreen.swift`, `Chat/MessageRow.swift`, `Shell/ChatListView.swift` | In the synced preferences (`blocked`, `setBlocked`), so neither they nor the server learn of it; nothing is refused or erased. Their messages are kept but show as a line with "Show", in quotes too, and don't count as unread, mention you, notify (`maybeNotify`, `push.ts`: `hidden`), or show typing; a group's preview skips them. Their direct message leaves the list but for a search, and its message box says so. On a phone that sends mutes to the server (`sendMuted`), their direct message goes as muted. They can still message you, add you to a group and see when you're online. Core in `chat-controls.test.ts`, desktop in `ui-check.mjs`, iOS in the simulator on a Mac (`ZunaUITests/Tests/ChatControlsTests.swift`) |
| Emoji verification | yes | yes | yes | `features/overlays/Overlays.tsx` | `Details/VerifyView.swift` | 16 emoji from Argon2id (`crypto/src/primitives.rs` `safety_digest`, `zuna/safety/v2`); apps from before show 12, and "They don't match" says so. Its title has the username as well as the name. "They match" waits for the emoji. iOS run on a Mac in `ZunaUITests/Tests/DetailsTests.swift` |

## Settings and administration

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Profile | yes | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Privacy: read receipts, online status, link previews | yes | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Privacy: removing metadata from files, on by default, saying what it shows and asking before it turns off | yes | yes | yes | `features/overlays/Settings.tsx` (`KeepMetadataConfirm`), `state/settings.ts`, `features/chat/Composer.tsx` | `Settings/AccountSettings.swift` (`PrivacyView`, an alert), `State/AppSettings.swift`, `State/ComposerState.swift` | Per device. Passes `keepMetadata` to `sendWithAttachments` (iOS: `SendOptions` in `ZunaModels`). Checked in `ui-check.mjs` and `SettingsTests` in the simulator: on by default, off takes "Turn off" (Escape closes only the question on the desktop), on again doesn't ask |
| Appearance: accent, message size, reduce motion, Enter sends | yes | yes | yes | `features/overlays/Settings.tsx`, `state/settings.ts` | `Settings/SettingsView.swift`, `State/AppSettings.swift` | |
| Security: own key, devices, password, recovery key | yes | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Replacing an account's keys, in the background | yes | yes | yes | `packages/core/src/session.ts` | same | All in the core, with nothing to see but the line below. iOS: `setCredential` through `CryptoBridge.swift` checked against WebAssembly (`tests/e2e/test/crypto.test.ts`), and a desktop follows a rotation made on the iOS host (`cross-client.test.ts`). Web checked in Edge only |
| Line in a chat when a verification lapses after someone's keys change | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | iOS built on a Mac, but the row hasn't been seen on screen |
| Server administration: icon, invites, members and bans, emotes, limits | yes | yes | yes | `features/overlays/ServerSettings.tsx` | `Settings/ServerSettingsView.swift` | |
| Notifications: on or off, sound, previews, badge | yes | yes | no | `features/overlays/Settings.tsx`, `state/store.ts` | `Notifications/Notifications.swift`, `Settings/NotificationSettingsView.swift`, `apps/ios/ZunaNotifications/` | iOS goes through the push relay (`docs/PUSH_RELAY.md`); its previews (`packages/core/src/push.ts`) say only "New message" for what the app wouldn't trust as the sender's: after their device left, after the epoch ended, or a changed key. The desktop words notifications in the session, which applies the same checks. Web: by design. The tab's title counts unread (`apps/web/src/platform.ts`), and only "Away after" is left in settings |

## One platform, by design

These aren't gaps, so don't port them without being asked.

- **Desktop only:** tray, title bar, automatic updates, system notifications and the unread badge, and Electron's fuses.
- **Desktop and web:** the resizable sidebar, and the content security policy (sent by `zuna-web` on the web).
- **Desktop only:** native screen capture, and push to talk from another window.
- **Web only:** one tab at a time with "Use here", the unread count in the tab's title, the "Zuna was updated" reload prompt, and the "Make the window bigger" notice below 860 × 540.
- **iOS only:** App lock with Face ID or passcode, the cover in the app switcher, the iPad split layout.

## The web app

Where the web differs from the desktop, all in `apps/web/src/` unless written out.

| Behavior | Code |
|---|---|
| Device key in IndexedDB, unprotected, with a warning in Security | `device.ts`, `platform.ts` |
| One tab at a time: a Web Lock, and "Use here" over a BroadcastChannel | `tab.ts` |
| Unread count in the tab's title, no notifications or sound | `platform.ts` |
| Away when the tab loses focus or is hidden, so the phone is notified | `platform.ts` (`onPresence`) |
| `#join=<invite link>` opens the join screen | `platform.ts` |
| Link previews fetched by the host | `worker.ts`, `server/internal/webhost/preview.go` |
| Files, headers and settings from the host | `config.ts`, `server/cmd/zuna-web/main.go`, `server/internal/webhost/webhost.go` |
| "Zuna was updated" when the host has a newer build | `platform.ts` (`onUpdate`), `packages/ui/src/App.tsx` |
| Asks before closing while anything is sending | `packages/ui/src/App.tsx` |
| Drops outside the message box don't leave the app | `main.tsx` |

## The desktop on each OS

The desktop is one codebase, and these are where the OSes differ (`apps/desktop/src/main/index.ts`, `apps/desktop/src/main/updates.ts`).

| Behavior | Windows | macOS | Linux |
|---|---|---|---|
| Automatic updates, on packaged signed builds | yes | yes | no |
| Closing the window keeps it running in the tray | yes | no | yes |
| Unread badge | icon overlay | dock count | `app.setBadgeCount` |
| Device key protected by the OS | yes | yes | Only with a real secret store. `basic_text` counts as unprotected |
| Asks the OS for the microphone | no | yes | no |
| Finds where this device is, for sharing it | unchecked | unchecked: needs the location entitlement and usage text, in `resources/entitlements.mac.plist` and `electron-builder.yml` | unchecked |
| Native screen capture, on the GPU | yes, NVENC only so far | no, by design: Chromium | unchecked from the app; ran in `poc/screenshare` on Arch with KDE and NVIDIA |
| Push to talk from another window | unchecked | unchecked: needs Accessibility permission | X11 only, unchecked |
| Asks the OS for the camera | no | yes, unchecked | no |
