# iPhone: give the Telegram helper 400 MB

A plan for an agent to carry out, written on 2026-11-15 after a day of reading one iPhone's logs. It's for agents, like `FEATURE_PARITY.md`, so don't link to it from anything written for people. **Remove this file in the commit that finishes it.**

Nothing here is built yet. The person who owns the phone chose this way over two others (below), knowing what's still unknown about it.

## Why

A linked Telegram account on the iPhone hangs on "Connecting", for seconds or minutes, each time the app comes back. It isn't the network. Measured on an iPhone 17 Pro Max, iOS 27.0.1, TestFlight build 1559:

- **iOS ends the helper for memory.** RunningBoard gives `ZunaTelegram` `set Memory Limits to Hard ExternalExtension_NonUI (35)`, and the kernel logs `memorystatus: ZunaTelegram [pid] exceeded mem limit: ActiveHard 35 MB (fatal)`. In four hours 24 of 29 starts ended that way, most within 250 ms of the start. One return to the app took 13 starts and two minutes.
- **TDLib alone nearly fills that.** The same helper in the simulator, on a test account with one chat, is at 20 to 24 MB (`footprint <pid>`). A real account adds its chats and what it missed while away.
- **The 35 MB can't be raised.** Apple's DTS says so of the same number for an enhanced security helper (developer.apple.com/forums/thread/852862), and `increased-memory-limit` isn't offered to an extension.
- **iOS also ends the helper at every suspension,** `0xDEAD10CC`: "suspended with locked system files" `td.binlog` and `db.sqlite`. So every return is a cold start, and each cold start meets the limit. This plan doesn't change that (see "Not in this plan").

## What was found, so it isn't looked for again

Tried with a throwaway app on that phone and in the simulator:

- **An extension point that says it has an interface gets 400 MB.** With `UserInterface()` in the definition RunningBoard logs `set Memory Limits to Hard ExternalExtension_UI (400)`, and the kernel ended a probe that kept filling memory at exactly 400 MB. Measured on that one phone, with 12 GB: other models may get another number.
- **Its extension then has to be a scene extension.** One with `ConnectionHandler` alone, as the helper is now, dies at once with `Fatal error: Failed to create running extension of type: 'UIKitUI'`. One whose configuration is ExtensionKit's `AppExtensionSceneConfiguration` starts, as type `UIKitUI`, at a footprint of 2 to 4 MB.
- **No view has to be shown.** The app never makes an `EXHostViewController`. It makes the process and a connection, as now.
- **`makeXPCSession()` gets no answer from such an extension.** It has no `.xpc-session` listener, and the request waits for good. Swift's `XPCEndpoint`, the anonymous `XPCListener` and `XPCSession(endpoint:)` are macOS only, so a session can't be handed over another way.
- **`makeXPCConnection()` does.** The scene configuration takes a second configuration, and `ConnectionHandler(onConnection:)` there is given the app's `NSXPCConnection`. A method with a reply block was answered, on the phone too.

Not tried yet, and what the phone has to show before this ships: see "On a phone".

## The change

Three files carry the transport: `apps/ios/Zuna/Shared/TelegramWire.swift` (compiled into the app and the helper), `apps/ios/Zuna/Telegram/TelegramHelper.swift` (the app's end, `XPCLauncher` and `XPCLink`) and `apps/ios/ZunaTelegram/TelegramHelper.swift` (the helper's end, `Helper`). They move from `XPCSession` and `XPCDictionary` to `NSXPCConnection`. Read all three, and `ZunaHost/TelegramBridge.swift`'s `TelegramHelperLauncher`, `TelegramHelperHandlers` and `TelegramHelperLink`, before writing anything.

**What stays as it is:** `TelegramHelperLink` and everything else in `ZunaHost` (the broker, the door's app end, the list of functions, their tests), `Door.swift`, `Engine.swift`, `Probe.swift`, the JSON both sides send (`start`, `erase`, `open`, `opened`, `refused`, `closed`, `failed`, `erased`, `probe`, `probed`, `reclaim`, and TDLib's own), the helper's bundle identifier, its Info.plist, its entitlements, `apps/ios/telegram.yml` and `scripts/ios-dist.mjs`. The identifier decides the helper's data container, where the linked account's database is, so it must not change.

### 1. The extension point

In `Zuna/Telegram/TelegramHelper.swift`:

```swift
@Definition
static var telegram: AppExtensionPoint {
    Name("telegram")
    UserInterface()
}
```

The build writes it into `Zuna.app/Extensions/Zuna.appexpt` as `EXPresentsUserInterface`. Rewrite the comment above it: it now has to say why an extension point that shows nothing says it has an interface (the 400 MB against 35, measured when and on what), beside why it isn't `EnhancedSecurity()`.

### 2. The wire

Two Objective-C protocols in `TelegramWire.swift`, in place of the dictionary keys and their helpers (`message`, `setData`, `data`, `setDescriptor`, `descriptor`, `Answer`, `streamID` all go). `mostData` and `mostJSON` stay, and both ends still refuse JSON over `mostJSON`. A starting point:

```swift
/// What the app asks of the helper.
@objc protocol TelegramHelperCalls {
    /// That it's there and took this connection.
    func hello(reply: @escaping @Sendable (Bool) -> Void)
    /// JSON: a request of TDLib's, or one of the app's own (`zuna`).
    func json(_ text: String)
    /// What Telegram's end of a connection through the door sent, answered once it's written to TDLib's.
    func data(_ bytes: Data, stream: UInt32, reply: @escaping @Sendable () -> Void)
    /// A file of the helper's folder, by the path TDLib gave, opened for reading, or why not.
    func file(_ path: String, reply: @escaping @Sendable (FileHandle?, String?) -> Void)
}

/// What the helper says to the app.
@objc protocol TelegramAppCalls {
    /// JSON: an answer or update of TDLib's, or one of the helper's own (`zuna`).
    func json(_ text: String)
    /// What TDLib sent on a connection through the door, answered once it's gone to Telegram.
    func data(_ bytes: Data, stream: UInt32, reply: @escaping @Sendable () -> Void)
}
```

Keep the file's header comment true: it describes each kind of frame, and who waits for whom. The rule it states must survive the move: neither side ever holds more than one part of a connection the other hasn't taken.

### 3. The helper's end

In `ZunaTelegram/TelegramHelper.swift`, with `import ExtensionKit` and `import SwiftUI`:

```swift
extension TelegramExtension {
    @MainActor var configuration: AppExtensionSceneConfiguration {
        AppExtensionSceneConfiguration(
            PrimitiveAppExtensionScene(id: "none") { EmptyView() },
            configuration: ConnectionHandler(onConnection: { connection in Helper.shared.accept(connection) })
        )
    }
}
```

`Helper` becomes an `NSObject` that is the connection's exported object (`TelegramHelperCalls`):

- `accept(_ connection: NSXPCConnection) -> Bool`: false while a connection is held or it's closing, as `reject` did. Otherwise set `exportedInterface`, `exportedObject`, `remoteObjectInterface` (`TelegramAppCalls`) and an `invalidationHandler` that calls `appWent()`, `resume()` it, keep it, return true.
- `appWent()` must do its work once, however often it's called.
- `send(json:)`: `remoteObjectProxy` as `TelegramAppCalls`, `json`.
- `sendWaiting(stream:bytes:)`: `synchronousRemoteObjectProxyWithErrorHandler`, `data`, and true only if the reply came. It runs on a `door-stream` thread, which is what waits, as `sendSync` made it.
- The calls in: `hello` answers true; `json` goes to `heard`; `data` goes to `door.write` and replies when that's done, or at once when there's no door or stream; `file` is `opened`, which now answers with a `FileHandle(fileDescriptor:closeOnDealloc: true)` or the same two error texts.

### 4. The app's end

In `Zuna/Telegram/TelegramHelper.swift`, `XPCLink` becomes an `NSObject` that is the connection's exported object (`TelegramAppCalls`), made from `process.makeXPCConnection()`:

- `connect`: set `remoteObjectInterface`, `exportedInterface`, `exportedObject`, the interruption and invalidation handlers, `resume()`, then `hello` through a synchronous proxy, as `sendSync` was. A helper still closing from the run before returns false from `accept`, which invalidates this connection: `connect` throws, and `XPCLauncher`'s loop tries again, as it does now for a session turned away.
- `send(json:)`: `remoteObjectProxy`, `json`. A connection that's gone is told by its invalidation handler, which ends the link.
- `send(stream:bytes:taken:)`: `remoteObjectProxyWithErrorHandler { _ in taken(false) }`, `data`, with `taken(true)` in the reply.
- `open(path:done:)`: `remoteObjectProxyWithErrorHandler`, `file`.
- `end(_:)`: `connection.invalidate()` where it cancelled the session, then `process.invalidate()` and `handlers.ended`, once, as now.
- The calls in: `json` to `handlers.json`, within `mostJSON`; `data` to `handlers.data`, replying when it's taken.

### 5. The helper says how much memory it has

A few lines in the helper, logged at notice so that a TestFlight build's log keeps them (`log show` drops info): its footprint (`task_info`, `TASK_VM_INFO`, `phys_footprint`) and what iOS says is left (`os_proc_available_memory()`), once as TDLib starts and again each time the footprint first passes another 25 MB, looked at every few seconds. Numbers only, nothing of the account's. Today there was no way to learn a real account's use from a phone, and the sum of the two is the limit iOS really gave, which is how the next phone model's number gets known.

## Traps

- **Swift 6, with warnings as errors.** The app's targets build that way (`ZUNA_WARNINGS_AS_ERRORS`, `scripts/check-ios.mjs`). `NSXPCConnection` and `AppExtensionProcess.Configuration` aren't `Sendable`: the process is made in a nonisolated function now, and making it on the main actor doesn't compile. A reply block that sets a local needs a small locked box, not a captured `var`.
- **The handlers and `hello`.** If the invalidation handler ends the link while `connect` is still at `hello`, `handlers.ended` reaches the broker for a link it was never given, and the broker starts a second helper beside the launcher's own retry. Set the handlers before `resume()`, and have them do nothing until `hello` has answered, remembering that the connection went, so that `connect` then throws.
- **Every reply block is called once.** One that's never called leaks, and a `door-stream` thread waits on it for good. With `remoteObjectProxyWithErrorHandler`, either the reply or the error handler runs, so `taken` is called once either way: don't call it from both by hand.
- **A cycle.** The connection keeps its exported object, and the link keeps the connection. `invalidate()` lets the exported object go, so every way a link ends must reach `end`.
- **Order.** TDLib's answers and the door's `open` and `closed` are told apart by order on one connection. Send everything through the one connection, never a second.
- **Unverified under NSXPC here:** a `FileHandle` in a reply, `Data` parts both ways, and calls from the helper to the app's exported object. The probe only tried one call with a `String` reply. If one of them doesn't work, say so before working around it.

## Checks

Before any phone:

1. `swift test` in `apps/ios/ZunaKit`. `TelegramBridgeTests` use a launcher of their own and shouldn't change.
2. `npm run test:ios:check`, which builds the app with the helper, warnings as errors.
3. **The simulator "iPhone 17 Pro (iOS 26)"** holds a linked Telegram test account, in Zuna Debug. Don't launch with `-ZunaResetData` or unlink it: linking again needs the person to scan a code. The memory notes on iPhone Telegram testing say how to build with the api_id (a scratch script that calls `iosTelegram({ sdks: ["iphonesimulator"] })` from `scripts/tdlib.mjs`, then `xcodegen` and `xcodebuild` with that environment and `-derivedDataPath apps/ios/build/TelegramSim`, never the api_id on a command line), and how to drive the app. Then:
   - `Zuna.app/Extensions/Zuna.appexpt` has `EXPresentsUserInterface` true.
   - `simctl install`, `simctl launch <sim> chat.zuna.mobile -ZunaControlPort 9555`, and the simulator's log (`simctl spawn <sim> log show --last 2m --predicate …`): runningboardd names `ExternalExtension_UI` for the helper, the helper says `of type: \`UIKitUI\` launched`, and nothing says `Failed to create running extension`.
   - The account comes online and its list shows, with pictures: a picture is a file copied out through `file`, so it proves the `FileHandle` reply. A screenshot (`simctl io <sim> screenshot`) of the Telegram tab is the proof.
   - `telegramReclaim` on the control channel: connecting for a few seconds, then online again (`docs/IOS_TESTING.md`).
   - Leave the app (`simctl launch <sim> com.apple.mobilesafari`), wait half a minute, come back: online again without the app being started again.
   - `kill -9` the helper (`pgrep -f 'ZunaTelegram.appex/ZunaTelegram'`): the broker starts another, and the account is online again.
   - The memory lines are in the log (`subsystem == "chat.zuna.telegram"`).

The simulator runs the helper in no box, gives it no limit and never ends it for a held lock, so none of that says anything about a phone.

## On a phone

Only a phone answers these, and **installing a Debug build on the person's phone replaces their TestFlight Zuna, so ask first, every time.** A Debug build uses Telegram's test servers unless launched with `-ZunaTelegramTestDC NO`; say which you mean to do and why before doing it. If they'd rather not, the first nightly with this is the test, read from the phone's log afterwards (the memory note on the phone's log archive has the commands, the kill codes and how to record a process's memory with `xctrace`).

| What isn't known | How it's read | What stops this from shipping |
|---|---|---|
| The helper starts as a hardened process under UIKit (its entitlements, arm64e in a release) | It runs; `of type: UIKitUI launched` in the phone's log | It doesn't start. Don't drop an entitlement to make it: that's the person's choice |
| The limit | runningboardd `set Memory Limits to Hard ExternalExtension_UI (N)`, and the helper's own memory lines | N near 35 |
| iOS keeps the helper's data container | The linked account is there; no `not started:` from the helper (`cantStart`) | The account's data "isn't in the folder". Nothing is erased, as `cantStart` holds it, but stop |
| The box is the one it was | `telegramProbe` on the control channel, a Debug build: everything refused but its own container, its loopback, the network and the system's random numbers (`docs/IOS_TESTING.md`) | Anything newly allowed: the app's data, the app group, Zuna's keychain items, other apps', photos, starting a program |
| What iOS does to it at suspension | runningboardd's "termination reported by launchd" for the helper after the app leaves the screen | Nothing: write down what it does |
| A real account's memory | The helper's memory lines | Nothing: write it down |

## Docs, in the same commits

- `docs/TELEGRAM_PLAN.md`: "The box: a helper extension" (an `XPCSession` no longer; why the extension point says it has an interface), and under "What has to be shown first", "How much memory iOS gives a helper" is answered: 35 MB, and 400 for one whose extension point has an interface, on which phone and when.
- `docs/SECURITY_DETAILS.md`, "In a box on the iPhone and iPad": the connection, and plainly that its extension point says it shows an interface, which it doesn't, for the memory. Claim nothing about its sandbox that a phone hasn't shown since the change: until `telegramProbe` has run on one, say what was measured before and that it's owed again.
- `CLAUDE.md`: the gotcha that begins "On the iPhone a linked Telegram account runs in `ZunaTelegram`", and the row for `Zuna/Shared/TelegramWire.swift` if its words no longer fit.
- `docs/IOS_TESTING.md`, where it describes the helper.
- `.agents/FEATURE_PARITY.md`, the iOS Telegram entry: what was built and what wasn't run on a phone.

No text a person sees changes, so no catalog does. If one does, `docs/TRANSLATING.md`.

## Not in this plan

Each is the person's call. Raise it in your report rather than building it.

- **App Review.** `UserInterface` is public and documented ("Specify `true` if your extension point supports custom UI"), and this says true while showing none, which guideline 2.5.1 ("Apps should use APIs and frameworks for their intended purposes") could be held against. Nothing is reviewed today: nightlies go to the team's own testers. Before the first App Store submission the choice is between giving the helper a small real view (its status in Connections, drawn by the helper), asking Apple, or the fallback below.
- **The fallback: TDLib in the app's process.** No limit and no XPC, and none of the isolation `docs/TELEGRAM_PLAN.md` asks for. Only if this way is blocked.
- **Closing TDLib before suspension,** so that iOS doesn't end the helper with `0xDEAD10CC` each time the app leaves the screen. Worth doing once the phone has shown what happens to this kind of extension.
- **`retryDelays` in the broker.** With room to start in, the waits no longer matter.
- **The app itself ended once over `core.lock`,** a separate task already proposed.

## Rules that bite here

- `CLAUDE.md` as for any change: pull first, `main` only, small commits with `ios:` or `docs:` subjects, pushed. Other sessions commit in this checkout: add only your own paths, never amend.
- **No nightly unless the person says so.** When the checks here have passed, ask.
- Nothing here touches a key or a credential. If that changes, say how it stays out of git before committing.
- Swift only builds on a Mac. Say in each commit what wasn't built or run, and on what.

## What to report

What was built and how each check went, with the log lines that show it. What a phone showed for each row of the table, or that no phone was used. Anything in this plan that turned out wrong.
