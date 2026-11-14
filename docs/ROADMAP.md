# Roadmap

Zuna 1.0 is chat, with text channels everywhere, voice channels and calls on the desktop, the web, the iPhone and the iPad, desktop apps for Windows, Linux and macOS, and a native app for the iPhone and iPad. The design already allows for Android. This page describes what's left and how it fits.

## Phones

**iPhone and iPad: built, not yet released**

The app is native: SwiftUI, with the unchanged client core (`packages/core`) running in JavaScriptCore and the Rust crypto through UniFFI. It does everything the desktop does, and stays compatible with it. Notifications show the message, decrypted on the phone, and go where you are, as in Telegram. [IOS.md](IOS.md) has the design and the decisions behind it, and [IOS_TESTING.md](IOS_TESTING.md) how it's tested.

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

**Voice channels and calls are built, on the desktop, the web, the iPhone and the iPad,** through [LiveKit](https://livekit.io), an open-source media server that can be self-hosted, and so is watching YouTube together in both ([WATCH_TOGETHER.md](WATCH_TOGETHER.md)). A call is a conversation's own room, with the same keys as a voice channel's, from that conversation's MLS group, and rings on the iPhone and iPad through CallKit, waking a phone that isn't running through PushKit. [SELF_HOSTING.md](SELF_HOSTING.md#voice-channels) says how to run LiveKit, [ARCHITECTURE.md](ARCHITECTURE.md#channels-and-voice) how it works, and [SCREEN_SHARE.md](SCREEN_SHARE.md) how screens are shared.

**What's left**

| Part | Work |
|---|---|
| iPhone and iPad | A share's sound, which LiveKit's Swift SDK only mixes into the microphone ([SCREEN_SHARE.md](SCREEN_SHARE.md#from-an-iphone-or-ipad)). Answering a phone call during a call, with CallKit, which has otherwise been tried on an iPhone: the lock screen, the Dynamic Island, muting and ending from the system's controls, and a phone call declined during one. |
| Calls in direct messages and groups | Trying the ringing on an iPhone, which the simulator can't do. |
| Watching YouTube together | Keeping the video out of the microphone on Windows, as macOS and Linux do, taking it to full screen on macOS, bringing its window forward on Linux, and watching on an iPhone during a call. |
| Noise cancelling | RNNoise is cheap and needs no setup. DeepFilterNet cleans speech noticeably better, for more CPU and a far larger download, and would have to run off the audio thread. |

## Other ideas

- **Automatic updates** for the native app on macOS, as it has on Windows, checked against the same manifest.
- **Code signing** for Windows, so the installer doesn't show a warning the first time it's downloaded. This needs a certificate held by whoever publishes releases, which `npm run dist:windows` takes in `CSC_LINK` and `CSC_KEY_PASSWORD`.
- **The server and `zuna-web` on releases.** The release workflow's jobs for the server's binaries, `zuna-web` and both images went on 2026-11-10, when it was rewritten around the native app, as none of them was ready to be released. They're in git history, to bring back when they are.
- **Admin-controlled permissions**, such as who may pin messages or create groups.
- **Sealing commits that change nobody,** so that renewing a group's keys names nobody either ([SEALED_SENDER.md](SEALED_SENDER.md), "Later").
- **Telegram on the iPhone:** someone's own Telegram account linked on a device, with its direct messages and groups under an icon of their own beside the servers, through Telegram's own client library in a process boxed in apart from everything of Zuna's, and on an iPhone pushed by Telegram through Apple. No Zuna server takes part. The desktop app has it on Windows, Linux and macOS ([TELEGRAM.md](TELEGRAM.md)), and releases carry it once the repository has the app's `api_id`. Left: the iPhone's helper extension and pushes, and `telegram-check.mjs`. [TELEGRAM_PLAN.md](TELEGRAM_PLAN.md) is the plan.
- **Starting a group again under a new suite,** which a second change of post-quantum algorithms would need, as a group keeps the MLS suite it was made with: stage 5 of the post-quantum work, which can come after 1.0.0 and has to come before anything forces a second change. [POST_QUANTUM.md](POST_QUANTUM.md), "Not done", says what it takes.
- **Hiding who's in a conversation** from the server, which delivers by membership today.
- **Encrypted backups** you can export and import yourself.
- **An independent security audit.**

Built since this page first listed them: a SOCKS5 proxy for everything a device sends ([SOCKS5.md](SOCKS5.md)), the log of who holds which keys ([KEY_TRANSPARENCY.md](KEY_TRANSPARENCY.md)), plugins for the native app ([PLUGINS.md](PLUGINS.md)), watching YouTube together, and the macOS app on releases.
