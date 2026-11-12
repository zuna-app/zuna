# Keeping people out of the media server's log: plan

LiveKit, the media server for voice channels and calls, writes what it learns about each person who joins to its log, and has no setting that stops it. This page is what was found, what was decided, and the order to build it in. "Where it stands" at the end says what's built: on 2026-11-12, nothing.

## What's wrong

At its default level, INFO, LiveKit writes three lines for each join. `.dev-data/server.log` has them after a call on a test server:

- **`starting RTC session`** carries all of `participantInit`: the app's `Client` details and the whole SDP offer.
- **`participant active`** carries `publisherCandidates`, every address the device offered, those of its local network in full and its public one with the last part masked, and `clientInfo`.
- **`participant closing`** carries `clientInfo` again.

`clientInfo` holds the system's name and version and the device's model, which on a PC is the motherboard's. Nearly every line also names `participant`, which is `userID.deviceID`, and `room`, which is the channel's or conversation's ID, so the log says who was in which room with whom, and when.

It comes from three places, and each is closed by itself:

1. **The app sends** its system and model, which the server doesn't need.
2. **The Zuna server passes on** the caller's address, in `X-Forwarded-For`.
3. **LiveKit writes down** all it was given.

Three more things of the same kind turned up, and are in this plan too:

- **Outside STUN servers.** LiveKit tells every app to ask Twilio's and Google's STUN servers for its own address, so each device joining voice shows them its address.
- **Zuna's own programs.** `net/http` writes a caller's address to the journal by itself, and one log line of the server's holds a path with IDs in it.
- **The proxy's logs.** The nginx and Apache sites the installer writes keep the distribution's access log, which the docs say not to keep.

## What it's for, and what it isn't

The aim: a LiveKit installed from `deploy/` writes nothing that points at a person or their device, at any log level, `debug` too, and whatever its config says.

That's against keeping by accident: a log that's later read, backed up, leaked or taken. It's not against a server's admin who sets out to learn these things, who can watch the network beside LiveKit. Against them only what the app doesn't send helps, which is why the app's part comes first. An app can't check which LiveKit a server runs either: whatever a patched one could prove, a changed one could too.

## Decided

- **A patch, not a fork.** LiveKit is built from its pinned commit with a patch of Zuna's applied, as `webrtc-sys` is. A fork that removes log lines one by one is a list of what's forbidden, and each LiveKit release could add a line nobody notices. The patch is a list of what's allowed, in the one place every line passes.
- **Built from source on each server,** as `zuna-server` already is: `deploy/update.sh` installs Go and builds there, and the Docker setup builds from the checkout. Nothing is published.
- **Both of the proxy sites' logs go:** the access log, and the log of requests' errors, where nginx writes the caller's address and the whole request line when the server behind it fails.
- **Proposed, and not confirmed yet:** `participant` and `room` leave the log too, which is stricter than addresses and models alone. LiveKit's own IDs stay (`roomID`, `participantID`), made up for each session, so one session's lines can still be told from another's.

## 1. LiveKit, built with Zuna's patch

### The log

**Where.** Every field and every message of LiveKit's log goes through one `zapcore.Encoder`, held in `zaputil.Encoder.enc` in the module `github.com/livekit/protocol` (v1.53.1-0.20261023175527-46332a036e25 for LiveKit v1.13.11), at `logger/zaputil/zaputil.go:43-58`. Fields get there three ways, and all three end in it:

- `WithValues`, which encodes into a copy of the encoder at once (`encoderWithValues`, line 22);
- `Core.With`;
- `Core.Write`, which is where `Infow` and the rest arrive, with what `WithUnlikelyValues` and `WithDeferredValues` added.

So do pion's messages, which `logger/pionlogger/zaplogadapter.go` formats into the message's text, values and all, and `slog` and the standard `log` package, which `InitFromConfig` points at this logger (`logger/logger.go:40`). LiveKit sets no `http.Server.ErrorLog`, so `net/http`'s own errors come this way too.

**Wrap the encoder, not the core.** A core that filters fields sees only `With` and `Write`: it misses `WithValues`, its `Check` has to be written or `Write` is skipped, and zap's `encodeError` adds `errorVerbose` and `errorCauses` beside an error. A wrapped encoder has none of that to get wrong.

**The patch** is a new file, `logger/zaputil/zuna.go`, and four lines of `zaputil.go`: `enc` becomes a `zunaEncoder`, so no constructor can leave the filter out, and a change of LiveKit's there stops the build rather than taking it off unseen.

```go
// inner is a named field, not embedded, so a method zap adds later breaks the build
// instead of passing through. It must not implement logger.SensitiveObjectEncoder.
type zunaEncoder struct{ inner zapcore.Encoder }

func (e zunaEncoder) Clone() zapcore.Encoder { return zunaEncoder{e.inner.Clone()} }

func (e zunaEncoder) EncodeEntry(ent zapcore.Entry, fields []zapcore.Field) (*buffer.Buffer, error) {
	ent.Message, ent.LoggerName = zunaScrub(ent.Message), zunaScrub(ent.LoggerName)
	if len(fields) == 0 {
		return e.inner.EncodeEntry(ent, nil)
	}
	c := zunaEncoder{e.inner.Clone()} // inner would add the fields to itself, past the filter
	for i := range fields {
		fields[i].AddTo(c)
	}
	return c.inner.EncodeEntry(ent, nil)
}
```

```diff
 type Encoder struct {
-	enc zapcore.Encoder
+	enc zunaEncoder
 }
-	return Encoder{zapcore.NewConsoleEncoder(zap.NewDevelopmentEncoderConfig())}
+	return Encoder{zunaEncoder{zapcore.NewConsoleEncoder(zap.NewDevelopmentEncoderConfig())}}
-	return Encoder{zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig())}
+	return Encoder{zunaEncoder{zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig())}}
-	e.enc = encoderWithValues(e.enc, kvs...)
+	e.enc = encoderWithValues(e.enc, kvs...).(zunaEncoder)
```

**What it lets through:**

- **Keys on the list, and no others.** A key nobody listed is dropped, so a field a later LiveKit adds doesn't pass until someone decides it may.
- **Plain values only,** even under a listed key: numbers, booleans, times, durations, strings and errors, and named types of those, which `zap.Any` hands to `AddReflected` and are told by `reflect.Kind`. Objects, arrays, bytes and namespaces are dropped, so `AddObject`, `AddArray`, `AddBinary`, `AddByteString` and `OpenNamespace` do nothing.
- **Text is cleaned:** the message, the logger's name and every string let through, an error's text included. Addresses go, found by splitting into runs of `[0-9A-Fa-f.:]` and asking `netip.ParseAddr`, not by a pattern, which would take clock times and version numbers for addresses. So does any run of 32 or more hex characters, which is what Zuna's account, device and channel IDs look like. Loopback and unspecified addresses stay.
- **Kept:** LiveKit's own IDs (`roomID`, `participantID`, `pID`, `trackID`, `connID`) and what says how a session went (`reason`, `error`, `state`, `transport`, `mime`, `kind`, durations, `version`, ports, `load`). The server's own `nodeIP` in its first lines stays as it is, since `docs/LINUX.md` tells admins to read there which address LiveKit found.
- **Dropped,** among the rest: `room`, `participant`, `clientInfo`, `participantInit`, `publisherCandidates`, `subscriberCandidates`, `candidate`, `offer`, `answer`, `request`, `response`, `country`.

Make the list from a real log at `debug`: the sample has 118 keys. One name can mean two things in two places, so read each key's uses before listing it.

**Beside the logger,** in the same patch:

- **Panics in a request.** `negroni.NewRecovery()` in `pkg/service/server.go:486` prints a handler's panic straight to stdout. Give it the logger.
- **Ways around the encoder.** `WithTee`, `ToZap` and `FromZapLogger` are the only ones, and LiveKit's `pkg` and `cmd` use none of them today. The build fails if one appears.
- **Not covered:** the stack Go writes by itself when the whole process dies.

**Its test** is in the patch too, `cmd/server/zuna_log_test.go`, in LiveKit's own module rather than the copied one: it puts a pipe in `os.Stderr`'s place, starts the logger at `debug` in both the JSON and the console format, sends made-up identities and addresses down every way above, and fails if one comes out, if a key isn't on the list, or if `pID` is missing, which would mean it checked nothing.

### STUN

`pkg/service/roommanager.go:1155-1157`: with no TURN and no `rtc.stun_servers`, LiveKit gives apps `rtcconfig.DefaultStunServers`, which are Twilio's and Google's. No config turns that off, as an empty list is what brings the default.

```diff
 	if !hasSTUN {
-		iceServers = append(iceServers, iceServerForStunServers(rtcconfig.DefaultStunServers))
+		_ = rtcconfig.DefaultStunServers // Zuna: apps are given no outside STUN servers
 	}
```

Deleting the block doesn't compile: `hasSTUN` would be set and never read, and `rtcconfig` is imported for that line alone.

Apps still connect, as it's the app that starts the connection, to the address the server gave, and the server learns the app's from what arrives. LiveKit isn't ICE-lite unless `use_ice_lite` is set, which Zuna doesn't, and a full pion agent learns a caller the same way. LiveKit's Rust and JavaScript SDKs take an empty list without an error, and neither app sets ICE servers of its own. Read from the code, and not run.

The server finding its own address (`use_external_ip: true`) still asks those servers, which shows them the server's address and nobody else's. It stays, and so does the list.

This is a commit of its own, so that it can be taken back alone.

### Building it

A new folder, `deploy/livekit/`, as the installer and its check see only `deploy/`:

- **`version`** holds the tag and its commit, `v1.13.11 385aa40f9292fe1db8caad87301e4b285b7c198a`, in one place instead of today's four (`LIVEKIT_TAG` in `scripts/lib.mjs`, `LIVEKIT_VERSION` and its checksums in `deploy/update.sh`, and the image in both compose files).
- **`zuna.patch`** is everything above.
- **`build.sh <output>`** does this:
  1. fetches that commit and no other, as a tag can be moved: `git init`, `git fetch --depth 1 https://github.com/livekit/livekit <commit>`, `git checkout FETCH_HEAD`, then checks `git rev-parse HEAD`;
  2. copies the protocol module out of Go's module cache, where `go.sum` has checked it (`go list -m -f '{{.Dir}}' github.com/livekit/protocol`), to `./zuna-protocol`, and points at it with `go mod edit -replace`;
  3. applies the patch with `git apply`, and checks it reached what it was for;
  4. builds: `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -buildid= -X main.zunaPatch=<the patch's hash>" ./cmd/server`, with `GOTOOLCHAIN` set, as LiveKit's `go.mod` names no toolchain.
- **`Dockerfile`** builds with `build.sh` on the `golang` image `server/Dockerfile` pins by its digest, and ends on an `alpine` pinned the same way: the entrypoint in `docker-compose.yml` needs `/bin/sh`, `sed` and `/livekit-server`.

**The binary says what it is.** `--version` gives `1.13.11-zuna.<12 characters of the patch's hash>`, from a `zunaPatch` variable the patch adds to `cmd/server` and the `Version:` of its command line (`main.go:187`). `deploy/update.sh:458` already compares all of `--version`, so a changed patch gets built and installed by itself, and going back to `.previous` stays right, which a stamp file beside the binary wouldn't. Leave `version.Version` alone: it's what the server tells apps, and LiveKit's JavaScript SDK compares it.

**What else changes:**

- **`deploy/docker-compose.yml` and `deploy/docker-compose.proxy.yml`:** `build: context: ./livekit` in place of `image:`.
- **`deploy/update.sh`:** `fetch_livekit` becomes a build with `build.sh`, as the build account (`as_builder`), the way `zuna-server` is built.
- **`scripts/lib.mjs`, `ensureLiveKit()`:** the same steps in Node, so that they run on Windows too, with the commit and the patch read from `deploy/livekit/`, and `<binary>.tag` holding the commit and the patch's hash, so that a changed patch builds the development binary again. `dev-server.mjs`, the checks in `apps/desktop/test`, `apps/web/test/web-check.mjs` and `tests/e2e` call it and need no change.
- **Not `deploy/zuna-livekit.service`,** as the binary is still plain Go, **and not LiveKit's config** (`LIVEKIT_CONFIG`, `livekit.yaml`): the filter works at every level, so no server's settings have to be moved.

**What was tried on paper and doesn't work:**

- **`go build -overlay`** may not replace files in the module cache.
- **`go mod vendor`** works, but fetches LiveKit's test and tool dependencies and copies the whole tree. The copied module is 6.6 MB.
- **GitHub's archive of a commit** isn't the same bytes each time, so it can't be pinned by a checksum.

### Before this is committed: memory on a small server

Building LiveKit should take 1 to 1.5 GB of memory and 10 to 25 minutes on one core, with about 2 GB of disk for Go's caches. That's a guess from the code's size, not a measurement.

Measure `build.sh` first, with `-p 1` and `GOMEMLIMIT`, under `/usr/bin/time -v`. Then:

- **It fits in 1 GB:** `update.sh` checks free memory before it starts, and stops before changing anything if there isn't enough.
- **It doesn't:** stop, and bring the numbers to the maintainers. The choice is then between refusing to update such a machine and building binaries on CI after all. An unfiltered LiveKit is never kept as a quiet fallback.

## 2. The native app sends no system or model

**What.** `livekit-signaling` 0.1.9, `src/lib.rs:1152-1153` in `get_livekit_url`, reads `os_info::get()` and `device_info::device_info()`, which on Linux is `/sys/class/dmi/id/product_name`, on Windows `SystemProductName` in the registry and on macOS `hw.model`. It sends them both ways it connects: inside `join_request`, which is the one used, as `single_peer_connection` is on by default, and as `os`, `os_version` and `device_model` in the address. The patch puts empty strings in place of those two lines, and takes both dependencies out of the crate's `Cargo.toml`, as nothing else in `Cargo.lock` uses them. What the protocol needs stays: the SDK's name and version, the protocol's version, and what the app can do.

**How.** `webrtc-sys`'s way, for a list of crates:

- **`scripts/webrtc-sys.mjs`** takes an entry for each crate, its name, version, SHA-256, patch and the marks that show the patch reached it, and goes through them. `ensureWebrtcSys(depsDir)` keeps its name and prepares both, so the scripts that call it and `coverage.yml` stay as they are.
- **`apps/desktop/patches/livekit-signaling.patch`** is new. `.gitattributes` already covers it.
- **`apps/desktop/Cargo.toml`:** `livekit-signaling = { path = ".deps/livekit-signaling" }` under `[patch.crates-io]`, and `Cargo.lock` with it.
- **A test in `apps/desktop`:** a socket on this machine takes `Room::connect`, reads the request, and finds `os`, `os_version` and `device_model` empty in `join_request`. It checks what goes out, on whichever system `cargo test` runs.

**iOS** isn't closed here. LiveKit's Swift SDK 2.19.0 sends `os`, `os_version`, `device_model` and `network`, and has no switch for it. The address is built by a Swift function, so it can't be reached through the Objective-C runtime as `Voice/LiveKitPins.swift` reaches the socket's delegate. It would take a fork of the SDK, which Zuna has kept from so far, or an option upstream. It goes in Known gaps.

**The web** sends neither by itself (`livekit-client` 2.23.0). The browser adds its `User-Agent`, which a page can't take off, and which LiveKit reads the browser and system from. That's `n/a`.

## 3. The Zuna server

**The proxy to LiveKit,** `liveKitProxy` in `server/internal/api/voice.go:193-199`:

- **Stop setting `X-Forwarded-For`.**
- **Take `CF-Connecting-IP` and `X-Real-IP` off what goes on,** as LiveKit's `GetClientIP` reads them before the connection's own address. `ReverseProxy` with `Rewrite` already drops `Forwarded` and the `X-Forwarded-` headers.
- **Leave `User-Agent`:** LiveKit's rules for codecs go by the browser, Safari's and Firefox's among them.
- **Nothing is lost.** LiveKit uses that address for `ClientInfo.Address` and for agents, which Zuna doesn't run (`GetClientIP` is called from `utils.go`, `agentws.go` and `agentwt.go` alone).
- **The test:** `TestAppsCanReachTheMediaServerThroughThisServer` in `server/internal/api/channels_test.go:325` sends those headers and finds none of them at the fake LiveKit.

**What Zuna's programs write themselves:**

- **`net/http`'s errors.** No `http.Server` sets `ErrorLog`: not `cmd/zuna-server/main.go` (232, 266), `cmd/zuna-web/main.go` (166, 191) or `cmd/zuna-push/main.go` (84). So `net/http` writes lines such as `http: TLS handshake error from <address>` to the journal wherever the program ends TLS itself, which the Docker setup and `--domain` do. One logger for all five that takes the addresses out, with a test.
- **A panic's path.** `server/internal/api/server.go:571` logs `r.URL.Path`, which has channels' and people's IDs in it. Log the route's pattern, `r.Pattern`, as `respond.go:110` does.

## 4. The proxy sites the installer writes

In `deploy/install.sh`, in every server block it writes, on port 80 and on 443:

- **nginx** (`nginx_site`, `nginx_proxy`): `access_log off;` and `error_log /dev/null;`.
- **Apache** (`apache_site`, `apache_proxy`): `CustomLog /dev/null` with a format of its own, and `ErrorLog /dev/null`. A `CustomLog` in a virtual host is what keeps the server's own log from taking its requests.
- **Caddy** writes no access log without `log`. Read in Caddy's source, before changing anything, whether it writes the caller's address and the request's path when it answers with a 5xx, and turn that off for the site if it does.
- **The proxy's own log** of starting and of its config stays.

With it, as `CLAUDE.md` asks: the examples in `docs/SELF_HOSTING.md` (107-133) and `docs/LINUX.md` (118-176), and the advice at `SELF_HOSTING.md:96` and `LINUX.md:111`, which today is about `/api/sealed/` alone and should be about the whole site and its error log, as `/livekit/`'s address carries the voice token.

A site an older installer wrote only changes when `install.sh` runs again. The docs should say so.

## 5. The docs and the tables

- **`docs/SECURITY_DETAILS.md:165`, "What they do see", and a sentence at `SECURITY.md:122`:** LiveKit sees each device's addresses, its local network's too. The native app sends no system or model, the iPhone does, and a browser sends its `User-Agent`. A LiveKit from the installer keeps none of it in its log, and one run by hand from LiveKit's own release does.
- **`docs/LINUX.md:6`,** which says LiveKit isn't built, and 251-274, **`docs/SELF_HOSTING.md:230-234`** and **`CONTRIBUTING.md:79`:** LiveKit is built from a commit with a patch, how much memory that takes, and what running it by hand means.
- **`CLAUDE.md`:** a row in "What has to change together" for LiveKit's version (`deploy/livekit/version`, the patch made again, the list of keys and its test), `livekit-signaling` in the Rust SDK's row, and a line in Gotchas.
- **`.agents/FEATURE_PARITY.md`:** a Known gap for iOS, saying what goes to the media server and what would close it, `n/a` for the web, and a note in the native app's voice row.
- **`apps/site`:** nothing, as no new claim is made there.

## The order

Each a small commit on `main`, pushed once its checks pass:

1. `server:` the proxy passes on no caller's address.
2. `server:` the Go programs' own logs hold no addresses.
3. `desktop:` the patch to `livekit-signaling`, with the Known gap for iOS and `CLAUDE.md`'s row.
4. `deploy:` LiveKit built from its commit with the log's patch: `deploy/livekit`, `scripts/lib.mjs`, both compose files, `update.sh`, the checks, and the docs about building it. After the measurement above.
5. `deploy:` the STUN patch.
6. `deploy:` the proxy sites keep no logs.
7. `docs:` what the media server sees, and what its log keeps.
8. A nightly, as the third changes the native app: a patch.

## Checking it

- **The server:** `go test ./internal/api -run TestAppsCanReachTheMediaServerThroughThisServer`, then `npm test` and `npm run typecheck`.
- **LiveKit:** `deploy/livekit/build.sh` into a folder to throw away, the patch's own test (`go test ./cmd/server -run Zuna` in the patched tree), and the new `ensureLiveKit`.
- **The log, end to end.** `apps/desktop/test/linux-voice-check.mjs` and `apps/web/test/web-check.mjs` already hold LiveKit's output in memory, and start it with `--dev`, which is `debug`. Both get one check at their end: no line has a key that isn't on the list, and nowhere in the output is one of this machine's addresses, the name in `/sys/class/dmi/id/product_name`, the system's name, an account's or a channel's ID from the run, or the words `candidate` and `sdp`. `participantID` has to be there, so that an empty log doesn't pass. Lines from the standard `log` package have no logger's name, so don't pick lines by it. This is what guards each later LiveKit version.
- **The native app:** `node scripts/webrtc-sys.mjs`, `cargo test` in `apps/desktop` with the new test of what goes out, and a build on the system at hand. Say in the commit which systems weren't built.
- **STUN:** both voice checks pass with no ICE servers given.

**What needs something a Linux desktop alone doesn't have:**

- **A real network.** Voice without STUN from behind a phone network's address translation, over the TCP port, and from a browser that wasn't allowed the microphone, which offers no address LiveKit can use, can only be tried against a server on the internet. A server at home whose ports 7881 and 7882 aren't forwarded, and which works today because of STUN, will stop connecting.
- **Lima and expect,** for `deploy/test/install-check.sh` after `update.sh` and `install.sh` change, and **Docker,** to build `deploy/livekit/Dockerfile`. Its virtual machines and every check's first run will build LiveKit, which takes a while.
- **A Mac,** for anything in Swift. Nothing here changes the iPhone app.

## Left out

- **Local addresses still reach LiveKit,** in the candidates an app offers, though no longer its log. Not sending them would take a change in each app's SDK.
- **The first update of every server with voice builds LiveKit and restarts it,** which ends the calls in progress, as any new LiveKit version does today.
- **An admin who sets `rtc.stun_servers`** still has those servers given to apps.
- **`/debug/` on LiveKit's port,** which lists rooms and is there only with `development: true`, which nothing in `deploy/` sets. `/livekit/` on the Zuna server passes every path on, so a development server shows it.

## Where it stands

Nothing is built. Everything above was read from the code: LiveKit v1.13.11, its protocol module, zap 1.28.0, `livekit-signaling` 0.1.9, LiveKit's Swift SDK 2.19.0 and `livekit-client` 2.23.0. No patch was written and nothing was compiled or run, so each number of a line is where to look, and each claim that something works is still to be shown.
