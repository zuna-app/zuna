# Roadmap

Zuna 1.0 is chat, with text channels everywhere, voice channels on the desktop, the web, the iPhone and the iPad, calls in direct messages and groups on all of them, desktop apps for Windows, Linux and macOS, and a native app for the iPhone and iPad. The design already allows for Android. This page describes what's left and how they fit.

## Phones

**iPhone and iPad: built, not yet released**

The app is native: SwiftUI, with the unchanged client core (`packages/core`) running in JavaScriptCore and the Rust crypto through UniFFI. It does everything the desktop does, and stays compatible with it. Notifications show the message, decrypted on the phone, and go where you are, as in Telegram. [IOS_PLAN.md](IOS_PLAN.md) has the design and the decisions behind it, and [IOS_TESTING.md](IOS_TESTING.md) how it's tested.

Before it reaches people:

- **App Store requirements:** deleting an account from the app, reporting someone to the server's admins, blocking people, on each device without the server, and agreeing to the [terms of use](https://zuna.chat/terms/) when creating an account are built.
- **Licensing:** distributing AGPL code through an app store needs an extra permission under section 7 of the AGPL, from everyone who holds copyright.
- **Notifications in production:** deploying the push relay with the app's APNs key ([PUSH_RELAY.md](PUSH_RELAY.md)), and Apple's notification filtering entitlement, so muted chats and messages read elsewhere are handled on the phone rather than by the server.
- **Testing on real devices,** from the TestFlight build each nightly that changes the app sends ([RELEASES.md](RELEASES.md)).

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
| Calls in direct messages and groups | Built everywhere, in the same rooms and with the same keys as voice channels, from that conversation's MLS group, ringing on the iPhone and iPad through CallKit, and waking a phone that isn't running through PushKit, or with an alert where CallKit is left out. Left: trying the ringing on an iPhone, which the simulator can't do. |
| Watching YouTube together | Not started. A video in a voice channel or a call, played in step on every device, each of which fetches it from YouTube itself, and only once its person presses Watch. [WATCH_TOGETHER_PLAN.md](WATCH_TOGETHER_PLAN.md) has the design and its phases. |
| Noise cancelling | RNNoise is cheap and needs no setup. DeepFilterNet cleans speech noticeably better, for more CPU and a far larger download, and would have to run off the audio thread. |

## Other ideas

- **Releasing the native app on macOS.** Releases carry the Windows installer and the Linux packages ([RELEASES.md](RELEASES.md)). The macOS app needs a Developer ID certificate and notarizing in the release workflow's secrets (`npm run dist:macos`).
- **Automatic updates** for the native app on macOS, as it has on Windows, checked against the same manifest, once it's released.
- **Code signing** for Windows, so the installer doesn't show a warning the first time it's downloaded. This needs a certificate held by whoever publishes releases, which `npm run dist:windows` takes in `CSC_LINK` and `CSC_KEY_PASSWORD`.
- **The server and `zuna-web` on releases.** The release workflow's jobs for the server's binaries, `zuna-web` and both images went on 2026-11-10, when it was rewritten around the native app, as none of them was ready to be released. They're in git history, to bring back when they are.
- **Admin-controlled permissions**, such as who may pin messages or create groups.
- **Sealing commits that change nobody,** so that renewing a group's keys names nobody either ([SEALED_SENDER.md](SEALED_SENDER.md), "Later").
- **A SOCKS5 proxy,** set on a device, which everything it sends goes through, calls included, so that the server and LiveKit see the proxy's address and not the device's. [SOCKS5_PLAN.md](SOCKS5_PLAN.md) is the plan, and nothing of it is built.
- **Key transparency:** a log of every change to who holds which keys, which each server keeps and every device reads, so that a server can't hand out a false key or hide a device without the account's owner seeing it. [KEY_TRANSPARENCY_PLAN.md](KEY_TRANSPARENCY_PLAN.md) is the plan, and nothing of it is built.
- **Starting a group again under a new suite,** which a second change of post-quantum algorithms would need, as a group keeps the MLS suite it was made with: stage 5 of the post-quantum work, which can come after 1.0.0 and has to come before anything forces a second change. [POST_QUANTUM.md](POST_QUANTUM.md), "Not done", says what it takes.
- **Hiding who's in a conversation** from the server, which delivers by membership today.
- **Encrypted backups** you can export and import yourself.
- **An independent security audit.**
- **Plugins for the native app:** packages that change how it looks and works, on the device alone, from a marketplace of ones the team has checked or, behind a warning, from a file. [PLUGINS_PLAN.md](PLUGINS_PLAN.md) is the plan, and nothing of it is built.
