# Roadmap

Zuna 1.0 is chat, with text channels everywhere, voice channels on the desktop, the web, the iPhone and the iPad, calls in direct messages and groups on all of them, desktop apps for Windows, Linux and macOS, and a native app for the iPhone and iPad. The design already allows for Android. This page describes what's left and how they fit.

## Phones

**iPhone and iPad: built, not yet released**

The app is native: SwiftUI, with the unchanged client core (`packages/core`) running in JavaScriptCore and the Rust crypto through UniFFI. It does everything the desktop does, and stays compatible with it. Notifications show the message, decrypted on the phone, and go where you are, as in Telegram. [IOS_PLAN.md](IOS_PLAN.md) has the design and the decisions behind it, and [IOS_TESTING.md](IOS_TESTING.md) how it's tested.

Before it reaches people:

- **App Store requirements that need server features:** deleting an account from the app, and reporting content. Blocking people is built, on each device without the server.
- **Licensing:** distributing AGPL code through an app store needs an extra permission under section 7 of the AGPL, from everyone who holds copyright.
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

**Push notifications are built.** A server pushes only the group and message IDs, sealed with a key the device gave it, through `zuna-push`, a small relay the project runs, since Apple and Google tie push credentials to a published app. The relay sees only sealed handles, sealed payloads and timing, and the phone fetches and decrypts the message itself. As in Telegram, a phone in use isn't pushed, one whose person is on another device is pushed 30 s later if they didn't read the message there, and silent pushes clear what was read or deleted elsewhere.

## Voice, video and screen sharing

**Voice channels are built, on the desktop, the web, the iPhone and the iPad,** through [LiveKit](https://livekit.io), an open-source media server that can be self-hosted. [SELF_HOSTING.md](SELF_HOSTING.md#voice-channels) says how to run it, [ARCHITECTURE.md](ARCHITECTURE.md#channels-and-voice) how it works, and [SCREEN_SHARE.md](SCREEN_SHARE.md) how screens are shared.

**What's left**

| Part | Work |
|---|---|
| iPhone and iPad | A share's sound, which LiveKit's Swift SDK only mixes into the microphone ([SCREEN_SHARE.md](SCREEN_SHARE.md#from-an-iphone-or-ipad)). Answering a phone call during a call, with CallKit, which has otherwise been tried on an iPhone: the lock screen, the Dynamic Island, muting and ending from the system's controls, and a phone call declined during one. |
| Calls in direct messages and groups | Built everywhere, in the same rooms and with the same keys as voice channels, from that conversation's MLS group, ringing on the iPhone and iPad through CallKit. Left: waking a phone that isn't running for a call, through PushKit, or an alert where CallKit is left out. |
| Noise cancelling | RNNoise is cheap and needs no setup. DeepFilterNet cleans speech noticeably better, for more CPU and a far larger download, and would have to run off the audio thread. |

## Other ideas

- **Automatic updates** with `electron-updater`, which needs a signed release pipeline first.
- **Code signing** for Windows and macOS, so installers don't show warnings. This needs certificates held by whoever publishes releases. `release.yml` already accepts them.
- **Postgres** for servers larger than a few hundred active people. All SQL lives in `server/internal/store`, so this is a contained change.
- **Admin-controlled permissions**, such as who may pin messages or create groups.
- **Sealed sender**, to hide from the server who sent a message.
- **Encrypted backups** you can export and import yourself.
- **An independent security audit.**
