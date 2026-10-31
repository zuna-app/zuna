# Roadmap

Zuna 0.1 is desktop-only text chat. The design already allows for mobile apps and calls. This page describes how they fit.

## Mobile apps

**What's reusable today**

- `packages/core` is all protocol logic with no UI or Electron dependency. It already runs headless in Node for tests.
- The server needs no changes to serve another kind of client.
- Multi-device support already exists, so a phone is simply another device. It signs in with the password, joins each group with an external commit, and downloads history.

**The plan: React Native**

| Concern | Approach |
|---|---|
| UI | New React Native screens. The DOM components can't be shared, but state and logic can. |
| Crypto | Start with the existing WebAssembly build. Move to native OpenMLS through UniFFI if performance requires it; `crypto/src/mls.rs` is already separate from the WASM bindings for this reason. |
| Storage | Implement the `LocalDb` interface in `packages/core/src/db.ts` with `op-sqlite`. |
| Keychain | iOS Keychain and Android Keystore supply the device key. |

**Push notifications are the one new server feature.** Phones can't hold a socket open, so a server needs a way to wake them:

1. The app registers a push token, through UnifiedPush, or through APNs and FCM.
2. On a new message, the server sends a push holding only the group ID and message ID, sealed with a key the device gave it, never content.
3. The phone wakes, fetches the message, decrypts it, and shows a local notification.

Apple and Google require credentials tied to a published app, so self-hosted servers use a small relay run by the project (`zuna-push`), which sees only sealed handles, sealed payloads and timing. Android can also use UnifiedPush. The iOS side is planned in [IOS_PLAN.md](IOS_PLAN.md#notifications-decided-2026-10-31).

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
