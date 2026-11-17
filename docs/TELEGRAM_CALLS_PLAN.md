# Telegram calls in Zuna: plan

Someone with a linked Telegram account ([TELEGRAM_PLAN.md](TELEGRAM_PLAN.md)) calls a person on Telegram from Zuna, by voice or with the camera, and is called, while the other side uses any of Telegram's own apps and sees nothing different. One to one only. On every platform that has the linked account: the native desktop app on Windows, Linux and macOS, and the iPhone and iPad app. This page is what was found on 2026-11-16, what was decided, the design, and the order to build it in. Steps 2 to 6 are built for the desktop app, on 2026-11-16, as "Where it stands" says; nothing of it has been run against Telegram.

```
the interface: the call's screen, ringing, the microphone, camera and speakers
   │  call("telegram", "startCall" / "answerCall" / "endCall" …)  ·  CoreEvent
the core: packages/core/src/telegram/calls
   │  the call's state, and Telegram's signalling for it: its four messages, their
   │  sealing under the call's key, and descriptions for a peer connection, both ways
   ├── JSON ─▶ the broker ─▶ zuna-telegram (TDLib, in its box): the call at Telegram,
   │                         the key agreed with the other side, signalling carried
   └── descriptions and candidates ⇄ the interface's peer connection
the media: one peer connection of the WebRTC library the app already has for LiveKit
   └── UDP to Telegram's TURN servers alone, through the device's proxy when one is set
```

TDLib does everything a call needs of Telegram's servers and none of its sound or picture. In Telegram's own apps that part is tgcalls, a C++ library on Telegram's own build of WebRTC. Zuna doesn't take it in: the same protocol is spoken by Telegram's two web apps on a browser's plain WebRTC, and Zuna does as they do, on the WebRTC it has.

## Decisions

Asked for on 2026-11-16:

- **One-to-one calls, by voice and with the camera, both ways.** Sharing a screen from Zuna, video chats in groups and Telegram's conference calls are left for later, each a step of its own.
- **A call's sound and picture run in the app,** on every platform, through the WebRTC library Zuna's own calls use, with code of Zuna's own for Telegram's signalling. None of Telegram's code is added to the app. It's an exception to the third rule of "What safe means" in the first plan: what the other person's app sends in a call is parsed in the app's own process, once the person has started or answered that call. "Where the media runs" says what was weighed.
- **Always through Telegram's relays, never from device to device.** The other person never learns this device's address, whatever the account's own setting for that is in Telegram.
- **Only to Telegram's published addresses,** as the engine's door. A relay Telegram names by a host name, or at an address outside its ranges, is refused, and a call left with none says so and ends.
- **An iPhone rings with Zuna closed, from the first version,** through Telegram's VoIP pushes, with a switch for someone who also has Telegram's own app on the phone.

What this plan assumes until the owner says otherwise. Each is a question at the end.

1. **One version of the protocol, 13.0.0,** which is the one every current app of Telegram's has.
2. **The signalling is written once, in the core,** for the desktop and the iPhone alike.
3. **It's written from what the protocol puts on the wire, not ported** from tgcalls or the web apps, whose licences would come with their code.
4. **Telegram's VoIP pushes are asked for encrypted,** so Apple reads nothing, and a call that wakes the phone is called "Telegram" until the engine has caught up and knows who it is.
5. **The switch is Telegram's own setting for the device,** "Accept calls", on every platform: off, this device takes no Telegram calls at all, and still makes them.
6. **The app asks how the call was when Telegram says to,** as its page on calls asks of a client, and sends Telegram no logs.
7. **A proxy that carries no UDP gets no Telegram call,** unless Telegram's relays turn out to take TCP.

## What was found

Read in source on 2026-11-16, at the revisions under "What was read". None of it was run against Telegram.

### What TDLib does, and what it leaves

The pinned TDLib (1.8.70) has the whole of a call's dealings with Telegram: `createCall`, `acceptCall`, `discardCall`, `sendCallSignalingData`, and the updates `updateCall` and `updateNewCallSignalingData`. It rings the other side, tells the caller the call was received by itself (`callStatePending.is_received`), agrees the call's key with the other app, and at `callStateReady` hands over that key (256 bytes), four emoji made from it, the versions of the protocol the other app has, the servers for the call, and Telegram's parameters for it (`custom_parameters`). From there on the two apps talk to each other, in whatever they put through `sendCallSignalingData`, and the media is theirs to carry.

### The protocol between the apps

It goes by a version, which each side lists in `callProtocol.library_versions` and Telegram's server settles: both apps use the first in the list it gives back.

| Telegram's app | Versions it has |
|---|---|
| Desktop, Android, iPhone, macOS | 2.7.7, 5.0.0, 7.0.0 to 9.0.0, 10.0.0, 11.0.0, 12.0.0, 13.0.0, and on some 14.0.0, 18.0.0, 19.0.0 |
| Web K and Web A | 13.0.0 alone |

- **13.0.0 is the one they all have,** and what both web apps get every call with. 4.0.0, which Web K spoke until May 2026, is gone from every app.
- **On the wire it's what any WebRTC speaks:** ICE, DTLS-SRTP, and a data channel over SCTP. What's Telegram's own is the signalling.
- **Four messages, in JSON:** `InitialSetup` (the ICE name and password and the DTLS fingerprints), `NegotiateChannels` (the streams one side sends: each a kind, an SSRC, its codecs and header extensions), `Candidates`, and `MediaState` (muted, the camera's and a shared screen's state, a low battery). No SDP is ever sent: each side makes its own from the messages.
- **Sealed under the call's key.** Each message is gzipped, numbered, and encrypted with AES-256 in counter mode under a key and counter made from the call's key and a hash of the message, as MTProto 2 makes them, with the caller and the answerer taking different parts of the key. The receiver checks the hash, and keeps the last 64 numbers it saw so that none counts twice.
- **Carried in an SCTP association of its own,** whose packets are what goes through `sendCallSignalingData`, unless Telegram's parameters for the call say `network_signaling_nosctp`. `MediaState` alone goes over the call's own data channel, once that's open.
- **Who's who:** the caller offers first, controls ICE and is the DTLS client. A message answers an offer only if it carries that offer's number, whoever sent it. When both offer at once the caller's stands.
- **Telegram has an engine of its own for this on the plain peer connection API** (`InstanceV2CompatImpl`, version 14.0.0, with `SignalingTranslator`, 487 lines, between the messages and SDP), and its web apps are the same thing in a browser. So nothing here asks WebRTC for more than Telegram's own code does.

### The servers

A call's servers are of two kinds (`callServer.type`):

- **`callServerTypeWebrtc`: ordinary TURN and STUN,** with a user name and a password. Any WebRTC can use them, and they're all the web apps use.
- **`callServerTypeTelegramReflector`: Telegram's own relays, which aren't TURN.** Every packet to one starts with a 16-byte tag, and tgcalls reaches them through a port of its own inside WebRTC, which the peer connection API can't be given. Their 154 addresses are all inside Telegram's published ranges.

What isn't known, and decides whether this works: that Telegram gives every call a TURN server, to a TDLib app with its own `api_id` and to the other side, and where those servers are. Their addresses and ports aren't in any source. One document of tgcalls' own tells of an experiment in which some calls got Cloudflare's TURN alone, by name (`turn.cloudflare.com`), which this plan refuses.

### What could stop a call

- **`network_use_mtproto` in a call's parameters** puts Telegram's own framing in place of DTLS-SRTP, which no plain WebRTC speaks. Telegram's desktop app ignores a call's parameters altogether, so it's taken that Telegram doesn't set it between unlike apps. A call that has it is ended, saying why.
- **An app too old for 13.0.0.** Telegram then finds no version in common and the call fails at once.
- **No TURN server among a call's servers,** or none at Telegram's addresses.

### An iPhone's pushes for calls

- **Telegram pushes a call through Apple's VoIP pushes,** to a token registered with `deviceTokenApplePushVoIP`, encrypted to a key TDLib makes when asked (`encrypt`), and then, as Telegram's own iPhone app reads them, with the whole of it in one field, `p`.
- **TDLib doesn't read them.** `processPushNotification` answers a call's push with error 406. The call itself comes as `updateCall` once TDLib is connected, which is all Telegram's Android app goes by too.
- **iOS ends an app that takes a VoIP push in the background and reports no call to the system** before the handler returns, and stops delivering to one that keeps doing so. In front, or with a call already there, nothing has to be reported.
- **An app has one VoIP token.** Zuna's relay already has it, for Zuna's own calls, so Telegram's pushes come to the same handler and are told from a server's by their shape.
- **The push certificate Telegram already holds for Zuna probably covers them:** Apple's combined certificate names the app's `.voip` topic too, and developers of forks of Telegram's iPhone app say one upload serves both. Nobody was found who got these pushes into an app built on TDLib.
- **Whether Telegram sends anything but calls to that token** isn't known. In 2019 and 2020 it did, to forks.
- **Telegram rings every device of the account** that takes calls, and when one answers the rest are told the call is over. A device is taken out with `toggleSessionCanAcceptCalls`, which is the "Accept calls" switch Telegram's apps show under Devices.

### Licences

tgcalls is LGPL-3.0, and Telegram's web apps GPL-3.0. Code ported from either would keep its licence inside Zuna, which the AGPL allows and the App Store's terms don't sit well with, for a licence nobody at Zuna can waive. A protocol isn't anyone's code: Zuna's is written from the messages, numbers and order above, and tested against what Telegram's apps send.

## The design

### The core: `packages/core/src/telegram/calls`

A `TelegramSession` has one call at a time, or none. It keeps none of it once it's over.

| File | What it holds |
|---|---|
| `call.ts` | The call's state, from TDLib's updates and the interface's calls, and its deadlines |
| `signal.ts` | The four messages, read and checked, and written |
| `seal.ts` | Sealing and opening a message under the call's key |
| `sctp.ts` | The small SCTP association the sealed messages travel in |
| `sdp.ts` | A local description into messages, and the other side's messages into a description |

- **What the interface asks:** `startCall(chat, { video })`, `answerCall(id)`, `declineCall(id)`, `endCall(id)`, `callOffer(id, sdp)`, which answers with the description to set, `callCandidate(id, candidate)`, `callHeard(id, text)` for what came over the data channel, `callSaid(id, state)` for this side's microphone and camera, `callConnection(id, state)`, `rateCall(id, stars, comment)`, and `takesCalls()` and `setTakesCalls(on)`.
- **What it hears back:** a call ringing is a `CallView` under its chat in `getCalls` and the `call` event, as a server's is, so each interface's ringing needs nothing new. The call itself is one new event, `telegram_call`: who, which way, with the camera or not, where it stands (calling, ringing, connecting, on, over and why), the four emoji, and what the other side says of its microphone, camera and battery. What the peer connection is to do comes as `telegram_call_media`: the servers to open with, a remote description to set, candidates to add, text to send over the data channel.
- **The interface is a pair of hands.** It makes an offer when told and gives it to the core, which takes out what the other side mustn't be sent (the MID and RID header extensions, as each side numbers its own streams), hands it back to be set, and writes the messages from it. The other side's messages become a description the core writes, which the interface sets. Nothing of the other side's is read by the interface but media.
- **Everything from the other side is checked** as it's read, as `map.ts` checks what TDLib says: sizes, counts, kinds, numbers in range. A candidate is taken only if it's UDP at a literal address, so a relay's made-up name (`.reflector`) or a local name is dropped, never looked up. Signalling for a call that isn't this one, or isn't ready, is dropped.
- **Of this device's own candidates only a relay's is ever sent,** whatever the peer connection made, so a fault in an interface can't tell the other side an address.
- **The servers are chosen here:** `callServerTypeWebrtc` with `supports_turn`, at a literal address. Whether that address is Telegram's is the host's to check, where the ranges are.
- **A call that can't be had ends itself** with `discardCall` and words for the person: a version other than 13.0.0, `network_use_mtproto`, no server left, or no connection within 30 seconds of being ready.
- **What it needs of the host:** SHA-256, which it has, and AES-256 in counter mode, which is new: `aes256Ctr` in the crypto crate, bound for every host as any crypto function is. It takes those two and random bytes, and still nothing of `crypto.ts`. Gzip is written in the core: what goes out is stored, not compressed, which every inflater reads, and what comes in is inflated by a small one of the core's own, to 2 MB at most.
- **Each new method is `"never"`** in the plugins' surface, as every `TelegramSession` method is.

### The broker's list

`functions.json` gains what a call needs, with the fields that matter held to one value, so that a fault in the adapter can't ask for another protocol or reach another session:

| Function | Held to |
|---|---|
| `createCall`, `acceptCall` | `protocol`, as Telegram's web apps send it: both of its flags true, which Telegram's page calls deprecated, layers 65 to 92, `library_versions` `["13.0.0"]` |
| `discardCall`, `sendCallSignalingData`, `sendCallRating` | |
| `toggleSessionCanAcceptCalls` | `session_id` 0, which is this device |

`sendCallDebugInformation` and `sendCallLog` aren't on it. The iPhone's broker registers the VoIP token itself, as it does the ordinary one.

### The media, in the interface

One peer connection for the call, made with the WebRTC the app links for LiveKit, beside its rooms and never inside one.

- **Relays only** (`IceTransportsType::Relay`), so the only candidates made, and sent, are addresses on Telegram's TURN servers.
- **The one called answers before it offers.** WebRTC makes whoever sets an offer first ICE's controlling agent, and Telegram's own apps take the caller for that and never give way: they answer every check of a controlling callee as a role conflict, so their side never connects and DTLS never starts. So the one called first answers an offer of the data channel alone, made up in the interface (`answer_first` in `voice/telegram/media.rs`), which makes it the controlled agent and DTLS's server for the whole call, and offers from then on as the caller does. The first answer the core writes gives the other side's real ICE and DTLS parameters.
- **Servers at Telegram's addresses only.** The host checks each against the ranges the door carries (`RANGES_V4` and `RANGES_V6` in `apps/desktop/src/telegram/door.rs`, `rangesV4` and `rangesV6` on the iPhone), at whatever port Telegram gave, and hands WebRTC only those. No STUN server is used: nothing needs this device's own address.
- **Sound:** Opus, at 32 kbit/s at most, as Telegram's apps send it.
- **Picture:** the camera, as one more stream offered once it's turned on, in H.264 where both sides have it and VP8 otherwise. What the other person shares of their screen is one more stream of theirs, and is shown.
- **The data channel** is named `data` and opened by the caller, and carries `MediaState` each way.
- **One room at a time, as now.** A Telegram call is the device's one voice room: starting or answering one leaves a voice channel or a call of Zuna's, and the other way. A second Telegram call that comes during one is declined as busy, as Telegram's apps do.

On the desktop, `apps/desktop/src/voice/telegram.rs` holds the call beside `room/`: the microphone, its processing and push to talk (`mic.rs`, `audio.rs`), the mixer, the camera (`media::record::Camera`) and the tiles' pictures are the ones a room uses, fed to and from the peer connection's tracks instead of LiveKit's. `Voice` holds a room or a Telegram call.

On the iPhone, `apps/ios/Zuna/Voice/TelegramCall.swift` holds it, on LiveKit's WebRTC framework taken directly (`LiveKitWebRTC`), as LiveKit's own SDK keeps its peer connections to itself: the camera, the tiles and the audio session are WebRTC's, and the audio session is given to CallKit by hand, as LiveKit's SDK does for a room. A tile shows a room's track or a call's.

### What the iPhone has to get right

What the desktop's first calls against Telegram's own app found, on 2026-11-17, none of which the core's tests can show, as they play the peer connection themselves and run in Node:

- **Called, it answers before it offers.** `RTCPeerConnection` makes whoever sets an offer first ICE's controlling agent, as libwebrtc does on the desktop, and Telegram's apps take the caller for that and never give way. An iPhone that offers first when called answers every check of theirs as a role conflict, their side never connects or starts DTLS, Telegram's app shows "Exchanging encryption keys", and Telegram ends the call as disconnected after about 20 seconds. So, once, before its first offer: its data channel made, negotiated, id 0, then `setRemoteDescription` with the desktop's made-up offer (`FIRST_OFFER` in `voice/telegram/media.rs`, the data channel's section alone, `a=setup:active`), an answer made and set. As the caller, nothing of it. Its tests check ICE's role in the peer connection's stats (the transport's `iceRole`), controlling as the caller and controlled as the one called, as `voice/telegram/media/tests.rs` does, since nothing else shows it short of a call with Telegram's app.
- **The first answer resets DTLS.** It swaps the made-up offer's fingerprint for the other side's real one, before any handshake, so the peer connection goes back to `new` for a moment after `connecting`. Only `connected`, `disconnected` and `failed` go to the core (`callConnection`), as on the desktop.
- **The core runs in JavaScriptCore there, which has fewer globals than Node.** Every offer once failed in the desktop's QuickJS on `crypto.getRandomValues`, so calls stopped at Connecting both ways, while every test passed in Node. The core now takes random numbers from the crypto core alone. Anything new on a call's path uses only what `polyfills.ts` in the iOS core bundle gives, or the host's natives.
- **The iPhone's offers are its own.** The core's descriptions are tested on the desktop's offers (`packages/core/test/fixtures/telegram-calls`), and `LiveKitWebRTC` may write its offers differently. The iPhone's offers become fixtures of their own: the caller's, the caller's with the camera, and the one called's, made after its first answer, so with the data channel's section first. The core's answers to them are set on a real `RTCPeerConnection` in its tests.
- **The first call is against Telegram's own app,** each way, before CallKit or the screens. Between two of Zuna's apps, each side's WebRTC settles a role conflict by itself, which hides the first problem above.
- **Telegram's picture comes before its word.** Its apps send their picture before the `MediaState` that says the camera's on, and use the same stream when it's turned on again, so what's shown follows `remote.camera` and `remote.screen` as they change, not only a track coming (`on_telegram_call` in `voice/telegram/mod.rs`). Its iPhone app's camera, held upright, comes 1280×720 with a turn of 90° in the orientation header, and its shared screen 884×1916, unturned: a camera's tile takes its picture's shape, and an image is laid out in its box's shape, not its own, or the tall one is cut (`video` in `ui/voice_stage/mod.rs`).
- **To see why a call doesn't connect,** the call's course isn't logged, at the owner's word, so notes go in by hand for a debug build and come out before anything is committed. WebRTC's own log names a role conflict (`Received conflicting role from the peer`) and DTLS's progress: `RTCSetMinDebugLogLevel` on the iPhone, under `LiveKitWebRTC`'s `LK` prefix as its classes are, as `ZUNA_WEBRTC_LOG=1` with `RUST_LOG=libwebrtc=debug` shows it on the desktop.

### Through a proxy

With a SOCKS5 proxy set on the device ([SOCKS5.md](SOCKS5.md)), each TURN server becomes a relay on loopback, which carries what WebRTC sends it through the proxy to that server, in a UDP association: `Relays` in `voice/proxy.rs`, and `CallProxy` on the iPhone, as they do for LiveKit's candidates. WebRTC is told the loopback address alone. A proxy that grants no association gets no Telegram call, and the app says so, unless step 1 finds Telegram's TURN servers take TCP, in which case the relay carries that.

### What the screens show

- **Starting one:** the voice and camera buttons in a private chat's header, where Telegram says the person can be called (`userFullInfo.can_be_called`, `supports_video_calls`). Not in Saved Messages, with a bot, or in a group.
- **Ringing:** as a call of Zuna's rings, with "(Telegram)" after the name, as its notifications have.
- **The call:** the screen a direct message's call has, without what Telegram's hasn't: the soundboard, watching together, sharing a screen. It says "Telegram call" where a call of Zuna's says it's end-to-end encrypted, and shows the four emoji, with what they're for: if the other person sees the same four, nobody in between can listen.
- **Over:** why, in words: declined, busy, no answer, answered on another device, couldn't connect. When Telegram asks for it (`need_rating`), a small card asks how the call was, one to five, with a line for what was wrong under five, and can be closed.
- **In the chat:** Telegram's own line for the call (`messageCall`): outgoing or incoming, missed, declined or cancelled, by voice or video, and how long, with a click to call back. It takes the place of "Voice call in Telegram's app".
- **Settings, Connections:** "Take Telegram calls on this device", on by default.
- **The linking screen** stops saying calls stay in Telegram's app: video chats in groups do.

### An iPhone ringing with Zuna closed

1. **Registering.** With an account linked, the switch on and a VoIP token from PushKit, the broker gives Telegram the token (`deviceTokenApplePushVoIP`, with `encrypt`) each time the engine starts, and keeps the ID Telegram's pushes will carry (`pushReceiverId`). Unlinking, or the switch going off, takes the token back. Where CallKit isn't allowed, as on China's App Store, there's no token, and a call rings only with Zuna open, as Zuna's own do.
2. **A push comes.** One that isn't a server's and carries Telegram's field, for the ID kept (`getPushReceiverId`, which TDLib answers without a client), is reported to CallKit before the handler returns, as "Telegram", since nothing in it can be read. Anything else rings as a push Zuna can't read does now.
3. **The engine starts,** out of sight, which until now it never did: a call the system holds keeps the app running. TDLib is asked what the push was (`processPushNotification`): error 406 says a call, and any other answer that it wasn't one, which ends the system's call at once, as Telegram's own app does with a push it can't place.
4. **The call arrives** as `updateCall`, and the system's call takes the caller's name. If none has come in 10 seconds, the system's call ends as missed.
5. **Answered or declined before then,** the answer waits for the call, as it does for a server's (`pendingAnswer`). A decline is sent only for a call TDLib still has ringing, so that a call another app took isn't ended from here.
6. **Taken on another device,** or over, the system's call ends, saying which.
7. **Before the phone's first unlock** the engine's folder can't be read, so the call rings as "Telegram" and can't be answered here.

With Telegram's own app on the same phone, both ring. Whichever answers, the other stops. Someone who'd rather Telegram's app took the calls turns the switch off.

### The switch

"Take Telegram calls on this device", in Connections, on every platform. It's Telegram's own setting for the session (`toggleSessionCanAcceptCalls` with this device's session, read back as the option `can_accept_calls`), which Telegram's apps show under Devices as "Accept calls", so it's the same switch wherever it's turned. Off, Telegram tells this device of no call, the iPhone's VoIP token is taken back, and calls can still be made from here.

### Where the media runs

In the app, by the decision above. What that means:

- **No code of Telegram's is in the app.** The signalling is Zuna's, in the core, and the media is the WebRTC that carries Zuna's own calls.
- **What the other side sends is parsed in the app:** ICE, DTLS, RTP, Opus and video, by WebRTC, and the four messages, by the core. Only once the person has started or answered that call, and only from whoever holds the call's key. A fault there is a fault in the process that holds Zuna's keys, which a call of Zuna's already risks from whoever is in it.
- **The engine's box is as it was.** TDLib needs nothing more for calls: no UDP, no microphone, no camera.

What was turned down:

- **tgcalls itself.** It needs Telegram's build of WebRTC, a second one beside LiveKit's, which can't be linked into one program with it. In a process of its own it would need the microphone, the camera, the GPU and UDP inside its box. On the iPhone it would run in the app anyway.
- **Zuna's WebRTC in a boxed process of its own.** Sound and pictures would cross between processes both ways, video would be encoded and decoded without the GPU, the box would have to let UDP out, and it's several times the work, for the desktop alone.

### What's said about encryption

A call's key is agreed between the two apps by TDLib, inside its box, and comes to the core, which seals the signalling with it. The media is DTLS-SRTP between the two apps, and each side's DTLS fingerprint travels sealed under that key, so Telegram's relays carry what they can't open or change. Someone who stood between the apps as the key was agreed would show as different emoji on the two screens, which is the check Telegram's own apps offer, and the only one: nothing of Zuna's key log or verification stands behind it. The screen and the docs say that, and never call it Zuna's end-to-end encryption.

What Telegram learns is what it learns of a call in its own apps: who called whom, when and for how long, and at its relay this device's address, or the proxy's. The other person learns no address, which is less than Telegram's apps tell by default.

## What has to be shown first

A throwaway, with two real accounts and each of Telegram's apps on the other side. Each of these could change the design.

- **What `callStateReady` holds for Zuna's `api_id`,** on production and on the test servers: the version first in the list against each app, the servers, their kinds, addresses and ports, and the parameters. **Whether a TURN server at Telegram's addresses is always there** is what everything rests on.
- **That a relays-only peer connection gets a call through** with Android, iPhone, Desktop, macOS, Web K and Web A, each way, with the other side's own device-to-device setting on and off.
- **That 13.0.0 alone is enough,** and what happens against an app that hasn't got it.
- **Whether Telegram's TURN servers take TCP,** for a proxy that carries no UDP.
- **That LiveKit's Rust crate does what's needed:** a peer connection from LiveKit's factory (`LkRuntime`) or a second one beside it, a remote description written by hand and its streams found by SSRC with no MID, the data channel opened in band on stream 0, one bundle, Opus held to 32 kbit/s. What its `RtcConfiguration` lacks goes into `patches/webrtc-sys.patch`.
- **That the iPhone app can take `LiveKitWebRTC` directly** beside LiveKit's SDK, and hand its audio session to CallKit.
- **That WebRTC takes a TURN server on loopback,** on each system, for the proxy.
- **On a phone:** that the certificate Telegram holds covers `.voip` (`openssl x509 -text` lists the topic); what Telegram sends that token, and whether only calls; that `getPushReceiverId` answers before any client exists; how long a cold start takes from the push to `updateCall`; that turning the switch off stops the pushes; and what Telegram's own app on the same phone does when either answers or declines.
- **Whether the test servers have calls at all.**

If Telegram doesn't always give a TURN server, the call needs Telegram's own relays, and a way to them without changing WebRTC: a small TURN server of the app's own on loopback that speaks the relays' framing outward. That becomes step 4, before any screen.

## How it's tested

| Where | What runs |
|---|---|
| Core | `telegram-calls.test.ts`. Sealed packets recorded from a call with each of Telegram's apps on test accounts, with the call's key: each opens, inflates and reads as its message. Two sessions on the fake engine, which learns calls (`fake-tdlib.ts`): a call each way, both offering at once, the camera turned on by each, every refusal above, and every candidate that must be dropped |
| Descriptions | A local offer as each platform's WebRTC writes it becomes the messages expected, and each app's recorded messages become a description, kept as files. The native app's tests set those on a real peer connection, which must take them, the caller as ICE's controlling agent and the one called as its controlled one |
| The broker | The call functions with any other `protocol` or `session_id` are refused |
| Desktop | `apps/desktop/test/telegram-call-check.mjs`: two copies of the app on fake engines the check joins, with a TURN server of its own on loopback, which only a build with the test control takes. A call each way with a tone heard at the other end and the camera's bars seen, muting, declining, hanging up, and again through the tests' SOCKS5 proxy, failing on any connection that went around it |
| iPhone | `test:ios:ui` on the fake engine: ringing through CallKit, a call, and a push in Telegram's shape handed over as PushKit would (`voipPush`). Pushes, and Telegram's own app beside Zuna, on a phone by hand |
| Against Telegram | By hand, each of its apps as the caller and the answerer, by voice and with the camera, written under "Where it stands" |

## The order to build it in

Each step is a commit or a few, pushed when its checks pass.

1. **Show what has to be shown first.** Nothing committed but what it found, written here, and the recorded packets as fixtures.
2. `aes256Ctr` in the crypto crate and every host.
3. The core: sealing, gzip, the SCTP association and the messages, on the fixtures. Then descriptions both ways, the call's state, the fake engine's calls, the broker's list, and the types in `types.ts`, `models.rs` and `Models.swift`.
4. The desktop, by voice: the peer connection, ringing, the call's screen with its emoji, the header's buttons, the chat's line, the card that asks how it was, the switch. `telegram-call-check.mjs`. A minor release.
5. The desktop, with the camera, and the other side's shared screen shown.
6. Through the proxy, on the desktop, in the check.
7. The iPhone: the peer connection, CallKit while Zuna is open, the call's screen, the camera, the proxy.
8. The iPhone's VoIP pushes and the switch there. The iPhone's first build with calls has them.
9. The docs under "What changes with it", in the commits that make each true.
10. Later, each on its own: sharing a screen from Zuna, a call's statistics, video chats in groups, conference calls.

Until step 8 is pushed, `.agents/FEATURE_PARITY.md` lists the iPhone as a Known gap.

## What changes with it

In the commit that makes each true:

- `CLAUDE.md`. "What has to change together": the call's signalling with its fixtures and this page; the list of Telegram's ranges, which a call's servers are now held to as well; LiveKit's SDK on either platform, with the descriptions' files, as a new WebRTC may write an offer differently. "Decisions to keep": a Telegram call is the device's one voice room, goes through Telegram's relays alone, and is the one thing of Telegram's parsed in the app.
- `docs/TELEGRAM_PLAN.md`: calls out of "Left out", the third rule's exception, and that the iPhone's engine now starts out of sight for a call's push.
- `docs/TELEGRAM.md`: calls under "What's there", what the emoji mean, the switch, and that video chats in groups stay in Telegram's app.
- `SECURITY.md` and `docs/SECURITY_DETAILS.md`, "Telegram": what "What's said about encryption" says, and what's parsed in the app.
- `docs/SOCKS5.md`: a Telegram call among the connections an app makes, and what a proxy without UDP means for one.
- `apps/site`: the privacy page, that a call on Telegram reaches Telegram's relays.
- `packages/i18n`: every new text, in every catalog. The linking screen's point about calls gets a new key, as its meaning changes.
- `.agents/FEATURE_PARITY.md`: rows for it, the web as `n/a`.
- `docs/IOS_TESTING.md`: the push's control and what a phone is needed for.
- `docs/ROADMAP.md`.

## Risks

- **Telegram gives a call no TURN server Zuna will use,** always or in an experiment. Those calls fail, saying why, until its own relays are reached through a shim.
- **Telegram drops 13.0.0,** as it dropped 4.0.0. Its web apps would break the same day, so they're the warning. Until Zuna follows, calls say "Update Zuna to call on Telegram", and the chats are untouched.
- **A fault in WebRTC is reachable by whoever the person is in a Telegram call with.** That's the exception this plan makes.
- **A phantom call on an iPhone,** for a second, if Telegram sends that token something that isn't a call.
- **iOS stops delivering VoIP pushes** to an app that fails to report them, and Zuna's own calls come by the same token.
- **Two apps ringing on one phone,** and whatever Telegram's own app does when Zuna answers, which nobody has written down.
- **A new LiveKit changes WebRTC under the call,** which the descriptions' files are there to catch.
- **The emoji are taken for more than they are.** The screen says what they check.
- **Calls sound worse than in Telegram's apps** where those go device to device: a relay adds a hop.

## Left out

- **Device-to-device connections,** whatever the account's setting.
- **Video chats in groups, and conference calls,** with moving a call into one: a call the other side moves there ends here, saying to open it in Telegram.
- **Sharing a screen from Zuna,** in the first version.
- **Telegram's own relays,** unless step 1 shows they're needed.
- **Debug logs to Telegram.** They'd describe the device.
- **Who may call the account, and its device-to-device setting.** Telegram's own apps.
- **The web app,** which has no Telegram.

## Questions for the owner

1. **The push certificate.** Does the one uploaded at my.telegram.org name the `.voip` topic? If not, a new combined one has to be made and uploaded.
2. **The exception.** Answered on 2026-11-16: the media runs in the app.
3. **Written anew, not ported.** Assumed, for the App Store. Porting Telegram's translator would be quicker on the desktop, under the LGPL.
4. **The switch's reach.** Assumed: Telegram's own "Accept calls" for the device, so that off means no call rings here at all. The other reading is to take back the iPhone's VoIP token alone, which still rings with Zuna open, beside Telegram's app.
5. **If step 1 finds calls without TURN:** build the shim to Telegram's relays first, or let those calls fail?
6. **The card that asks how the call was.** Telegram's page on calls says a client must ask when told to. Assumed: a small card that can be closed.
7. **The words for the emoji.** Assumed: "If [name] sees the same four, nobody in between can listen."

## Where it stands

On 2026-11-16, built on Linux, steps 2 to 6 for the desktop app, without step 1, and on 2026-11-17 run against Telegram:

- **Built:** `aes256Ctr` on every host; in the core, sealing (`seal.ts`), gzip with an inflater of its own (`gzip.ts`), the SCTP association (`sctp.ts`), the four messages (`signal.ts`), descriptions both ways (`sdp.ts`) and the call's state (`call.ts`), behind `telegramCalls`, which only the desktop's host sets; the broker's list; the desktop's peer connection (`voice/telegram/media.rs`), ringing, the call's screen with the emoji, the camera, the header's buttons, the chat's line, the rating card, the switch, and the relays through the proxy.
- **Tested:** the core's calls on the fake engine, a call each way, declining, giving up, busy, the camera, every refusal, signalling that comes early (`telegram-calls.test.ts`); SCTP against itself through loss, duplicates, reordering, collisions and restarts, and dcsctp's packets built by hand (`telegram-call-sctp.test.ts`); sealing against a second implementation (`telegram-call-seal.test.ts`); the native app's WebRTC taking the core's offers and answers, from offers it made (`voice/telegram/media/tests.rs`); the app ringing, answering, drawing and ending a call on the tests' stand-in core (`voice/telegram/tests.rs`).
- **What changed from the design:** `declineCall` takes the chat's group, as a server's does, so the ringing banner declines either; `rateCall` sends Telegram's own problems and no words; the switch reads `can_accept_calls` from `getActiveSessions`, as TDLib has no option for it, which put `getActiveSessions` on the broker's list; the callee's data channel is `data` on stream 0 too, negotiated, so its offers have the section for it; SCTP packets are held to 1191 bytes, dcsctp's MTU in WebRTC; an offer is made with `offer_to_receive_*` set, without which libwebrtc offers a section that only takes as inactive; and the one called answers a made-up offer before its first ("What the iPhone has to get right").
- **Against Telegram:** on Linux, with a production account, a voice call each way with Telegram's own app connected, sound and data channel, once the two faults it found were fixed ("What the iPhone has to get right"), and calls from Telegram's iPhone app showed its camera, front and back, turned off and on, and its shared screen, once four more were: its H.264 taken by profile, a quiet section's header extensions kept, the picture shown when its `MediaState` comes after it, and an image laid out in its tile's shape. Its apps offer H.264 constrained high (640c29) first, then constrained baseline (42e029), VP8, VP9 and H.265. Each call it was given had 13.0.0, no parameter of those that end one, and two servers: TURN and STUN at one of Telegram's addresses on port 1400, and a reflector. Not tried: this side's camera going to Telegram, two of Zuna's apps, Telegram's other apps, a proxy.
- **Not done:** the rest of step 1, so whether every call gets a TURN server at Telegram's addresses, on every account, is still unknown; `telegram-call-check.mjs`, so no media has gone between two of Zuna's apps, and nothing through a proxy; Windows and macOS not built; a click on a call's line to call back; steps 7 and 8, the iPhone.

## What was read

On 2026-11-16, in source: tgcalls' `development` branch at `d2937872` (`tgcalls/v2`: `Signaling.cpp`, `SignalingTranslator`, `InstanceV2Impl.cpp`, `InstanceV2CompatImpl.cpp`, `SignalingSctpConnection.cpp`, `ReflectorPort.cpp`, `ReflectorRelayPortFactory.cpp`, `EncryptedConnection.cpp`, and its `docs/engine-audit-2026-07.md`), Telegram Desktop's `calls_call.cpp`, Telegram's iPhone, Android and macOS apps for the versions each lists, Web K's `src/lib/calls` and Web A's `phoneCallState.ts` and `sctpSignaling.ts`, and TDLib's `td_api.tl`, `CallActor.cpp`, `DeviceTokenManager.cpp` and `NotificationManager.cpp` at the pinned commit. Telegram's pages on calls, end-to-end encrypted calls, pushes, its API's terms and its reflectors' list. Apple's pages on PushKit, CallKit and push certificates, and its engineers' answers on the developer forums about what has to be reported. In this repository: `apps/desktop/src/voice` and `src/telegram`, `packages/core/src/telegram`, `apps/ios/Zuna/Voice` and `ZunaHost/TelegramBridge.swift`, and LiveKit's Rust crate (`libwebrtc` 0.3.55) for what a peer connection there can be told.

Not run, and from reading alone: everything under "What has to be shown first".
