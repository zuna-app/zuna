# Feature parity

For agents, not people. `CLAUDE.md` says how to keep this current. Keep it terse.

- **Status:** `yes`, `partial`, `no`. A row that's different by design says so in its notes.
- **Paths:** desktop paths start at `apps/desktop/src/renderer/src/`, and iOS paths at `apps/ios/Zuna/`, unless they're written out in full.
- **Android** doesn't exist yet (`docs/ROADMAP.md`). Add a column when it does.
- **Last full check:** 2026-11-01, by reading and searching the code on Windows. Nothing was run for it, and Swift can't be built on that machine, so iOS `yes` means the code is there. `docs/IOS_PLAN.md`'s phase reports record what iOS was tested with on a Mac.

## Known gaps

Things one platform should have and doesn't.

- **iOS doesn't warn about a message's time.** The desktop flags a time far from what the sender's device signed. `MessageView.timeDiffers` is decoded in `apps/ios/ZunaKit/Sources/ZunaModels/Models.swift`, but no screen uses it.

## Accounts and servers

| Feature | Desktop | iOS | Desktop code | iOS code | Notes |
|---|---|---|---|---|---|
| Join by invite link with a preview, or an open server by address | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/OnboardingSteps.swift`, `Onboarding/JoinFlow.swift` | |
| `zuna://` links | yes | yes | `App.tsx`, `apps/desktop/src/main/index.ts` | `ZunaApp.swift` | |
| Set up a new server | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/JoinFlow.swift` | |
| Sign up: 8+ character password, strength meter | yes | yes | `lib/format.ts` | `apps/ios/ZunaKit/Sources/ZunaModels/AccountRules.swift` | |
| Recovery key shown and saved | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/OnboardingSteps.swift` | Desktop saves a file, iOS uses the share sheet |
| Sign in, recovery with a new password | yes | yes | `features/onboarding/Onboarding.tsx` | `Onboarding/OnboardingSteps.swift` | |
| Several servers, unread count per server | yes | yes | `features/shell/ServerRail.tsx` | `Shell/ServerListView.swift`, `Shell/MainView.swift` | By design: a rail on the desktop, a list like Mail's mailboxes on iOS |
| Reorder servers | yes | yes | `features/shell/ServerRail.tsx` | `Shell/ServerListView.swift` | By design: dragged on the rail, Edit on iOS. The desktop has no keyboard way yet |
| Sign out, erasing local data | yes | yes | `features/overlays/ServerSettings.tsx`, `features/shell/Shell.tsx` | `Settings/ServerSettingsView.swift`, `State/AppModel.swift` | |
| Signed out by the server: data kept, sign in again or clear | yes | yes | `features/shell/Shell.tsx` | `Shell/ChatListView.swift` | |
| Connection state | yes | yes | `App.tsx` | `Shell/ChatListView.swift`, `Shell/ServerListView.swift` | |
| Security alerts from the core | yes | yes | `state/store.ts` | `State/AppModel.swift` | |

## Conversation list

| Feature | Desktop | iOS | Desktop code | iOS code | Notes |
|---|---|---|---|---|---|
| Everyone and groups, saved messages, rows with previews and unread counts | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Filters: All, People, Groups, Unread | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Search people, groups and messages | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Pin, hide, "Hidden (n)" | yes | yes | `features/shell/ConversationList.tsx` | `Shell/ChatListView.swift` | |
| Mute for a time | yes | yes | `lib/mute.ts` | `Shared/Mute.swift` | |
| A preview for a message that can't be shown | yes | yes | `features/shell/ConversationList.tsx` | `Shared/Format.swift` | |

## Chat: reading

| Feature | Desktop | iOS | Desktop code | iOS code | Notes |
|---|---|---|---|---|---|
| Header, status, changed-key banner | yes | yes | `features/chat/ChatView.tsx` | `Chat/ChatScreen.swift` | |
| Message list: days, grouping, jumping, scroll button | yes | yes | `features/chat/MessageList.tsx` | `Chat/MessageListController.swift`, `Chat/MessageRow.swift` | |
| Markup | yes | yes | `lib/markup.tsx` | `apps/ios/ZunaKit/Sources/ZunaModels/Markup.swift`, `Chat/MessageText.swift` | Kept in step by the golden files |
| Code blocks with highlighting | yes | yes | `components/CodeBlock.tsx` | `Chat/MessageParts.swift`, `apps/ios/ZunaKit/Sources/ZunaHost/Highlighter.swift` | |
| 7TV emotes: animated, zero-width, large, card | yes | yes | `components/Emote.tsx` | `Chat/EmoteImages.swift`, `Chat/MessageText.swift` | The card opens on hover on the desktop, long press on iOS |
| Read ticks | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| Deleted, waiting for keys, unverified, invalid | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| Reply quote, jumping to the original | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| "Forwarded from" | yes | yes | `features/chat/MessageItem.tsx` | `Chat/Forwarding.swift` | |
| Link card showing the link's real host | yes | yes | `features/chat/MessageItem.tsx` | `Chat/Forwarding.swift` | |
| Pictures: grid, viewer that zooms, saving | yes | yes | `features/chat/MessageItem.tsx`, `features/overlays/Overlays.tsx` | `Chat/MessageParts.swift`, `Chat/PhotoViewer.swift` | iOS shares instead of saving |
| Very large pictures wait to be asked for | yes | yes | `lib/media.ts` | `Chat/MessageParts.swift` | |
| Videos and files, upload progress | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageParts.swift`, `Chat/FilePreview.swift` | |
| Voice messages: playing | yes | yes | `features/chat/MessageItem.tsx` | `Chat/Voice.swift` | |
| Reactions | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageParts.swift` | |
| System messages | yes | yes | `features/chat/MessageItem.tsx` | `Chat/MessageRow.swift` | |
| "You were removed from this chat", with clearing | yes | yes | `features/chat/ChatView.tsx` | `Chat/ChatScreen.swift` | |
| A warning when a message's time looks wrong | yes | no | `features/chat/MessageItem.tsx` | | See Known gaps |

## Chat: writing and actions

| Feature | Desktop | iOS | Desktop code | iOS code | Notes |
|---|---|---|---|---|---|
| Message box: draft per chat, grows with its text | yes | yes | `features/chat/Composer.tsx` | `Chat/Composer.swift`, `State/ComposerState.swift` | |
| Outbox: sending, try again, discard | yes | yes | `features/chat/MessageItem.tsx` | `Chat/ChatScreen.swift` | The queue itself is in the core |
| Reply and edit | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | iOS also swipes to reply |
| Autocomplete for `:emote` and `@person` | yes | yes | `features/chat/Composer.tsx` | `Chat/Composer.swift` | |
| Emoji and emote picker | yes | yes | `features/chat/EmotePicker.tsx` | `Chat/EmojiPicker.swift` | |
| Attachments: up to 10, previews, size limit | yes | yes | `features/chat/Composer.tsx` | `Chat/OutgoingFiles.swift`, `Chat/Composer.swift` | |
| Pasting and dragging files in | yes | yes | `features/chat/ChatView.tsx`, `features/chat/Composer.tsx` | `Chat/Composer.swift`, `Chat/ChatScreen.swift` | iOS pastes pictures, and dragging is mostly for iPad |
| Refusing a message too long to send | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | The desktop checks first, iOS shows the core's error |
| Message menu: reactions, copy, edit, pin, delete | yes | yes | `features/chat/MessageItem.tsx` | `Chat/ChatScreen.swift` | |
| Forwarding | yes | yes | `features/overlays/Overlays.tsx` | `Chat/Forwarding.swift` | |
| Picking several messages | yes | yes | `features/chat/MessageItem.tsx`, `features/chat/Composer.tsx` | `Chat/ChatScreen.swift` | |
| Voice messages: recording | yes | yes | `features/chat/Composer.tsx` | `Chat/Voice.swift` | By design: click to start on the desktop, hold on iOS |
| Link previews while writing | yes | yes | `features/chat/Composer.tsx` | `State/ComposerState.swift` | |
| Pinned messages, in a list only | yes | yes | `features/chat/SidePanel.tsx` | `Chat/ChatExtras.swift` | |
| Search in a chat | yes | yes | `features/chat/SidePanel.tsx` | `Chat/ChatExtras.swift` | |
| Keyboard shortcuts | yes | yes | `features/chat/Composer.tsx`, `lib/focus.ts` | `Chat/Composer.swift` | iOS: hardware keyboards only |

## Details, groups and verification

| Feature | Desktop | iOS | Desktop code | iOS code | Notes |
|---|---|---|---|---|---|
| Details of a person | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| Details of a group: members, roles, leaving, deleting | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| Labels when members and keys disagree | yes | yes | `features/chat/SidePanel.tsx` | `Details/ConversationDetails.swift` | |
| New group, adding members | yes | yes | `features/overlays/Overlays.tsx` | `Details/GroupSheets.swift` | |
| Invites | yes | yes | `features/overlays/Overlays.tsx` | `Details/InviteSheet.swift` | |
| Emoji verification | yes | yes | `features/overlays/Overlays.tsx` | `Details/VerifyView.swift` | |

## Settings and administration

| Feature | Desktop | iOS | Desktop code | iOS code | Notes |
|---|---|---|---|---|---|
| Profile | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Privacy: read receipts, online status, link previews | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Appearance: accent, message size, reduce motion, Enter sends | yes | yes | `features/overlays/Settings.tsx`, `state/settings.ts` | `Settings/SettingsView.swift`, `State/AppSettings.swift` | |
| Security: own key, devices, password, recovery key | yes | yes | `features/overlays/Settings.tsx` | `Settings/AccountSettings.swift` | |
| Server administration: icon, invites, members and bans, emotes, limits | yes | yes | `features/overlays/ServerSettings.tsx` | `Settings/ServerSettingsView.swift` | |
| Notifications: on or off, sound, previews, badge | yes | yes | `features/overlays/Settings.tsx`, `state/store.ts` | `Notifications/Notifications.swift`, `Settings/NotificationSettingsView.swift`, `apps/ios/ZunaNotifications/` | iOS goes through the push relay (`docs/PUSH_RELAY.md`) |

## One platform, by design

These aren't gaps, so don't port them without being asked.

- **Desktop only:** tray, title bar, resizable sidebar, automatic updates, and the content security policy and fuses.
- **iOS only:** App lock with Face ID or passcode, the cover in the app switcher, the iPad split layout.

## The desktop on each OS

The desktop is one codebase, and these are where the OSes differ (`apps/desktop/src/main/index.ts`, `apps/desktop/src/main/updates.ts`).

| Behavior | Windows | macOS | Linux |
|---|---|---|---|
| Automatic updates, on packaged signed builds | yes | yes | no |
| Closing the window keeps it running in the tray | yes | no | yes |
| Unread badge | icon overlay | dock count | `app.setBadgeCount` |
| Device key protected by the OS | yes | yes | Only with a real secret store. `basic_text` counts as unprotected |
| Asks the OS for the microphone | no | yes | no |
