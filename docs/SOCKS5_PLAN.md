# Reaching a server through a SOCKS5 proxy: plan

Sealed sender keeps the server from being told who sent a message. It still sees the address each device connects from, and so does LiveKit in a call. This page plans a setting that sends everything an app sends through a SOCKS5 proxy of the person's choosing, calls included, so that what the server and LiveKit see is the proxy's address. It's what was found, what was decided, and the order to build it in. "Where it stands" at the end says what's built.

## What's wrong

- **The server sees every device's address,** on its socket, on each signed-in request and on each sealed one. `SECURITY.md` lists it under Network, and `docs/SEALED_SENDER.md` under what a determined server can still tell.
- **LiveKit sees it too,** for as long as someone is in a call, with the addresses of the device's local network, which every app offers as candidates (`docs/VOICE_LOGS_PLAN.md`, "Left out").
- **So does every other place an app contacts:** a site whose link is previewed, YouTube once Watch is pressed, GitHub when the desktop app looks for an update.
- **Nothing in the apps can change that.** A VPN for the whole system does, and is all there is today.

## What it's for, and what it isn't

The aim: with a proxy set on a device, the server, LiveKit and everything else that device contacts see the proxy's address and never the device's, and the app makes no connection that doesn't go through the proxy.

It isn't:

- **Telling sealed requests apart from the session.** Both leave the proxy from the same address, so a server can still pair them by it, as it can today. Decided on 2026-11-13: one proxy carries everything. Sending sealed requests another way, through a second proxy or a Tor circuit of their own, is left out.
- **Hiding anything from the proxy.** It learns the device's address, which servers it reaches, when and how much. It never sees content, which stays under TLS and end to end encryption.
- **Encryption on the way to the proxy.** SOCKS5 has none: between the device and the proxy, the server's name and the proxy's password travel as they are. A proxy on the same machine, such as Tor or `ssh -D`, has no such stretch.
- **Tor built in,** `.onion` servers, or HTTP proxies. A Tor someone runs themselves is a SOCKS5 proxy like any other.
- **Protection from timing.** Coming online, typing and sending still happen when they happen.
- **The web app.** A page can't choose how its browser connects.

## What was decided

Asked and answered on 2026-11-13:

1. **One proxy for everything,** sealed requests included.
2. **Everything goes through it, with no exceptions:** the server, LiveKit, link previews, updates, plugins, emotes and YouTube. When the proxy can't be reached the app connects to nothing, and never falls back to a direct connection.
3. **One setting for the device,** for every server on it, which can be set before joining the first, so that even signing up goes through it.
4. **The web app is marked `n/a`.** What a browser sends follows the browser's or the system's own proxy. The docs say that a call in a browser may still go straight to LiveKit, and point to the native apps.

And what follows from them:

- **SOCKS5 only** (RFC 1928), with no sign-in or with a username and password (RFC 1929).
- **The proxy resolves names.** The device never looks a server's name up itself, which would show its resolver, and sometimes part of its own address, to whoever runs the name's DNS.
- **Calls take UDP where the proxy carries it** (`UDP ASSOCIATE`), and TCP where it doesn't, as Tor and `ssh -D` don't.
- **The server changes nothing.** Deployments already open 7881/tcp for people whose networks block UDP, which is what a call over a TCP-only proxy uses.

## What an app sends today

Every connection has to be found and sent through the proxy, so this is the list. Each row is a place a connection is made.

### The desktop app

| What | Where |
|---|---|
| The core's requests, signed-in and sealed, on clients of their own | `http` and `sealed_http` in `apps/desktop/src/host/runtime.rs` |
| The core's socket | `wsOpen` in `runtime.rs`, through tokio-tungstenite |
| Link previews, which resolve names here to refuse private addresses | `apps/desktop/src/host/web.rs` |
| Icons, emotes and the plugins' marketplace | `fetch` in `apps/desktop/src/host/mod.rs` |
| What plugins fetch | `apps/desktop/src/plugins/net.rs` |
| Updates, from GitHub | `apps/desktop/src/platform/updates.rs`, `platform/windows/updates.rs` |
| LiveKit's signalling: a WebSocket to `/livekit/` on the server, and a few requests | LiveKit's `livekit-net` crate |
| A call's media: UDP to 7882, or TCP to 7881, on the machine LiveKit runs on | libwebrtc, inside LiveKit's SDK |
| YouTube's player | WKWebView on macOS, WebView2 on Windows, `zuna-watch` (`apps/desktop/watch`) on Linux |

### The iPhone and iPad app

| What | Where |
|---|---|
| The core's requests, signed-in and sealed | The two sessions in `ZunaHost/NetworkBridge.swift` |
| The core's socket | An `NWConnection` in `NetworkBridge.swift` |
| Link previews | `ZunaHost/WebBridge.swift` |
| Emotes, and what `PinnedServers` fetches | `ZunaHost/EmoteFiles.swift`, `ZunaHost/PinnedServers.swift` |
| The same, from the notification and share extensions, which run a core of their own | `ZunaNotifications`, `ZunaShare` |
| LiveKit's signalling | A URLSession LiveKit's Swift SDK makes for itself (`WebSocket.swift`, `HTTP.swift` in the SDK) |
| A call's media | libwebrtc, in LiveKit's prebuilt framework |
| YouTube's player | WKWebView in `Zuna/Voice/Watch.swift` |

Apple's push service isn't on the list. The system holds that connection, no app can route it, and the server never sees a device's address through it.

### `zuna-bot`

Everything goes through undici: its requests, its sealed ones on an agent of their own, and its socket (`pinnedAgent` and `sealedAgent` in `apps/bot/src/host.ts`). A bot joins no call.

## The setting

- **Four fields:** address, port, and optionally a username and a password. The address may be a name or an IP address, on this machine, the local network or the internet.
- **Where it is:** Settings, Privacy, on the desktop and the iPhone, and a link on the first screen, before any server is joined.
- **Where it's kept:** outside any account, as it's needed before there is one. The password is sealed as the device key is, in the system's keychain or its like (`apps/desktop/src/host/device_key.rs`), and the rest is in `settings.json`. On the iPhone the password is in the keychain group the extensions share, and the rest in the app group, so the notification and share extensions use the same proxy.
- **A Check button,** which signs in to the proxy, reaches each server joined through it, and says how long it took and whether the proxy carries UDP. Where it doesn't, it says that calls will go over TCP and may sound worse.
- **Changing it** closes every connection and opens them again the new way. A call in progress ends.
- **When the proxy can't be reached,** the app says so in those words, where it says today that it's offline, and stays disconnected. No button connects without it: turning the proxy off in Settings is the only way.
- **A proxy on the local network** makes iOS and macOS ask for access to it, once, as the system does for any app.
- **For a bot:** `--proxy socks5://user:password@host:port`, or `ZUNA_BOT_PROXY`.

## Chat traffic

**The desktop app.** One function builds every HTTP client, and takes the proxy from the setting, so a client made anywhere else stands out. reqwest's `socks` feature does the rest, with names left to the proxy (`socks5h`). The socket connects through a small SOCKS5 client of the app's own (`host/socks.rs`), then does TLS and the WebSocket handshake over it, with the same certificate rules and pins as now. With the proxy on, reqwest's reading of proxies from the environment is off.

Link previews change one rule. Today the app resolves a name, refuses private addresses, and connects to what it checked. Under a proxy it can't resolve, so it refuses by name and by literal address alone, and where the name leads is the proxy's to decide, as `docs/SECURITY_DETAILS.md` already says of a system proxy.

**The iPhone and iPad app.** The system does SOCKS5 itself from iOS 17, and the app needs iOS 18: `ProxyConfiguration(socksv5Proxy:)`, given to each `URLSessionConfiguration` and, for the socket, to its `NWParameters`. `allowFailover` stays off. The extensions read the same setting before their core starts.

**`zuna-bot`.** `pinnedAgent`'s connector opens a SOCKS5 connection first and does TLS over it, with the pins checked as now. That's about eighty lines with no new dependency, and covers the socket, which Node opens through the same dispatcher.

## Calls

### Why it isn't a setting

- **libwebrtc has no proxy support left.** The build LiveKit's Rust SDK uses (`webrtc-a545de4`) has neither `ProxyInfo` nor a SOCKS socket in its headers. They were removed upstream.
- **On the desktop a socket factory could be swapped in,** as `webrtc-sys` sets `socket_factory` itself (`peer_connection_factory.cpp`), and Zuna patches that crate already.
- **On the iPhone it couldn't.** LiveKit's framework is prebuilt, and its Objective-C interface takes no socket factory. That would mean building WebRTC ourselves.
- **Neither SDK lets an app change what the server tells it,** which is where the addresses a call connects to come from.

So one design for both, which changes no SDK and no WebRTC: **the SDK is only ever told addresses on this device.**

### The design

Three parts, all in the app, and only while the proxy is on.

**1. Signalling goes through the proxy, and through the app's hands.**

- On the desktop, `livekit-net` takes a WebSocket and an HTTP client from the app (`set_ws_client`, `set_http_client`), meant for exactly this. The app registers its own at startup. They connect through the proxy when it's on, and as now when it's off.
- On the iPhone, the SDK makes its own URLSession, so the app gives it an address on loopback instead of the server's: a WebSocket endpoint of the app's own (`NWListener`), which takes the SDK's connection and opens the real one through the proxy. The address carries a secret made for that call, so nothing else on the phone can use it. `NSAllowsLocalNetworking` is already on.

**2. What passes is rewritten,** so that no real address reaches the SDK and no address of the device reaches LiveKit.

| Message | What changes |
|---|---|
| Joining and reconnecting, from the server | The list of STUN and TURN servers is emptied, so the SDK asks nobody for its address |
| An offer or answer, from the server | Each candidate's address becomes a relay's, as below |
| A candidate, from the server | The same |
| Leaving, from the server | Any other address to try is taken out |
| An offer or answer, and the offer inside the address it joins by, from the app | Every candidate is taken out |
| A candidate, from the app | Dropped. LiveKit learns where the app is from the first packet that reaches it, which comes from the proxy |
| A kind the rewriter doesn't know | Dropped and logged |

This is the part a mistake in would leak through, so it's written once, in the core (`packages/core/src/voice-relay.ts`), as a function from bytes to bytes that every host calls. It reads the protobuf's wire format directly and replaces only the fields above, so everything else a message holds passes untouched. Its tests run on messages a real LiveKit sent, and one of them lists every kind of message the pinned protocol has, so a new LiveKit that adds one fails there rather than in someone's call.

**3. Relays on loopback carry the media.** For each of LiveKit's candidates the app opens a port on loopback and hands the SDK that instead.

- **TCP:** the relay takes libwebrtc's connection, asks the proxy to connect to LiveKit's 7881, and passes bytes both ways.
- **UDP:** the relay asks the proxy for a UDP association, wraps each packet in SOCKS5's header and sends it to the proxy, and unwraps what comes back. Each of libwebrtc's own sockets gets an association of its own, so answers find their way back.
- **Which one a call uses** needs no test of the proxy. A proxy that refuses the association gets no UDP candidates at all. One that grants it gets both, and ICE picks UDP when its checks get through, and TCP when they don't.
- **Relays live as long as the room,** take packets only from this device, and close with it.

### What LiveKit and the server see

A WebSocket from the proxy, and media from the proxy. Not the device's address, and no longer its local network's addresses, which today's apps send.

Everyone behind one proxy shares its address, so they share the server's limits for an address too. A server whose members all use one proxy may need those raised, which `docs/SELF_HOSTING.md` should say.

### What it costs

- **Over UDP,** one more hop.
- **Over TCP,** the same hop, and a lost packet holds up the ones behind it. Voice gets through. A screen share at a high bitrate will stutter on a slow proxy, and through Tor a call may not be worth having. The app says which way a call is going in the stream stats.

### What was considered and left

- **A socket factory in the `webrtc-sys` patch.** Stronger on the desktop, as no socket could go around it, but the iPhone can't have it, so there'd be two designs to keep. It stays the fallback for the desktop if loopback relays fail somewhere, as "What has to be shown first" says.
- **TURN over TLS.** Needs a TURN server with a domain and certificate on every deployment, and the SDK would still have to be told a loopback address for it.
- **A fork of each SDK.** The pins on the iPhone were done without one (`LiveKitPins.swift`), and this can be too.
- **A tunnel for the whole system.** Needs an administrator on the desktop and a network extension on the iPhone.

## Everything else

- **Updates, plugins, icons and emotes** go through the same client builder as the core's requests.
- **YouTube on macOS and the iPhone:** `WKWebsiteDataStore.proxyConfigurations` takes the same proxy.
- **YouTube on Linux:** `zuna-watch` is given the proxy through WebKitGTK's own setting.
- **YouTube on Windows:** Chromium can't sign in to a SOCKS5 proxy, so WebView2 is pointed at a door of the app's own on loopback, open only while a video plays, which passes connections on to the real proxy.
- **Until each of those is built, Watch says it can't play through a proxy** on that system. Nothing goes direct in the meantime.

## How it's tested

### A proxy for the tests

`packages/core/test/socks-proxy.ts`: a SOCKS5 server in Node with `CONNECT`, `UDP ASSOCIATE` and a username and password. It writes down everything it was asked: a name or an address, which port, how it signed in. Switches make it refuse UDP, refuse the password, hang, or go away mid-connection.

Beside it, a recorder in front of the test server and the test LiveKit, which writes down the port each connection and packet came from. The check every platform shares:

- **Nothing reached the server or LiveKit that didn't leave the proxy.** Every port the recorder saw is one the proxy opened.
- **The proxy was never given an address where it should have been given a name.**
- **With the proxy gone, nothing connects.**
- **What LiveKit was told holds no address of the device.**

### On each platform

| Where | What runs |
|---|---|
| Core | The rewriter's tests. `ZUNA_TEST_SOCKS=1` runs the whole suite through the test proxy, as `ZUNA_TEST_JUNK_SENDERS` runs it behind another |
| Desktop | Unit tests for `host/socks.rs`. `apps/desktop/test/proxy-check.mjs`: two copies of the app through the test proxy, a chat, a file, then a call over UDP and again with UDP refused, with a tone heard at the other end, on macOS through the test control and on Linux in KWin. Windows by hand until it has a check of its own |
| iPhone | `npm run test:ios` through the test proxy. `test:ios:voice` with the proxy on, both ways. A real iPhone for the call, as a simulator shares the Mac's network |
| Bot | `npm run test:bot` with `--proxy` |
| Web | Nothing. `web-check.mjs` must still pass |

### A real proxy: NordVPN

The test proxy is ours, on the same machine. A real one shows what ours can't: a real sign-in, real latency, and whether a commercial proxy carries UDP. Access to NordVPN's SOCKS5 was offered for this on 2026-11-12.

- **The first thing to learn is whether it grants `UDP ASSOCIATE`.** Most commercial proxies don't. If not, NordVPN covers the TCP path, and UDP is covered by the test proxy and by `dante` on a machine of ours.
- **It needs a server on the internet.** The proxy can't reach a test server on this Mac. A throwaway VM set up with `deploy/install.sh` does, and its proxy's access log is where to read which address it saw.
- **What's checked:** signing up, a message each way, a file, a link preview, a call with a tone heard at the other end, a screen share, and that the address in the VM's log is NordVPN's and never this network's.
- **The credentials never enter the repository.** The check reads `ZUNA_TEST_SOCKS5_LIVE=socks5://user:password@host:port` from the environment, set in the shell that runs it, and refuses to run without it. It prints the proxy's address with the username and password taken out. No file under git, no commit message and no log holds them. They should be NordVPN's service credentials, which can be revoked from its dashboard, and not the account's own password.

## The order to build it in

Each step is a commit of its own, pushed when its checks pass.

1. **Show what has to be shown first** (below), as a throwaway. Nothing committed but what it found, written here.
2. `core:` the test proxy and the recorder.
3. `core:` the signalling rewriter and its tests. `ZUNA_TEST_SOCKS`.
4. `desktop:` the setting, its screen and the Check button. `host/socks.rs`, the one client builder, the socket, link previews' rule. No voice yet: joining a call under a proxy says it can't, and Watch too.
5. `desktop:` calls. The clients `livekit-net` takes, the relays, the stream stats' line. `proxy-check.mjs`.
6. `desktop:` YouTube, a system at a time.
7. `ios:` the setting and its screen, every session and the socket, the extensions.
8. `ios:` calls and YouTube.
9. `bot:` `--proxy`.
10. `docs:` what's listed under "What changes with it", in the commits that make each true, and whatever is left here.
11. The check through NordVPN, and what it found written here.

Steps 4 to 6 are a new setting in the native app, so the nightly that carries them is a minor one.

## What has to be shown first

Read from code, not run. Each could change the design, so each is tried before anything is built on it.

- **That libwebrtc connects to a candidate on loopback** from a socket bound to a network interface, over UDP and TCP, on Windows, Linux, macOS and iOS. Windows is the doubtful one. If it won't, the relays listen on the device's own addresses instead, taking packets only from itself. If that fails on the desktop too, the socket factory in the `webrtc-sys` patch.
- **That LiveKit connects with no candidates from the app,** over its UDP and TCP ports. It should, as that's how anyone behind a strict NAT connects.
- **That the system's SOCKS5 on iOS** sends names and not addresses, signs in with a password, and fails rather than going direct.
- **That LiveKit's Swift SDK takes a `ws://` address on loopback** for a room without objecting.
- **That WebView2 can't sign in to a SOCKS5 proxy,** which is why it gets a door of its own.
- **Whether NordVPN's proxy carries UDP.**

What was found, on 2026-11-13:

- **libwebrtc reaches a relay on loopback on macOS,** over UDP and TCP, from its sockets on the network's address (10.10.10.110 here): `apps/desktop/test/proxy-check.mjs` hears a tone both ways through relays, over UDP and again over TCP. Windows, Linux and iOS weren't tried.
- **LiveKit connects with no candidates from the app,** over UDP and TCP, the same check shows. But it takes nothing from loopback: with LiveKit on 127.0.0.1 and the proxy on the same machine, every packet and connection the proxy passed on went unanswered. A real proxy is never on loopback to LiveKit, so the check runs LiveKit on the Mac's address on its network, as `web-check.mjs` does.
- **The system's SOCKS5 does what step 7 needs, tried on macOS 27, not iOS,** from a program in Swift against the test proxy on 127.0.0.1 with a password of `@`, a space and a quote: `ProxyConfiguration(socksv5Proxy:)`, `applyCredential`, `allowFailover`, `URLSessionConfiguration.proxyConfigurations` and `NWParameters.PrivacyContext.proxyConfigurations` are there under those names; `URLSession` and `NWConnection` both gave the proxy a name only it knew, signed in, failed with the wrong password ("Authentication error") and with the proxy gone ("Connection refused"), and never went around it. One exception: to `localhost`, and to this machine's own address on its network, both went straight there with the proxy gone, `allowFailover` off notwithstanding, so the system takes no proxy to the device itself. Whether it does the same for other addresses on the local network wasn't tried. Under a proxy the iPhone app should refuse a server by a local name or a private address itself, as link previews already are, and the checks must name servers by names only the proxy knows (`names` in `socks-proxy.ts`). It also means a relay on loopback for the Swift SDK's signalling (step 8) isn't sent through the proxy, which is what that needs.
- **WebKit on macOS takes the proxy,** set on a data store's `proxyConfigurations` from Network's C functions, as the native app does: a page at a name only the proxy knows loaded through it, signed in. In an app, App Transport Security refuses plain HTTP to a name with a dot before the proxy is asked, so a check's fake player goes by a name without one, which it lets through.
- **What the system takes around a proxy, tried further for step 7,** on macOS 27 again, with an `NWConnection` and a `URLSession` to each address and the test proxy writing down what it was asked for: `localhost`, 127.0.0.2 and this Mac's own address went straight there, and the proxy was never asked; so did nothing for 169.254.1.1, fe80::1 and fd00::1, which had no route here and so never connected either way. The proxy was asked, by name, for a name without a dot, one in `.local`, `.test` and `.home.arpa`, and for `zuna-check.localhost`, and by address for 10.255.255.1, 192.168.250.250, 172.16.5.5, 100.64.1.1, 203.0.113.5, and other addresses on this Mac's own network, its router and broadcast address among them. So the iPhone app refuses, under a proxy, `localhost`, the loopback, link-local and unique local addresses, and the device's own (`goesAround` in `ZunaHost/NetworkProxy.swift`), and nothing else. Its checks name servers `zuna-<port>.localhost`, which the core takes over plain HTTP and only the proxy knows, and for which the apps' App Transport Security now has an exception, as it refuses plain HTTP to a name with a dot that isn't in `.local`.
- **LiveKit's Swift SDK takes a `ws://` address on loopback,** an endpoint of the app's own with a secret in its path, for its socket, its join request in that address and its token in the `Authorization` header, which the endpoint passes on. Its validation after a failure is an HTTP request to the same endpoint, which asks LiveKit through the proxy. The SDK has no STUN servers of its own: what it uses are those the join's answer names, which the rewriter takes out.
- **libwebrtc in the iPhone app reaches a relay on loopback,** over UDP and TCP, in the simulator, which shares the Mac's network and kernel (`ZUNA_TEST_SOCKS=1 npm run test:ios:voice`). A real iPhone wasn't tried.
- **WebView2, and NordVPN** weren't tried: the first needs Windows, and the second NordVPN's credentials, from the environment.

## What changes with it

In the commit that makes each true:

- `SECURITY.md`: the Network row, and what a proxy does and doesn't hide.
- `docs/SECURITY_DETAILS.md`: a section on the proxy, and link previews' rule under one.
- `docs/SEALED_SENDER.md`: under what a server can still tell, that the address is the proxy's with one set, and still the same for both.
- `docs/SELF_HOSTING.md` and `docs/LINUX.md`: that 7881/tcp is what members behind a TCP-only proxy use, and the shared limits.
- `docs/BOTS.md`: `--proxy`.
- `docs/WEB.md`: that the web app follows the browser's proxy, and that calls there may not.
- `apps/site`: the privacy page, where it says who sees an address.
- `packages/core/src/export.ts`: the "Your IP address" row.
- `.agents/FEATURE_PARITY.md`: a row for each platform, the web under "Not possible or pointless there", and a Known gap for whichever of the desktop and the iPhone comes second.
- `CLAUDE.md`: under "What has to change together", that a new LiveKit SDK means the rewriter's list of messages, and that anything new that opens a connection takes the proxy. Under "Decisions to keep", that a proxy carries everything or nothing.

## Left out

- **Sealed requests on a route of their own,** as above.
- **Tor's separate circuits,** `.onion` servers, and Tor built in.
- **HTTP proxies,** and following the system's proxy settings.
- **A proxy for one server only.**
- **The web app,** and with it TURN on deployments.
- **A proxy for the server itself,** such as for what `zuna-web` fetches.

## Where it stands

On 2026-11-13: steps 2 to 9 are built, step 6 on macOS alone.

- **Core:** the test proxy and recorder (`packages/core/test/socks-proxy.ts`), `ZUNA_TEST_SOCKS=1`, under which the whole suite passes with every server reached by a name only the proxy knows, and the rewriter (`voice-relay.ts`) with its tests on a real LiveKit's messages.
- **Desktop:** the setting, its dialog and Check, `host/net.rs` and `host/socks.rs`, link previews' rule, calls through relays (`voice/proxy.rs`, with the rewriter in a QuickJS context of its own, `host/relay.rs`), and on macOS Watch's web view through the proxy (step 6's part for macOS), all checked on macOS by `proxy-check.mjs`. Not built on Windows or Linux, where Watch is refused under a proxy.
- **iPhone and iPad:** the setting, its screen in Privacy and on the first screen, and Check (`Settings/ProxySettingsView.swift`), kept in the App Group and the shared keychain group (`Shared/ProxyStore.swift`) so the notification and share extensions read it before their cores start; every `URLSession` through the system's SOCKS5 and made again when it changes, the socket's parameters, the push relay, link previews by name and address alone, and nothing where the system would go around it (`ZunaHost/NetworkProxy.swift`); "Can't reach the proxy" and "The proxy refused the password" from asking the proxy itself (`AppModel.probeProxy`); calls through an endpoint on loopback and relays (`ZunaHost/CallProxy.swift`), with UDP associations from a SOCKS5 client of the app's own (`Socks.swift`) and the rewriter in a JavaScriptCore context of its own (`VoiceRelay.swift`), named in the stream stats; and Watch's data store. Checked with `ZUNA_TEST_SOCKS=1`: `npm run test:ios` (cross-client, the host on macOS, a server's door failing on anything that went around the proxy), `npm run test:ios:voice` in the simulator, a voice channel with cameras and screens both ways over UDP, again over TCP with UDP refused, and a call, and `swift test`'s `ProxyTests`. Not on a real iPhone.
- **`zuna-bot`:** `--proxy` (`apps/bot/src/socks.ts`), with `apps/bot/test/proxy.test.ts`.
- **Not built:** step 6 for Windows and Linux, and step 11 (NordVPN).

Before any of it, what was read: `apps/desktop/src/host`, `plugins/net.rs` and `platform/updates.rs`; `ZunaHost` and the iPhone app's extensions; `apps/bot/src/host.ts`; `livekit` 0.10.0, `livekit-net` 0.1.4, `livekit-signaling` 0.1.9 and `webrtc-sys` 0.3.53 with the headers of its libwebrtc; LiveKit's Swift SDK 2.19.0; and `deploy/docker-compose.yml`. The names of Apple's and WebKitGTK's proxy settings are from memory, and are checked in step 1 with the rest.
