# iPhone: Telegram's engine in the app, and the helper gone

A plan for an agent to carry out, written on 2026-11-15. It's for agents, like `FEATURE_PARITY.md`, so don't link to it from anything written for people. **Remove this file in the commit that finishes it.**

Nothing here is built. It takes the place of a plan to keep the helper and give it more memory, which the person who owns the app read and turned down the same day (see "What was turned down").

## Why

A linked Telegram account on the iPhone hangs on "Connecting" each time the app comes back, for seconds or minutes. Measured on an iPhone 17 Pro Max, iOS 27.0.1, TestFlight build 1559, from its log:

- **iOS ends the helper for memory.** `ZunaTelegram` gets `set Memory Limits to Hard ExternalExtension_NonUI (35)`, and the kernel logs `exceeded mem limit: ActiveHard 35 MB (fatal)`. In four hours 24 of 29 starts ended that way, most within 250 ms. One return to the app took 13 starts and two minutes.
- **TDLib alone nearly fills that:** 20 to 24 MB in the simulator on a test account with one chat (`footprint <pid>`).
- **Apple says the limit can't be raised** (developer.apple.com/forums/thread/852862).
- **iOS also ends the helper at every suspension,** `0xDEAD10CC`, for the locks TDLib holds on `td.binlog` and `db.sqlite`: an extension has no folder where a lock may be held while it's suspended. So every return was a cold start into that limit.

## What this gives up, said plainly

`docs/TELEGRAM_PLAN.md` forbids running TDLib beside Zuna's keys, and built the helper to obey that. This plan makes the iPhone and iPad the exception, by the person's decision on 2026-11-15, knowing these:

- A fault in TDLib, a large C++ parser of strangers' data, is then a fault in the process that holds the device key, the MLS state, decrypted messages and every server's session.
- The door stops being a wall. It still carries every connection an honest TDLib makes, to Telegram's ranges alone and through the device's proxy, but code that has taken the process over can open a socket of its own.
- Pointer authentication, the hardened heap and memory tagging were the helper's, as an enhanced security extension. The app isn't built that way. TDLib keeps what its own compilation gives it.
- TDLib ends its process on purpose when its own checks fail. That process is now Zuna.

The docs must say all of this as plainly (see "Docs"). Don't soften it, and don't claim a protection that's gone.

## What was turned down

Keeping the helper and declaring its extension point with `UserInterface()`. A throwaway app on that phone showed such an extension gets `ExternalExtension_UI (400)`, 400 MB, and is reached over `NSXPCConnection` with no view shown. It was turned down because it says the extension shows an interface when it shows none, which App Review's guideline 2.5.1 could be held against, and because the number is nothing Apple documents. Don't build it. Keep the two sentences in `docs/TELEGRAM_PLAN.md`, so the next reader knows it was tried.

## What's known for the app's process

- **The app may hold locks in its own container while suspended.** Read from one log line, not tried: when iOS ended the app once for a lock on `core.lock` in the app group, it listed the app's own data container and its `tmp` as the folders locks are allowed in. So TDLib's folder goes in the app's own container, never the app group. A phone has to show the app isn't ended for it ("On a phone").
- **iOS takes back a suspended process's sockets** (TN2277), the door's listener among them. The door already listens again when that happens (`listenAgain`), and that stays.
- **Nothing links OpenSSL's names twice.** `libzuna_crypto.a` exports none of them, TDLib's SQLite is prefixed (`tdsqlite3_`), and LiveKit's WebRTC is a framework of its own. The link will say if that's wrong.
- **Nothing needs iOS 26 any more.** Only the extension point did. TDLib is built for iOS 26 today (`IOS_TELEGRAM_MINIMUM`), and has to be built for the app's own deployment target to be linked into it.
- **The app's limit** on that phone is 3376 MB.

## The shape afterwards

The core's contract doesn't change: `telegramAvailable`, `telegramStart`, `telegramSend`, `telegramStop`, `telegramFile`, `__zunaTelegram` and `__zunaTelegramFile` (`apps/ios/core-bundle/src/natives.d.ts`), the events `zunaStopped`, `zunaFailed` and `zunaRestarted`, and `functions.json`. Nothing in `packages/core` should need to change. If you find it does, stop and say why.

| Now | Afterwards |
|---|---|
| `apps/ios/ZunaTelegram/` (a target: `TelegramHelper.swift`, `Door.swift`, `Engine.swift`, `Probe.swift`, `TDLib.h`, `Info.plist`, `ZunaTelegram.entitlements`) | Gone, all of it. What's worth keeping moves, below |
| `apps/ios/Zuna/Shared/TelegramWire.swift` | Gone |
| `apps/ios/Zuna/Telegram/TelegramHelper.swift` (the extension point, `XPCLauncher`, `XPCLink`) | A small file that gives the core its `TelegramBridge.Configuration` in a build with TDLib, and the engine over TDLib's JSON client |
| `ZunaHost/TelegramBridge.swift`: the broker, with runs of a helper, a launcher's retries, a watchdog, copies of files, and the app's half of the door | The broker alone, over an engine it's handed. No runs of a process, no retries, no watchdog, no copies |
| The door in two halves joined by JSON and XPC frames | One door in `ZunaHost`, with the same rules |
| `apps/ios/telegram.yml`: a second target, signed with entitlements and a profile of its own | A few build settings on `Zuna`, and nothing to sign |

Nothing is called a helper afterwards. When you think you're done, `grep -rni "helper" apps/ios docs scripts .github CLAUDE.md .agents packages/core/src/telegram` should turn up nothing about Telegram on the iPhone.

### The engine

- **A seam, so `ZunaHost` still builds and tests on a Mac without TDLib.** `ZunaHost` declares what it needs of an engine: make a client, send it JSON, hear what it says, hear that it closed, run a synchronous request. The app's target gives the one over `td_json_client` (today's `Engine.swift`, nearly as it is), and the tests give a fake, as they fake the launcher now.
- **TDLib's four functions reach Swift through a small module of their own,** a folder with a `module.modulemap` and the header (today's `TDLib.h`), on `SWIFT_INCLUDE_PATHS`, rather than a bridging header on the whole app. If that fights XcodeGen, a bridging header is fine: say which you took.
- **A build without the api_id has no TDLib and still builds.** `telegram.yml` sets a compilation condition on `Zuna` (`ZUNA_TELEGRAM`), the library path and the linker flags the helper had. Code that names TDLib sits behind the condition. `TelegramHelper.configuration()` loses its two checks, for iOS 26 and for `Extensions/ZunaTelegram.appex`, to that condition. Check that Debug builds still define `DEBUG` once the condition is added: the control channel is the proof.
- **One client at a time.** A new one is made only after the one before said it closed: two on one folder fight over the binlog's lock.

### The door, in one piece

Today's helper half (`ZunaTelegram/Door.swift`: a SOCKS5 listener on loopback, which TDLib is told to use) and today's app half (`TelegramDoor` in `TelegramBridge.swift`: `NWConnection` to Telegram) become one type in `ZunaHost`, in a file of its own, calling each other directly. `open`, `opened`, `refused`, `closed` and the data frames go. Every rule stays, and each is worth a test:

- Only an address, never a name. Only Telegram's ranges (`rangesV4`, `rangesV6`) and ports. A mapped IPv4 address is judged as itself.
- Through `NetworkProxy.current` when one is set, and nowhere when it can't be reached.
- A username and password made for the run, compared in time that doesn't depend on where they differ.
- Neither end holds more than one part the other hasn't taken.
- The listener is made again when iOS takes it back, on the same port if it can, and TDLib is told when the port had to move.
- The connect deadline, and a connection that's `waiting` refused at once.

The CLAUDE.md row for Telegram's published ranges names where they live: keep it true.

### The broker, without a process

Goes: `Run`'s launch and link, `TelegramHelperLauncher`, `TelegramHelperHandlers`, `TelegramHelperLink`, `retryDelays`, `mostRestarts`, `ranWell`, the watchdog and its three settings, `eraseAll`'s helper started only to erase, `probe`, `copies`, `filesDirectory`, `copy`, and in the helper the second list of refused requests (`refused`), `strangersContainer`, and the session's `accept`.

Stays, with the same meaning: the database key sealed with the device key (`databaseKey`, `KeyProblem`); the list and the rate limit in `send`; `start(linked:)`, with the door given to TDLib (`addProxy`) before `setTdlibParameters`, and what TDLib is told this device is; the push token (`registerDevice`); `stop(signOut:)` with its deadlines and `zunaStopped`; `networkChanged`; `reclaim` for the checks; and nothing started while the app is out of sight.

Worked out here, each a decision to carry out or argue with:

- **Parameters TDLib refuses.** Close the client and wait for it. Erase only what today's rule erases: a database no key here opens, with no account linked. Then tell the core with `zunaFailed`, without `retrying`. There's no folder to come back, so nothing is tried again by itself, except once after that erase.
- **A linked account with no database** isn't started, as now (`cantStart`'s second case), so that TDLib doesn't make an empty one and the account read as let go. Its text changes, as there's no folder iOS handed over.
- **TDLib must not be able to take the app away for good.** A database TDLib ends the process over would end Zuna at every start, with no way to reach Settings and unlink. So a start leaves a mark before `setTdlibParameters` and takes it back once TDLib has opened its database and said where the account stands. After two starts in a row that left their mark, the next isn't made: `zunaFailed`, without `retrying`, saying why, and Unlink, which erases everything, is the way out. The mark must hold across launches until the person acts: `nudge` isn't that, as the app calls it by itself whenever it comes back. `td_set_log_message_callback` gives TDLib's last words before it ends the process, which is the reason worth keeping in the mark. This part is new and has no code to copy, so take care over it and test it.
- **Coming back.** The process is suspended and resumed now, where it used to be ended and started. On `wake`, the door looks at its listener at once, not at its next look five seconds on, and the broker sends `setNetworkType`, which TDLib's own documentation says must be called whenever the network changes "even if the network type remains the same", as it reopens every connection. That is what makes the account online a second after the app is back. It's the broker's own request, like `registerDevice`, so it isn't on the core's list.
- **Out of sight.** Nothing is told to TDLib as the app leaves: iOS suspends it. While the app itself runs out of sight, as in a call, TDLib runs too, which is new and harmless.
- **`zunaRestarted`** has no sender left on the iPhone. The core keeps it for the desktop.

### The folder and its files

- `Library/Application Support/telegram` in the app's own container, with `db` and `files`, made by the broker: not in the app group, where the notification and share extensions read and where a held lock gets the app ended. Left out of backups and protected until first unlock, as `SharedStorage` treats the app's own data.
- **`telegramFile` answers with TDLib's own path,** after the same check `opened` made in the helper: inside the folder once every link is followed, and a regular file. If something in the interface needs a file to outlive TDLib's keeping of it, say so in your report rather than bring the copies back quietly.
- Unlinking erases the folder directly, once the client has closed.

## Everything else that goes

- **`apps/ios/telegram.yml`:** the `ZunaTelegram` target, its entitlements and Info.plist, `EX_ENABLE_EXTENSION_POINT_GENERATION`, `ENABLE_ENHANCED_SECURITY`. Rewrite its comments and the one at the top of `project.yml`.
- **`apps/ios/project.yml`:** `LSMinimumSystemVersion: "26.5"` and its comment were there for the helper's arm64e slice (ITMS-91305). Remove them, and say in your report to watch the first upload's warnings.
- **`scripts/tdlib.mjs`:** `IOS_SLICES` loses arm64e. `IOS_TELEGRAM_MINIMUM` becomes the app's deployment target, 18.0, kept in step with `project.yml`. `HARDENING_C` and `HARDENING_CXX` stay if TDLib links and runs with them in the app, with comments that no longer call them an enhanced security extension's. Bump `IOS_RECIPE`. Fix every comment that says helper. The first build after is about a quarter of an hour, and `tdlib.yml` saves it on main by itself when this file changes.
- **`scripts/ios-dist.mjs`:** `TELEGRAM_PROFILE`, `profilesFor`'s special case, the block that uploads without the helper, the tenth secret in `secrets`, and `Extensions` in `bundlesOf`.
- **`.github/workflows/release.yml`:** `IOS_PROFILE_TELEGRAM` wherever the upload is given it. **`ci.yml`:** its comments about the helper.
- **`Zuna/CoreController.swift` and `ZunaHost/CoreRuntime.swift`:** `telegramProbe` and `probeTelegram`, and every comment about a helper. `setTelegramOutOfSight` and `telegramReclaim` stay.
- **The iOS 26 gates on Telegram:** `@available(iOS 26.0, *)` and `#available` in `Zuna/Telegram`, and the comments in `AppModel.swift`, `CoreAPI.swift` and `CoreRuntime.swift` that say "from iOS 26". Telegram is then offered from iOS 18. It was only ever run on 26 and 27, and no older simulator is on this Mac, so every doc that widens the claim says that too.
- **Texts.** Anything a person can see that moves into the app's target is named by key (`t("…")`) and translated in every catalog in the same commit. `npm run i18n` then drops the keys nothing looks up any more, and `npm run test:i18n` holds the rest. The desktop shares the catalogs, so let the script decide what's unused, not your eye.

## Outside the repository

Not yours to do. List them in your report for the person:

- On Apple's developer site: the App ID `chat.zuna.mobile.telegram` and its profiles, once a build without it is out, and the two a probe left on 2026-11-15, `chat.zuna.memprobe` and `chat.zuna.memprobe.ui`.
- In the `testflight` environment on GitHub: the secret `IOS_PROFILE_TELEGRAM`.
- In Telegram, under Devices: the session the helper's database held, which stays listed until it's ended there.

## People who already linked

The account's database is in the helper's container, which the app can't read, and nothing is carried over: there's no stable release, and `CLAUDE.md` asks for no moves of saved data. After the update the app still holds the sealed key and the core still says linked, so the account isn't started, and says why. Unlink, then link again. Make sure that path works from that exact state, and that the text tells the person what to do. Say it in your report, as it belongs in the nightly's notes.

## Tests

`apps/ios/ZunaKit/Tests/ZunaHostTests/TelegramBridgeTests.swift` fakes a launcher and its links. Those about the list, the door's addresses, the key, the credentials and a file's extension stay. Those about a helper that fails, sleeps, wakes or stops answering go with what they tested. In their place, on a fake engine:

- The door is given before the parameters, and the parameters say what they did.
- A start with the app out of sight waits, and is made as it's back.
- Parameters refused: the client closed, nothing erased for a linked account, erased for an unlinked one with a key that doesn't open it, the core told once.
- A linked account with no database isn't started.
- Stop, sign out and erase, each with `zunaStopped`, and no second client before the first closed.
- The mark: two starts that left one, and the third isn't made; a start that got as far as its database takes it back; Unlink clears it.
- `wake` sends `setNetworkType` and has the door look.
- The door, on loopback with a SOCKS5 client of the test's own: a name refused, an address outside Telegram's refused, a wrong password refused, no method but the password one taken.

## Checks

1. `swift test` in `apps/ios/ZunaKit`.
2. `npm run test:ios:check`: types, the app built with warnings as errors, the host's units.
3. `npm run test:ios:release`, which builds Release without the api_id, so without TDLib, and `node scripts/ios-dist.mjs archive` after `npm run build:ios`, which is the Release build that links TDLib, for phones. Both look through the app's binary for strings only test code has (`forbidden` in `scripts/check-ios-release.mjs`), and TDLib's strings are in that binary now: none of those words is in TDLib's libraries (looked on 2026-11-15), but a later TDLib could hold one.
4. `ZUNA_TELEGRAM=0`, the app builds with no Telegram and no TDLib.
5. `npm run i18n` leaves nothing changed, and `npm run test:i18n`.
6. **The simulator "iPhone 17 Pro (iOS 26)"** holds a linked Telegram test account in Zuna Debug, in the helper's container. After this change it's in the state every tester will be in, so use it to check exactly that: the account says why it isn't started, and Unlink works. Linking again needs the person to scan a code or type one: **ask them**, and until they have, say the rest of this list wasn't run. The memory notes on iPhone Telegram testing say how to build with the api_id for the simulator, never on a command line, and how to drive the app. With an account linked again:
   - It comes online and its list shows, with pictures: a picture is a file read in place through `telegramFile`.
   - `telegramReclaim` on the control channel: online again within a couple of seconds (`docs/IOS_TESTING.md`).
   - Leave the app (`simctl launch <sim> com.apple.mobilesafari`), wait a minute, come back: online at once, and the same TDLib client as before.
   - Send a message and a file to Saved Messages. Unlink: the folder and the key are gone.
   - The mark, by ending the app (`simctl terminate`) between the mark and the database twice, if you can time it, or by a launch argument for the checks.
   - No `ZunaTelegram.appex` and no `Extensions` folder in the app, and `lipo -archs` on its binary says arm64.

## On a phone

The simulator ends nothing for a held lock and gives no limits. **Installing a Debug build on the person's phone replaces their TestFlight Zuna: ask first, every time.** If they'd rather not, the first nightly is the test, read from the phone's log afterwards (the memory note on the phone's log archive has the commands and the kill codes).

| What isn't known | How it's read | If it goes wrong |
|---|---|---|
| The app isn't ended at suspension for TDLib's locks | runningboardd for `app<chat.zuna.mobile>` after it leaves the screen: "suspended with locked system files", and whether "termination reported by launchd (15, 3735883980, 9)" follows | Close TDLib as the app leaves the screen and start it as it returns. Report it before building that |
| Back from a suspension, the account is online at once | By eye, and the time between the app's "Resuming task" and the door's first connection in the log | Report what the log shows |
| The app's memory with a real account | `xctrace`'s Activity Monitor recording of `Zuna`, as the memory note says | Nothing: write the number down |
| The first upload | App Store Connect's warnings for the build, with `LSMinimumSystemVersion` gone | Report them |

## Docs, in the same commit as what they describe

- **`docs/TELEGRAM_PLAN.md`:** the rule against running TDLib beside Zuna's keys gets its exception, by name and date, with the measurements above and what was turned down. "On the iPhone and iPad" is written again for what's there. "What has to be shown first" answers "How much memory iOS gives a helper". "Where it stands" and "Risks" follow.
- **`docs/SECURITY_DETAILS.md`:** "In a box on the iPhone and iPad" becomes what's true: no box there, why, what a fault in TDLib then reaches, and what's left (the list, the limit, the door for what TDLib is told to do, the sealed database key, files by bytes). Its list of limits gets this one.
- **`SECURITY.md`:** one plain sentence beside its line on Telegram. It says briefly what the details say in full.
- **`docs/TELEGRAM.md`:** "from iOS 26", and the iPhone's sentences in "How it's kept apart".
- **`docs/IOS_TESTING.md`:** `telegramProbe` and the paragraph on what a phone's probe should find.
- **`docs/RELEASES.md`:** the `ios` job's paragraph, the `IOS_PROFILE_TELEGRAM` row, the profile in the list of five, "the Telegram helper's tenth".
- **`CLAUDE.md`:** the gotcha that begins "On the iPhone a linked Telegram account runs in `ZunaTelegram`", the command row for TDLib "for the iPhone's Telegram helper", the row for `Zuna/Shared/TelegramWire.swift` (gone), the rows that name where the door's ranges and the broker live, and the quick reference's Telegram row.
- **`.agents/FEATURE_PARITY.md`:** the iOS Telegram entry. The box the desktop has and the iPhone can't goes under "Not possible or pointless there", with the 35 MB as the reason.
- **`apps/site`:** it claims no box and no iOS version for Telegram today (checked 2026-11-15). Look again before you finish.

## Commits

One change that can't be half made: with the helper gone and no engine in the app, or TDLib built without arm64e while the helper still wants it, a nightly cut in between would ship no Telegram or fail to build. So the switch, its scripts, tests and docs go in one commit, `ios:`, with a body that says what wasn't run and on what. Anything that stands alone, a comment in a workflow, may go separately. Pull before, add only your own paths, never amend: other sessions commit in this checkout.

## Ask first

- Installing anything on the person's phone.
- Cutting a nightly. When the checks have passed, ask.
- Anything that would change `packages/core`, another platform, or a line of `CLAUDE.md`'s "Decisions to keep".
- Closing TDLib on every trip to the background, if a phone shows it's needed.

Nothing here touches a key or a credential in a new way: the database key is sealed as it was, and the api_id comes from the environment as it did. If that changes, say how it stays out of git before committing.

## What to report

What was built, and how each check went, with the log lines and screenshots that show it. What couldn't be run, and why. The three things outside the repository. What testers have to do after the update. Anything in this plan that turned out wrong.
