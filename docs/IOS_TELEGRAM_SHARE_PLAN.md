# Sharing into Telegram chats from the iPhone's share sheet: plan

Someone with a linked Telegram account ([TELEGRAM_PLAN.md](TELEGRAM_PLAN.md)) shares a picture, a video, a file, a link or text from another app into one of that account's chats, through Zuna in the system's share sheet, and it's sent before the sheet closes, as to a Zuna chat. On the iPhone and iPad, the only apps with a share sheet. This page is why it was off, what was measured on 2026-11-22, what was decided, the design, and the order it was built in, on the same day ("Where it stands").

```
CoreLock, in the App Group       one process holds it at a time
 ├─ the app holds it             its core, and TDLib while there's a reason for it
 └─ the extension holds it       its own core, and TDLib only from Send until sent
TDLib's folder, in the App Group opened only by the process that holds the lock,
                                 and closed before that process lets go of it
```

The share extension already works this way for Zuna's own data: while the app sleeps it takes `CoreLock` and runs a core of its own, and while the app is awake it hands the app what to send (`ShareMailbox`). The plan puts TDLib's database under the same lock, so that whichever process holds the lock can reach the account.

## Why it's off today

- **Through the app, it always failed.** While Zuna was awake, the extension listed the chats the app had, the Telegram account's among them, and the app sent a share with `sendNow`, which `TelegramSession` doesn't have: the call was refused, and the sheet said "The operation couldn't be completed. (Zuna.ShareFailure error 1.)". Commit 35b44db6 left the Telegram account out of what the app answers (`answerTargets` in `Zuna/Share/ShareInbox.swift`) and gave the failure its words.
- **With the app asleep, it was never there.** The extension's own core has no engine. TDLib runs in the app's process, on a database in the app's own container, which no extension can open. It's there on purpose: iOS ends a process it suspends holding a file lock in the App Group (`0xDEAD10CC`), and TDLib holds the locks of `td.binlog` and `db.sqlite` for as long as it runs ([TELEGRAM_PLAN.md](TELEGRAM_PLAN.md), "No box: TDLib in the app").
- **The share sheet's row of people still offers Telegram chats,** as the account's notifications tell iOS of them (`MessageNotification.telegram`). Picking one opens the extension with nothing picked.

## Decisions

Asked for on 2026-11-22:

- **Sent from the sheet, before it closes,** as to a Zuna chat and as other apps do. Not left for Zuna to send when it's next opened, which the owner turned down.
- **The account's one session.** The extension opens the same TDLib database the app does. It doesn't sign in a second time: a second session would show as another device in Telegram, be another unofficial session for Telegram to watch, catch up from nothing at every share, and need the broker to call a function of the account's life, which it never does.
- **TDLib's folder moves to the App Group, under `CoreLock`.** TDLib runs only in the process that holds the lock, and has closed before the lock goes. This takes back "never the app group" in the first plan, which is changed with it.
- **In the extension TDLib starts at Send,** not as the sheet opens. The chats listed come from a sealed copy the app keeps.
- **A phone with too little memory says so** before anything is sent, rather than end in the middle.
- **The 408 a shared video got on 2026-11-22** is its own fault, of a server's proxy, and is looked at after this.

Answered the same day, once the plan was first written:

- **TDLib's folder is moved once,** and nobody links again. The owner left it to whichever is easier, and the move is: the folder left in the app's container has to be dealt with either way, and moving it spares every phone, and the test accounts, a new link.
- **The names of the account's chats may be kept in the App Group,** sealed, for the sheet's list.
- **No older iPhone is at hand.** What one gives the extension stays unknown, and the memory asked for at Send is what protects such a phone.
- **Nightlies needn't work with one another.** Nothing is kept for an older nightly's sake: what a step writes to the App Group may change with the next. And no step waits a set time for the one before it. Each is checked on the owner's phone the day its nightly is installed.

## What was measured

On 2026-11-22, on an iPhone 17 Pro Max with iOS 27.0.1 and TestFlight build 1732, with the owner's own Telegram account linked, read from the phone's log and an Activity Monitor trace:

| What | Found |
|---|---|
| The share extension's memory limit | 220 MB, hard (`Memory Limits: active 220 inactive 220`). The Telegram helper had 35 |
| What `ZunaShare` uses now, on its own core | 44 to 58 MB picking a chat, 57 sending a video, 70 at most, sending a photo |
| The app with TDLib running | About 100 MB, 127 for a moment after it starts |
| TDLib from nothing | Its first connection to Telegram 0.21 s after the app's process started, twice. The Telegram tab's list was drawn 1.5 s after |
| TDLib after a suspension, as now | A connection at once, which is dropped, and the one that lasts 1.5 s after the app is back, twice |
| What iOS ended meanwhile | Nothing, over two starts from nothing and five suspensions |

On the Mac, in the native app with a test account and the same TDLib, how long closing takes, from the core's `stop` to the engine's process gone, which it is only once TDLib says it closed:

| TDLib closed while | Took |
|---|---|
| Idle, six times | 30 to 34 ms |
| 0.1, 0.3 and 1 s after it started, nine times | 29 to 33 ms |
| Sending a 50 MB file, six times | 32 and 34 ms twice, 8.4 to 10.6 s four times |

In one of the slow ones TDLib's own log showed `close` reaching it 8.35 s after the stop, behind the file's remaining 86 parts, and closing 13 ms later. What held it back is the desktop's, either the core's `stop` waiting behind the upload's loop or the broker's pipe, which wasn't told apart. The longest is past the ten seconds after which the desktop's broker ends the engine's process itself. Five of the six sends cut short that way had finished once TDLib was started again, while the core still had the file, and the sixth was still going when it was looked at.

**Not measured:**

- **The limit on an older iPhone.** None was at hand to read it from. People report 120 MB for share extensions, on phones such as an iPhone 11, and Apple documents none. At 120 MB the extension's 70 and TDLib's share would not fit by much, or at all.
- **TDLib's own memory with a real account.** Over 35 MB as it starts, as that's the limit the helper ended at. 20 to 24 MB on a test account with one chat.
- **Closing on a phone,** which no build does yet.
- **Whether TDLib leaves a file of its folder open after it closed,** which iOS would end a suspended process for as for a lock (`CoreLock`).

## The design

### One lock for both

`CoreLock` already says which process runs the core. The same lock now says which process may run TDLib:

| The process | Runs TDLib |
|---|---|
| The app, on screen | Yes |
| The app, out of sight and still awake: its background task's time, a call, a share it's sending | What was running goes on. Started only for a call's push, as now, or for a share to Telegram handed to it |
| The app, asleep | No. It closed before the lock went |
| The extension, picking | No |
| The extension, from Send to a Telegram chat until it's sent | Yes, if there's memory for it |

Two rules hold it together, each with a test:

- **TDLib has a client only while its process holds the lock.**
- **That client has closed before the lock is released,** whichever way the lock goes: asked for, or as the background task's time runs out.

### The app: closed before it sleeps

Today nothing is told to TDLib as the app leaves the screen, and iOS suspends it with its database open. That's allowed in the app's own container and not in the App Group.

- **`TelegramBridge` gains a close for sleep.** It takes the run away first, as a stop does, so that nothing the closing client says reaches the core: the core takes an `authorizationStateClosed` it didn't ask for as the session ended from another device, and erases the account (`onAuth` in `packages/core/src/telegram/session.ts`). Then it sends `close`, straight to TDLib, and waits for the client to say it closed, for two seconds at most. It stays wanted. It says whether it closed, and logs how long it took, at a level the phone's log keeps.
- **Waking starts a client again,** and tells the core `zunaRestarted` first, as the desktop's broker does when its engine's process was started again: what waited for an answer fails, the account shows as connecting, and the list is read again as TDLib says it's ready. What the session held, its chats and the files it was sending, stays.
- **"Out of sight" stays what it is,** a reason not to start (`setTelegramOutOfSight`). Asleep is new, and separate: `CoreRuntime.sleepTelegram()`, which waits for the close, and `wakeTelegram()`.
- **`CoreController.goToSleep` closes TDLib before it lets go of the lock,** after the core's own `suspend`, and `wakeUp` starts it once the lock is the app's again, if the app is on screen, or a call or a share wants it.
- **`LockKeeper` closes it as the time runs out too.** `expired` lets go of the lock at once today. It gains a step that's waited for, with a limit, before the lock goes and the background task ends: close TDLib, release, tell the app (`onLost`), end the task.
- **What it can't close in time is said, and not waited for.** The lock still goes, and iOS may then end the app as it suspends it, which costs a start from nothing and no data, as TDLib's binlog is written to live through that. It's logged as a fault with the time it had taken.
- **A file being sent stops being handed over as TDLib closes,** as the broker refuses the parts once the run is gone, and is asked for again when TDLib next starts, while the core still has it. The close doesn't go through the core, so it never waits behind an upload's loop.
- **A call keeps the app awake** (`keepsCoreAwake`), so TDLib is never closed under one.

### TDLib's folder

- **In the App Group, beside the core's data:** `telegram` in `SharedStorage.dataDirectory()`, made by the broker as now, protected until the phone is first unlocked and left out of backups. The key to its database is there already, sealed with the device key (`telegram-key.sealed`), which the extension has.
- **Moved once from the app's own container,** by the app, with the lock held and before TDLib first starts: a rename, as both are on one volume. Stable releases 0.1.0 and 0.2.0 carry Telegram, so an account may be linked in one, and without the move everyone links again. If both folders are there, the App Group's stays and the other is erased.
- **The marks starts leave are kept for each process.** `start-marks.json` stays the app's. The extension keeps its own, so that an extension iOS ended twice as TDLib opened its database can't stop the app's Telegram from starting. With two of its own left, the extension says to send from Zuna.
- **Which of Telegram's servers the database is for goes with it.** A development build asks the test servers unless launched with `-ZunaTelegramTestDC NO`, which the extension's own launch can't be given. The app writes which it used beside the folder, and the extension reads that.
- **Who else can read it.** The notification extension shares the App Group and holds the device key, as the share extension does, and the broadcast extension shares the App Group without the key. The database stays encrypted under a key sealed with the device key. No new party reads anything, and `SECURITY_DETAILS.md` says where it is.

### TDLib in two bundles

- **A framework of its own, `ZunaTD`,** in `apps/ios/telegram.yml`: the static libraries `scripts/tdlib.mjs --ios` builds, linked once, with the functions of `apps/ios/TDLib/TDLib.h` exported, and built for extensions too (`APPLICATION_EXTENSION_API_ONLY`). The app embeds it and both link it. Linking TDLib into each instead would put it in the download twice. Step 2 weighs both and keeps the smaller.
- **`Zuna/Telegram/TDLibEngine.swift` is built into `ZunaShare` too,** with `ZUNA_TELEGRAM`, and the extension's Info.plist carries the api_id and hash as the app's does, from the same environment and never the repository.
- **A build without an api_id has none of it,** as now: no framework, and an extension without Telegram.
- **Nothing to sign anew.** A framework is no extension: `PROFILES` in `scripts/ios-dist.mjs` and the `testflight` environment stay as they are. `IOS_PATHS` has `apps/ios/` already.

### The extension

- **Its core is given Telegram, asleep.** `ShareCore.wake` passes `TelegramSetup.configuration()` in the runtime's options. The core starts its Telegram session as it opens, as it does wherever an account is linked, and the bridge holds that start until it's woken.
- **It never registers the device with Telegram.** Left as it is, a bridge with no VoIP token takes the app's back as TDLib says it's ready, and erases what a call's push is known by (`registerVoip`): every share would end the phone's ringing for Telegram calls. A switch in the bridge's configuration says whether it registers at all, and the extension's is off. It never says the account is online either, as nothing there calls `setActive`.
- **The chats come from a sealed copy.** The app writes the Telegram account's chats that can be written in, in its list's order, to a file in the App Group whenever they change, sealed as `ShareMailbox` seals what it writes, and erases it when the account is unlinked. Names, kinds and what a picture is found by, and nothing that was said: no line of the latest message, which would be behind anyway. Pictures are the small ones the app keeps for notifications (`TelegramPictures`), for the top hundred chats, and initials for the rest.
- **Telegram shows as one more server** in the sheet's chooser, with its own icon, and is where the sheet opens if it was open last in the app. A chat picked from the share sheet's row of people is found by the same name notifications gave it, `telegram/<key>`.
- **At Send, for each Telegram chat picked:** what the picker held is let go of, the memory left is asked for (`os_proc_available_memory`), TDLib is woken, and the core's `sendNow` sends and waits. Zuna's chats in the same share go first, as they need none of it. TDLib is closed, as the app closes it, before the core is put away and the lock goes.
- **Too little memory is said before anything starts:** "There isn't enough memory to send to Telegram from here. Open Zuna and send it there." The line it's held to comes from step 5's measurements, and starts at 80 MB left. What the extension has left is logged as TDLib starts there and again once the share is sent, at a level a phone's log keeps, so a tester's log tells what an older phone gives it.
- **The app that's sharing leaving the screen** (`hostLeft`) is handled as now, with TDLib closed before the lock goes as the time runs out.
- **No bar for how far a file has gone,** as the Telegram session tells of none. The sheet shows it's sending.
- **App lock, the proxy and what the App Store's rules withhold** apply as in the app: the extension asks for App lock first as now, the door takes the proxy `ProxyStore` applies, and the copy holds only chats the app's list shows.

### The core

- **`TelegramSession.sendNow`,** with the server session's arguments. It waits until the account is signed in, for 20 seconds at most. A group the list hasn't told of yet is asked for by its ID (`getChat`, which is on the broker's list), as in the extension the list is still coming. It sends as `sendWithAttachments` and `sendMessage` do, then waits until Telegram has each message (`updateMessageSendSucceeded`), throws what Telegram said of one it refused (`updateMessageSendFailed`), and after a minute says it's taking long, as a server's does. The link preview it's handed is left to Telegram.
- **In `TELEGRAM_METHODS`** (`rpc.ts`), and `"never"` in `TELEGRAM` (`packages/plugin-sdk/src/surface.ts`). `ZunaModels/CoreAPI.swift` has `sendNow` already.
- **A message whose file nobody has any more** is one TDLib asks for and is told isn't being sent (`generate`), so it fails and shows as not sent, where it can be deleted. That's what an extension ended in the middle leaves.
- **Nothing new for the broker's list.** `close` is the broker's own.
- **The extension's core reads none of the account's chats** once it's signed in (`telegramSendsOnly`, `sendsOnly` on the session): the app reads them in pages, up to five thousand, which the extension would pay for in memory for nothing, as `sendNow` finds the one it sends to by itself. Added while building it.

### Through the app, while it's awake

- **`answerTargets` gives the Telegram account's chats again,** live, with their latest messages.
- **`ShareSender` needs no change:** it calls `sendNow` on whichever session the chat is on. If TDLib isn't running, as in an app started out of sight for a call, the share starts it, as a call's push does.
- **Who was shared to is told to iOS** as now (`ShareSuggestions`), with a Telegram chat's picture from `TelegramPictures`, as the core can't fetch one where TDLib isn't running.

## The order to build it in

Each step leaves the app as it was for anyone using it, so a nightly cut for something else in between carries nothing half made. Telegram stays out of the sheet until step 5.

1. **The core's `sendNow` for Telegram.** Shown by the core's tests on the fake engine. Nobody sees it.
2. **TDLib as a framework,** linked by the app alone. Shown by Telegram working as before in the simulator and on a phone, and the download's size against a build that links it into the app.
3. **The app closes TDLib before it sleeps and starts it as it wakes,** with the folder still in the app's own container, where a close that came late ends nothing. Shown by the bridge's and the keeper's tests, and on the owner's phone the day its nightly is installed: the app is driven through sleeps and wakes over USB, as for the measurements of 2026-11-22, with a file being sent in some of them, and the phone's log gives every close's time and when the account was back online, which should be no later than now.
4. **The folder moves to the App Group,** with the one move from the app's container. From here a late close can end the app. Shown the same way, the day its nightly is installed, by a log with no `0xDEAD10CC` and no "suspended with locked system files". Step 5's check reads the log since then for the same.
5. **The extension sends,** and Telegram comes back to the sheet, through the app and through the extension's own core in one commit: the sealed copy, TDLib in the extension, the memory it asks for, its own marks, no registering, the texts in every language. Shown on a phone: the limit and what the extension uses with TDLib running, photos and a large video to Saved Messages and to a group, a chat picked from the row of people, leaving the sharing app while it sends, and opening Zuna while it sends.

## How it's tested

- **The core,** on the fake engine (`packages/core/test/telegram.test.ts`): `sendNow` back once Telegram has the message, throwing what Telegram refused, giving up after its time, a group not listed yet, and a send that an engine started again in the middle finishes.
- **The bridge and the keeper,** on a Mac with the fake engine (`TelegramBridgeTests`, `LockKeeperTests`): a close for sleep reaches the core as nothing, a wake as `zunaRestarted` and a start, a client that doesn't close is given up on in time, a bridge told not to register sends no `registerDevice`, the extension's marks leave the app's alone, and the keeper's time running out closes before it releases and ends its task after.
- **The simulator,** with the test account linked: after a close for sleep `lsof` shows nothing of the folder open, the move from the app's container, and a share to Saved Messages with the app asleep. `ShareTests` stays on a build with no Telegram, as the e2e build has none.
- **A phone, for what only a phone shows:** the extension's memory with TDLib in it, that iOS ends nothing at suspension, and how long a close takes with a real account. Only the owner's iPhone 17 Pro Max is at hand, so what an older one gives the extension comes from a tester's log, if one sends it.

## What changes with it

- **`docs/TELEGRAM_PLAN.md`:** where TDLib's folder is ("What's kept"), that iOS no longer suspends TDLib open ("No box: TDLib in the app"), and "Left for later there", which this was.
- **`docs/SECURITY_DETAILS.md`,** and `SECURITY.md` if it says where a linked account's data is: the folder in the App Group, and TDLib in the share extension's process, which holds Zuna's keys as the app's does.
- **`docs/IOS.md`** on the share extension, and **`docs/TELEGRAM.md`** if it says what the iPhone can't do.
- **`.agents/FEATURE_PARITY.md`:** the row for sharing into Zuna, which says never the Telegram account's chats, and the iPhone's Telegram.
- **`CLAUDE.md`:** the Gotcha on the iPhone's TDLib, which says its folder is never in the app group.
- **`apps/site`,** read at step 5 for anything it says of where a linked account is kept or what the share sheet reaches.
- **`packages/i18n/locales`:** the new texts, in every catalog, in the commit that adds them.

## Risks

- **A close that comes late ends the app at suspension.** Step 3 measures it where that costs nothing, before step 4 makes it count. A phone's log names it when it happens.
- **An older iPhone may give the extension too little memory,** and which do isn't known. It then refuses a share to Telegram with its reason, and Zuna's own chats still go.
- **While the extension sends, the app waits for the lock,** as it does today for a share to a Zuna chat, and now Telegram waits with it: Zuna opened then shows nothing new until the share is done, and a Telegram call's push rings at once and connects only after.
- **An extension iOS ends in the middle leaves a message not sent** in the Telegram chat.
- **TDLib ending its process on purpose ends the sheet.** The extension's marks keep it from doing so at every share.
- **The sealed copy can be behind** by a chat made since Zuna was last open.
- **The first plan's rule is given up further:** TDLib's database is where the app's extensions can reach it, and TDLib runs in one more process with Zuna's keys.

## Left out

- **Sending when Zuna is next opened,** with a notification to tap. Turned down: other apps send from the sheet.
- **A session of the extension's own.** "Decisions" says why.
- **Waking the app out of sight to send,** by a background transfer or a push from a Zuna server. The first wakes no app its person closed and can't be held to the proxy, and the second tells a Zuna server of Telegram, which the first plan's first rule forbids.
- **The chats read from TDLib as the sheet opens.** It would cost every share a start of TDLib and its memory, for a list a moment fresher.
- **The app finishing a share the extension was ended in.** It would need the share's files kept and matched to TDLib's messages.
- **The extension letting go of the lock for a call's push.** It would need a way for the app to ask.
- **Sharing into Zuna on the desktop,** which is a gap of its own in `.agents/FEATURE_PARITY.md`.

## Questions for the owner

None open. The four asked with the first draft were answered on 2026-11-22, and are under "Decisions".

## Where it stands

Written on 2026-11-22, and changed the same day for the owner's answers. Built the same day, all five steps, and checked as far as a Mac and the simulator can:

- **Step 1,** `TelegramSession.sendNow`: the core's tests on the fake engine, for a message back once Telegram has it, what Telegram refused, giving up after its time, a group not listed yet, a send across the engine starting again, and an engine that stopped.
- **Step 2,** `ZunaTD`: 41.9 MB in a Release build for phones, 13.4 MB of it the symbol table an archive strips, so linked into each binary instead the extension would carry about 28 MB more. Its privacy manifest declares its files' times and the free space, from what it links (`nm -u`). In the iOS 26 simulator TDLib from it reached Telegram's test servers through the door.
- **Step 3,** closed before the app sleeps: the bridge's and the keeper's tests, and in the simulator a close of 23 ms, none of TDLib's files open after it, and TDLib online again a second after the app was back. A file being handed to TDLib as it closes is handed over again to the next one, which the plan hadn't seen: the core gave it up before, and the app would have taken its copy away.
- **Step 4,** the folder in the App Group: the move on the first launch, TDLib on its database there, and a close of 32 ms as the app slept, with none of its files left open.
- **Step 5,** the extension: built, linking `ZunaTD` from the app, the bridge's tests for a broker that waits for the lock, registers nothing and keeps its own marks, and the core's for sending without reading the list. `ShareTests` on a build without Telegram.

**On the owner's phone,** the day nightly 0.3.0-nightly.1749 was installed (2026-11-22, iPhone 17 Pro Max, iOS 27.0.1, the owner's own account linked), driven over USB through two starts from nothing and two returns from sleep, then a share from Photos with Zuna asleep:

| What | Found |
|---|---|
| The folder's move | On the first start, the account still linked |
| TDLib closed as the app slept | 23, 12, 10 and 13 ms, and the app suspended a tenth of a second after each |
| What iOS ended for a lock (`0xDEAD10CC`) | Nothing, the app nor the extension |
| TDLib's first connection to Telegram after a start, or a return from sleep | 0.07 s and 0.49 s, and 0.07 s and 0.47 s: a return is faster than the 1.5 s it took before step 3 |
| A share to Saved Messages with the app asleep | Sent by the extension's own TDLib, there on the owner's other devices; about 0.5 MB went to Telegram, the whole run of TDLib 0.85 s |
| The extension's memory, of its 220 MB | 53 MB before Send, 71 at most while TDLib ran, 55 once it closed. Its log: 167 MB left before TDLib, 148 after |
| TDLib closed in the extension | 14 ms |

What an older iPhone gives the extension is still unknown, but with 71 MB at most, a 120 MB limit would leave it room.

**Not run yet:** a large video, a group, a chat picked from the row of people, leaving the sharing app while it sends, and opening Zuna while it sends.

## What was read

- [Dealing with memory limits in iOS app extensions](https://cur.at/sykla3a?m=web), and React Native's page on [app extensions](https://reactnative.dev/docs/app-extensions), for the 120 MB people report.
- Apple's developer forums on extensions' limits: [each extension point sets its own](https://developer.apple.com/forums/thread/779756), and [how the limit follows a device's memory isn't said](https://developer.apple.com/forums/thread/106377).
