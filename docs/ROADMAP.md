# Roadmap

Zuna 1.0 is text chat, with desktop apps for Windows, Linux and macOS and a native app for the iPhone and iPad. The design already allows for Android and calls. This page describes what's left and how they fit.

## Phones

**iPhone and iPad: built, not yet released**

The app is native: SwiftUI, with the unchanged client core (`packages/core`) running in JavaScriptCore and the Rust crypto through UniFFI. It does everything the desktop does, and stays compatible with it. Notifications show the message, decrypted on the phone, and go where you are, as in Telegram. [IOS_PLAN.md](IOS_PLAN.md) has the design and the decisions behind it, and [IOS_TESTING.md](IOS_TESTING.md) how it's tested.

Before it reaches people:

- **App Store requirements that need server features:** deleting an account from the app, and reporting content and blocking people.
- **Licensing:** distributing GPL code through an app store needs an extra permission under section 7 of the GPL, from everyone who holds copyright.
- **Notifications in production:** deploying the push relay with the app's APNs key ([PUSH_RELAY.md](PUSH_RELAY.md)), and Apple's notification filtering entitlement, so muted chats and messages read elsewhere are handled on the phone rather than by the server.
- **Signing and TestFlight,** and testing on real devices.

**Android: the plan**

The iPhone app's approach carries over:

| Concern | Approach |
|---|---|
| UI | Native screens in Kotlin with Jetpack Compose. |
| Client core | The same `packages/core` bundle, in an embedded JavaScript engine such as QuickJS or Hermes, with the bridges the iOS host has: storage, crypto, network and files. |
| Crypto | The Rust crate through UniFFI, which generates Kotlin bindings as it does Swift ones. |
| Storage | SQLite in the app's private storage, behind the core's `LocalDb` interface. |
| Keychain | Android Keystore protects the device key. |
| Notifications | The push relay gains Firebase Cloud Messaging next to APNs; servers can also push through UnifiedPush directly, for phones without Google services. |

**Push notifications are built.** A server pushes only the group and message IDs, sealed with a key the device gave it, through `zuna-push`, a small relay the project runs, since Apple and Google tie push credentials to a published app. The relay sees only sealed handles, sealed payloads and timing, and the phone fetches and decrypts the message itself. Nobody is pushed while they use one of their devices, and silent pushes clear what was read or deleted elsewhere.

## Voice, video and screen sharing

**The plan: LiveKit, encrypted end to end**

[LiveKit](https://livekit.io) is an open-source media server that can be self-hosted. Electron's Chromium includes full WebRTC and the Insertable Streams API that LiveKit's end-to-end encryption uses, which is one reason Zuna chose Electron.

**Keys come from MLS.** A call's media key is exported from the conversation's MLS group:

```
call key = MLS-Exporter("zuna/call/v1", call_id, 32)
```

Membership changes rotate the MLS epoch, which rotates the call key. A removed member loses access to the call too, with no separate key system. Discord's DAVE protocol uses the same approach.

**What needs building**

| Part | Work |
|---|---|
| Server | Optional `ZUNA_LIVEKIT_URL`, key and secret settings, plus an endpoint that issues a short-lived room token to members of a group. Servers without LiveKit work as they do today. |
| Client core | Export call keys and rotate them on new epochs. |
| Desktop | LiveKit's client SDK with its E2EE key provider, a call screen, and microphone and camera permissions. The macOS entitlements are already in place. |
| iPhone and iPad | LiveKit's Swift SDK with its E2EE key provider, a Calls tab, which the tab bar leaves room for, and CallKit, so calls ring like phone calls. |
| Signaling | "Call started" and "call ended" as encrypted events in the conversation, so the server doesn't learn more than the LiveKit token request reveals. |
| Self-hosting | A compose file with LiveKit as an optional second service. |

LiveKit would see who is in a call and when, but not the media.

## Other ideas

- **Automatic updates** with `electron-updater`, which needs a signed release pipeline first.
- **Code signing** for Windows and macOS, so installers don't show warnings. This needs certificates held by whoever publishes releases. `release.yml` already accepts them.
- **Postgres** for servers larger than a few hundred active people. All SQL lives in `server/internal/store`, so this is a contained change.
- **Admin-controlled permissions**, such as who may pin messages or create groups.
- **Sealed sender**, to hide from the server who sent a message.
- **Encrypted backups** you can export and import yourself.
- **An independent security audit.**
