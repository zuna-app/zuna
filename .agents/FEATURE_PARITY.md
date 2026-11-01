# Feature parity

For agents, not people. `CLAUDE.md` says how to keep this current. Keep it terse.

- **Status:** `yes`, `partial`, `no`. A row that's different by design says so in its notes.
- **Paths:** desktop and web paths start at `packages/ui/src/`, and iOS paths at `apps/ios/Zuna/`, unless they're written out in full.
- **Web** shares the desktop's interface (`@zuna/ui`), so its rows follow the desktop's unless a note says otherwise. What only the web does is in "The web app" below.
- **Android** doesn't exist yet (`docs/ROADMAP.md`). Add a column when it does.
- **Last full check:** 2026-11-01, by reading and searching the code on Windows. Nothing was run for it, and Swift can't be built on that machine, so iOS `yes` means the code is there. `docs/IOS_PLAN.md`'s phase reports record what iOS was tested with on a Mac.
- **Web check:** 2026-11-01 on macOS 27, `apps/web/test/web-check.mjs` in Chromium and WebKit: signing up, the title's count, reading, sending with a link preview, a picture, a voice message, a reload, a second tab and "Use here", the narrow-window notice, the web's settings, and signing in again on a cleared browser. Firefox wasn't run: neither Playwright's nor Mozilla's Firefox starts on macOS 27 ("Could not find profile folder").

## Known gaps

Things one platform should have and doesn't.

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
| Security alerts from the core | yes | yes | yes | `state/store.ts` | `State/AppModel.swift` | |

## Conversation list

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Everyone and groups, saved messages, rows with previews and unread counts | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Filters: All, People, Groups, Unread | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Search people, groups and messages | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Pin, hide, "Hidden (n)" | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Mute for a time | yes | yes | yes | `lib/mute.ts` | `Shared/Mute.swift` | |
| A preview for a message that can't be shown | yes | yes | yes | `features/shell/ConversationList.tsx` | `Shared/Format.swift` | |

## Chat: reading

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Header, status, changed-key banner | yes | yes | yes | `features/chat/ChatView.tsx` | `Chat/ChatScreen.swift` | |
| Message list: days, grouping, jumping, scroll button | yes | yes | yes | `features/chat/MessageList.tsx` | `Chat/MessageListController.swift`, `Chat/MessageRow.swift` | |
| Markup | yes | yes | yes | `lib/markup.tsx` | `apps/ios/ZunaKit/Sources/ZunaModels/Markup.swift`, `Chat/MessageText.swift` | Kept in step by the golden files |
| Code blocks with highlighting | yes | yes | yes | `components/CodeBlock.tsx` | `Chat/MessageParts.swift`, `apps/ios/ZunaKit/Sources/ZunaHost/Highlighter.swift` | Only the first 500 lines or 20,000 characters are colored, lines up to 1,000 characters, at most 50 ms each; the same limits in `lib/highlight.ts` and `apps/ios/core-bundle/src/highlight.ts` |
| 7TV emotes: animated, zero-width, large, card | yes | yes | yes | `components/Emote.tsx` | `Chat/EmoteImages.swift`, `Chat/MessageText.swift` | The card opens on hover on the desktop, long press on iOS |
| Whole emote set fetched in the background | yes | yes | yes | `lib/media.ts`, `features/shell/Shell.tsx` | `apps/ios/ZunaKit/Sources/ZunaHost/EmoteFiles.swift`, `Chat/EmoteImages.swift`, `State/AppModel.swift` | iOS keeps them on disk in Caches, since `URLSession`'s cache is too small. None on Low Data Mode, as the desktop skips it to save data |
| Read ticks | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
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
| Reply and edit | yes | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | iOS also swipes to reply |
| Autocomplete for `:emote` and `@person` | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/Composer.swift` | |
| Emoji and emote picker | yes | yes | yes | `features/chat/EmotePicker.tsx` | `Chat/EmojiPicker.swift` | |
| Attachments: up to 10, previews, size limit | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/OutgoingFiles.swift`, `Chat/Composer.swift` | |
| Pasting and dragging files in | yes | yes | yes | `features/chat/ChatView.tsx`, `features/chat/Composer.tsx` | `Chat/Composer.swift`, `Chat/ChatScreen.swift` | iOS pastes pictures, and dragging is mostly for iPad |
| Refusing a message too long to send | yes | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | The desktop checks first, iOS shows the core's error |
| Message menu: reactions, copy, edit, pin, delete | yes | yes | yes | `features/chat/MessageItem.tsx` | `Chat/ChatScreen.swift` | Deleting signs a deletion in the core (`deleteSigned`); a copy is only erased for one its author or a group admin signed, otherwise hidden and kept 30 days (`deletionProven`) |
| Forwarding | yes | yes | yes | `features/overlays/Overlays.tsx` | `Chat/Forwarding.swift` | |
| Picking several messages | yes | yes | yes | `features/chat/MessageItem.tsx`, `features/chat/Composer.tsx` | `Chat/ChatScreen.swift` | |
| Voice messages: recording | yes | yes | yes | `features/chat/Composer.tsx` | `Chat/Voice.swift` | By design: click to start on the desktop, hold on iOS |
| Link previews while writing | yes | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | |
| Pinned messages, in a list only | yes | yes | yes | `features/chat/SidePanel.tsx` | `Chat/ChatExtras.swift` | |
| Search in a chat | yes | yes | yes | `features/chat/SidePanel.tsx` | `Chat/ChatExtras.swift` | |
| Keyboard shortcuts | yes | yes | yes | `features/chat/Composer.tsx`, `lib/focus.ts` | `Chat/Composer.swift` | iOS: hardware keyboards only |

## Details, groups and verification

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Details of a person | yes | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| Details of a group: members, roles, leaving, deleting | yes | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| Labels when members and keys disagree | yes | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| New group, adding members | yes | yes | yes | `features/overlays/Overlays.tsx` | `Details/GroupSheets.swift` | |
| Invites | yes | yes | yes | `features/overlays/Overlays.tsx` | `Details/InviteSheet.swift` | |
| Emoji verification | yes | yes | yes | `features/overlays/Overlays.tsx` | `Details/VerifyView.swift` | 16 emoji from Argon2id (`crypto/src/primitives.rs` `safety_digest`, `zuna/safety/v2`); apps from before show 12, and "They don't match" says so. Its title has the username as well as the name. "They match" waits for the emoji. iOS run on a Mac in `ZunaUITests/Tests/DetailsTests.swift` |

## Settings and administration

| Feature | Desktop | iOS | Web | Desktop and web code | iOS code | Notes |
|---|---|---|---|---|---|---|
| Profile | yes | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Privacy: read receipts, online status, link previews | yes | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
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
