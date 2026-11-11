# Post-quantum cryptography

A large enough quantum computer would break X25519, Ed25519 and P-256, which were all of Zuna's public-key cryptography, and whoever records what's sent today, or keeps a copy of a server's data, can open it once one exists. This says what was done about it, how, why, what it costs, and what it doesn't do, for whoever changes it next. It was planned and built on 2026-11-11, and replaces the plan it was built from (`POST_QUANTUM_PLAN.md`, in git history), whose stages it follows.

[SECURITY.md](../SECURITY.md) says in plain words what it promises, and [SECURITY_DETAILS.md](SECURITY_DETAILS.md) says it in full. Read both, and [ARCHITECTURE.md](ARCHITECTURE.md), before changing any of it. **No independent cryptographer has reviewed it.** "Questions for a reviewer" below is where to start.

## What it does

- **Nothing sealed to a public key can be opened by a quantum computer later.** Keys are agreed with X-Wing, ML-KEM-768 (FIPS 203) and X25519 together, in MLS and in Zuna's own sealing alike: welcomes, the tree's path secrets, external joins, an account key sealed to its password's and recovery key's slots and to each device, and history grants. Breaking one takes breaking both.
- **Every signature an app checks takes forging Ed25519 and ML-DSA (FIPS 204) both:** identity keys, devices' keys inside MLS and outside it, slots' signing keys, a bot's setup key, and the server's log of keys.
- **Updates are signed with ML-DSA-65 too,** in a file of their own that builds from before don't read, so every installed build still updates.
- **Connections agree on keys with X25519MLKEM768 first,** where both ends know it, and with X25519 where one doesn't: the desktop app, the chat server and `zuna-web` on their own TLS, browsers, iOS from 26, Node, and proxies new enough.
- **What's symmetric stays as it was:** content, files, the vault and what a device stores are under 256-bit keys, hashes are SHA-256 and SHA-384, and passwords are stretched with Argon2id.

## How it works

### Hybrid signatures

`crypto/src/hybrid.rs`, and `server/internal/hybrid` for what the server checks or signs.

| | A device's key | A lasting key |
|---|---|---|
| For | Everything a device signs: MLS leaves, key packages, commits and group infos, envelopes, rosters, details, grants, seal proofs, request proofs | Identity keys, slots' signing keys, a bot's setup key, the server's log key |
| Algorithms | Ed25519 and ML-DSA-44 | Ed25519 and ML-DSA-65 |
| Public key | 1,345 bytes | 1,985 bytes |
| Signature | 2,485 bytes | 3,374 bytes |

- **A secret is a kind and a 32-byte seed.** Each algorithm's own seed is `HKDF-SHA-256(seed, "zuna/hybrid-key/v1|kind|algorithm")`, so one found, as a quantum computer could find Ed25519's scalar, tells nothing of the other, and a seed of one kind makes no key of the other. Keys stay 33 bytes wherever they're kept, and a bot's setup link carries a seed.
- **A public key is the kind and both public keys, a signature the kind and both signatures.** Both sign `"zuna/hybrid-sig/v1" | kind | SHA-256(public key) | message`. No other signature in Zuna starts with that label, so neither half is a signature of anything on its own, and the key's hash binds each half to its partner: a half lifted from a pair is no signature under any key, the plan's first question for a reviewer.
- **A check takes both,** Ed25519's strictly (no small-order keys or non-canonical signatures) and ML-DSA's with an empty context, and runs both whatever the first gives. `verify` takes no other shape of key, Ed25519 alone above all, and the core checks a key's kind where it comes in (`isDeviceKey`, `isLastingKey`): in a certificate, a link, the log, a head.
- **ML-DSA signs hedged,** randomness with the message, as FIPS 204 recommends against faults and timing. OpenMLS's own provider signs deterministically.
- **The same functions as before.** `sign`, `verify`, `signingKeygen` and `signingPublic` keep their names and arguments, so the desktop's QuickJS host, the iOS bridge and the WebAssembly build changed nothing but what's behind them: `sign` and `signingPublic` take a hybrid secret, or a bare 32-byte Ed25519 seed for the two keys below, and `signingKeygen` makes a device's key. Lasting keys are made from a seed in the core (`newLastingKey`).
- **Two keys stay Ed25519 alone,** which only the server checks: a group's send key and the item keys of sealed sending ([SEALED_SENDER.md](SEALED_SENDER.md)). This is the plan's decision 4: forging either takes a copy of the server's data, a quantum computer and an account, to post what no app shows or drop the server's own copy of a message, which the server could always do, and making them hybrid would add 2,420 bytes to every sealed request.
- **Three implementations agree.** Rust's (RustCrypto's `ml-dsa` and `ed25519-dalek`), Go's (Cloudflare's `circl` and the standard library) and, for ML-DSA-65 alone, Node's (OpenSSL 3.5) are held to vectors each makes and the others check (`crypto/src/testdata/hybrid-rust.json`, `hybrid-go.json`, `ml-dsa-node.json`), and ML-DSA's key generation to NIST's own known answers.

### MLS

- **One suite:** `MLS_128_MLKEM768X25519_CHACHA20POLY1305_SHA384_MLDSA44`, 0x0052 in draft-ietf-mls-pq-ciphersuites, behind the `draft-ietf-mls-pq-ciphersuites` feature of OpenMLS's traits and RustCrypto provider (`crypto/src/mls.rs`). `openmls`'s own feature of that name is left off: it only adds the suites to a leaf's default capabilities, which `mls.rs` always sets, and names its optional SQLite storage, which put a second SQLite in the desktop app's dependencies. Its key agreement is X-Wing. Its signature scheme is ML-DSA-44 by the draft's code point, and here it means a device's hybrid key: a crypto provider of Zuna's own wraps RustCrypto's, and its `sign` and `verify_signature` are `hybrid.rs`. OpenMLS checks every signature through `verify_signature`, so every leaf in every tree, every key package, commit, group info and welcome's group info takes forging both, and one signed with ML-DSA alone, as plain OpenMLS would, or Ed25519 alone, isn't taken.
- **Not quite what the plan said.** It had the suite sign with ML-DSA-44 alone and the device's Ed25519 signature travel beside each key package, commit and group info, kept by the server and checked before OpenMLS saw them. That leaves leaves inside a tree, and what a member puts in its own commit, with one signature (the plan's questions 2 and 3), and needs a path of its own through the server. The composite inside the suite covers every signature MLS makes, and needs nothing from the server. The cost is that 0x0052's signatures aren't what the draft means by them, which only matters to something other than Zuna reading its groups, and nothing does.
- **Nothing of another suite is taken.** The provider supports this suite alone, so OpenMLS refuses any other at creation, welcome, external join and key package, and `parse_key_packages` checks too. The server refuses a key package, welcome or group info of any other (`mlsSuite` in `server/internal/api/mlsframe.go`), so no group goes on in one a recorder could open.
- **The exporter's labels and lengths are as they were,** so content, send and voice keys are made as before, now from secrets a quantum computer can't recover from what the server keeps. The suite hashes with SHA-384, and the exporter still gives 32 bytes (question 8).
- **A leaf's credential is still the device's certificate,** where the plan had it shrink to the account, the device and the certificate's hash, with the certificate itself from the list of people. That would make whether a leaf is genuine depend on the server handing that certificate over: a leaf whose certificate can't be had stays in the tree as unchecked, able to read, where today a leaf's certificate is checked on its own against the identity chain and the log, and one that doesn't hold is removed. That check has been through three audits, and this keeps it as it is. The certificate became bytes instead of JSON in base64 in JSON (`createCertificate`), 4.8 KB in place of about 7, and a leaf costs about 4.6 KB more than with a hash. "What it costs" has the numbers.

### Sealing

- **HPKE is X-Wing with HKDF-SHA-256 and ChaCha20-Poly1305** (`HPKE_CONFIG` in `crypto/src/primitives.rs`). A public key is 1,216 bytes, and a secret stays the 32-byte seed X-Wing makes it from. A slot, a device's seal key and an account's HPKE key, which grants are sealed to, are all X-Wing, under new labels: `zuna/account-slot/v2`, `zuna/account-bundle/v2` and `zuna/history-grant/v3`.

### Identity, certificates and the log

- **Identity keys are lasting keys,** made together, sealed in the vault's core together and replaced together by a rotation. Certificates, links, a profile's signature and the HPKE key's signature are theirs, and the server checks a link's signatures as hybrid ones.
- **The emoji check hashes both people's whole identity keys** under `zuna/safety/v3`, so its golden value changed once, for every platform, as there's one implementation.
- **The log's key is a lasting key** the server makes from a seed it keeps, and a head is signed under `zuna/log/head/v2`. The shared vectors were written again (`UPDATE_LOG_VECTORS=1`), and as ML-DSA signs hedged, they hold the head's signature to the key rather than to bytes. An invite link carries `SHA-256("zuna/log/key/v1|" | key)` in place of the key, so it doesn't grow by two kilobytes, and whoever signs up through it takes the key the server gives their new session only if it has that hash.
- **A bot's setup link** carries the 32-byte seed of a lasting key, and a hash of its owner's identity key (`zuna/bot-owner/v1`), which the bot holds the key the server lists for its owner to as it signs up, and pins.
- **Request proofs** are a device's hybrid signature, 3,316 characters of base64 in `X-Zuna-Proof`: under the 8 KiB a header nginx and Apache take, so they stay in the header. The server remembers proofs it has seen by their hash.

### Updates

The plan's stage 2 for updates, as `docs/RELEASES.md` and "Updates" in `SECURITY_DETAILS.md` describe:

- A release keeps `update.json.sig`, Ed25519, exactly as it was, and gains `update.json.sig2`, ML-DSA-65 of the same bytes, with an empty context. Builds from before check the first and update as they always did, to a build that requires both, by keys of the same channel (`apps/desktop/src/platform/updates.rs`). A release without the second isn't taken by a new build.
- Four new keys, as the plan's decision 5 recommended: ML-DSA-65, not SLH-DSA, so there's one signature algorithm to bind, test and review. One in use and one spare for each channel, kept as their 32-byte seeds, with the private halves beside the Ed25519 ones offline, the spares' never on GitHub. The release workflow's `publish` signs with `UPDATE_SIGNING_KEY_PQ` on Node 24, whose OpenSSL has ML-DSA, and refuses a key the app at that commit doesn't carry (`scripts/release.mjs`).
- The order is the one `CLAUDE.md` asks for, public keys in the app first, and the first release that carries them can be the first signed with them, as nothing older reads the new file.

### TLS

The plan's stage 1 for connections, preferred and never required (decision 6): a server behind an older proxy still works.

- **The desktop app** moved rustls from `ring` to aws-lc-rs with `prefer-post-quantum`, which offers X25519MLKEM768 first, and installs it as the process's provider, so LiveKit's signalling, which makes its own configuration, agrees on keys the same way (`apps/desktop/src/host/tls.rs`). Its assembly comes built for Windows, so the build needs no NASM, and it needed no CMake either.
- **The chat server and `zuna-web`** speak TLS themselves only without a domain, with their own certificate, or with one given. Go's defaults since 1.24 offer X25519MLKEM768 first, and nothing narrows them, which `server/cmd/zuna-server/tls_test.go` holds the server to with real handshakes.
- **The web app** takes the browser's, which current Chrome, Firefox and Safari have; the iPhone app the system's, from iOS 26, while it runs from iOS 18; `zuna-bot` Node's, on by default from 22.20.
- **Proxies:** Caddy from 2.10, and nginx and Apache where the system's OpenSSL is 3.5 or newer, with no setting to change. `deploy/install.sh` says which it'll be, as "Key agreement" in its summary.

### What the server holds to

It checks the shape of every key it's given as the kind it has to be, and refuses Ed25519 or X25519 ones: identity keys, slots, devices' keys and seal keys, HPKE keys and their signatures, bots' proofs and links' signatures, which it checks (`server/internal/api/post_quantum_test.go`). Its limits grew with what they hold: a sign-up to 256 KiB, a vault core to 64 KiB of its own, a signed reaction, pin or deletion to 5 KiB, a read position, typing signal or played sound to 4 KiB, a channel's details to 16 KiB and a sound's to 12 KiB. A commit's welcome goes up once, for every device it adds (`welcome` and `welcome_to`), where it went up once for each, and a commit may be 64 MiB, so that one adding a person to a group of a few hundred devices fits. A proxy has to pass 64 MiB too, which the installer's sites now allow.

## What the owner chose

The plan's section 10, built as it recommended, the owner having asked for its defaults:

1. **Start again.** Accounts and groups from before can't be used after it: a group keeps the suite it was made with, and an account's keys were the old kind. Test servers start from `npm run dev:clean`. Nothing carries over, so stage 5 wasn't needed first.
2. **Stage 1 first, then 2 and 3 together:** all three were built in one session, so the two cut-overs became one release.
3. **Stage 3 before 1.0.0,** as the numbers below are bearable for a channel of a few hundred devices: a few megabytes a commit, not tens.
4. **Send keys and item keys stay Ed25519,** as `SECURITY.md`'s Limits says.
5. **Update keys are ML-DSA-65.** Their offline copies went where the Ed25519 keys' are.
6. **No app refuses a server whose TLS isn't hybrid.**
7. **1.0.0 doesn't wait for the draft to become an RFC.**

## What it costs

Measured on 2026-11-11 on Windows, natively in release, with `measure_groups` and `measure_groups_before` in `crypto/src/mls/tests.rs`: a group filled by one commit, then devices spread across its tree committing, so that most of its inner nodes are filled. "Before" is the suite and keys of before, under plain OpenMLS, with a certificate of the size it was.

| | 10 devices, before | 10 now | 100, before | 100 now | 1,000, before | 1,000 now |
|---|---|---|---|---|---|---|
| A key package | 593 B | 13.6 KB | 593 B | 13.6 KB | 593 B | 13.6 KB |
| A commit that only updates | 1.2 KB | 22 KB | 1.5 KB | 29 KB | 4.0 KB | 68 KB |
| The group info a commit carries | 6.4 KB | 124 KB | 58 KB | 1.13 MB | 503 KB | 10.1 MB |
| A welcome | 6.5 KB | 124 KB | 58 KB | 1.13 MB | 503 KB | 10.1 MB |
| What a device keeps of the group | 32 KB | 434 KB | 237 KB | 3.8 MB | 1.9 MB | 33.6 MB |
| Making a commit that adds one | 0.6 ms | 5.5 ms | 1.3 ms | 28 ms | 6.3 ms | 234 ms |
| Joining from its welcome | 0.5 ms | 3.2 ms | 4.2 ms | 32 ms | 40 ms | 332 ms |

- **What carries the tree is about twenty times larger.** A leaf is about 10 KB: an X-Wing key, a hybrid device key, its certificate of 4.8 KB with the identity key's signature, and its own hybrid signature. A certificate's hash in its place would make it about 5 KB (above, and "Not done").
- **Every commit carries the group info,** so a member's weekly update in a group of a thousand devices sends 10 MB, about 13.5 MB in base64, and one that adds someone twice that with its welcome, which now goes up once whatever the number of devices it adds. A few hundred devices, decision 3's measure, is a few megabytes a commit. The lever, if that's too much, is still the plan's: the tree kept by the server apart from the group info, with a commit sending only the nodes it changed.
- **A device keeps 33.6 MB for a group of a thousand,** in its database, as OpenMLS's storage writes it. The MLS client keeps at most 4,000 leaves of groups parsed in memory (`MAX_LOADED_LEAVES` in `mls.rs`), a few such groups, where it kept 32 groups of any size. A phone's notification extension follows a group's commits only while its state is under 2 MB, about fifty devices (`MAX_FOLLOWED_STATE` in `push.ts`), past which a notification for a group it's behind in says only that a message came.
- **A device keeps 40 key packages on the server,** 544 KB where it was 24 KB.
- **The shortest message is about 2.9 KB as stored,** where it was about 0.3 KB: an envelope carries a device's signature of 2,485 bytes, and so do a reaction, a read position, a pin, a deletion and a typing signal. A message that carries the sender's head of the log adds a lasting signature, 4.5 KB in base64, at most once a week a conversation.
- **The list of people and the log grow by an account's keys:** a device's certificate is 4.8 KB and its key 1.3 KB, an account's first key 2 KB, its HPKE key 1.2 KB and that key's signature 3.4 KB, before base64. A device signing in reads all of it, so a server of a thousand people with two devices each is, worked out rather than measured, about 30 MB in base64 to read the first time, where it was one or two.
- **Time is small beside size.** In WebAssembly, as the web app runs it, a device's signature takes 1.5 ms and its check 0.3 ms, a lasting key's 1.9 and 0.4 ms, and X-Wing seals or opens in 0.35 ms (Node 24 on the same machine). Natively it's a fraction of that.
- **The desktop app's build** compiles aws-lc as well, with its assembly prebuilt for Windows.

## Not done

- **Voice frames under 256-bit keys.** LiveKit's frame cryptor takes a 128-bit AES key in its native and Swift SDKs, and 256 only in the web's (`keySize` in `livekit-client`, whose own docs say 128 is the only value the others support), so the three can't agree without patching libwebrtc's frame cryptor on every platform, the iPhone's included. The room's key itself comes from the post-quantum MLS exporter. AES-128 isn't known to fall to a quantum computer, with less margin than 256.
- **The server's own certificate as ML-DSA,** for a server without a domain, the plan's stage 4: Go's `crypto/tls`, rustls and iOS can't check one yet. Its key agreement is post-quantum already.
- **Tokens** stay as they are, as the plan's stage 4 read them: who spent one stays hidden whatever an attacker computes, and what a quantum computer would break is the limit they put on a sender, for which there's no post-quantum standard to move to.
- **Stage 5, starting a group again under a new suite.** It's what a second change would need, as a group keeps its suite and OpenMLS moves none: when the draft's code points are given, or OpenMLS drops these ones, or an algorithm falls. Its design is still to be made: a member's device makes a new group for the same conversation and the rest join it by external commit, history stays readable from the vault, epochs go on from where they were, and who may start one, without it being a way to drop members, with the roster carried across under an admin's signature. It can come after 1.0.0, and has to come before anything forces a second change. `docs/ROADMAP.md` lists it.
- **The leaf's credential as a hash,** for the reason above.
- **OpenMLS's libcrux provider**, which the plan's stage 0 had tried beside RustCrypto's: RustCrypto's is what the crate already used, and builds as WebAssembly and natively on Windows, where this was built.
- **A site written by an older installer** allows 2 MB a request, which is enough for groups of up to about fifty devices: `deploy/update.sh` doesn't change a proxy's site, so its owner raises `client_max_body_size` or `LimitRequestBody` to 64 MB, as `docs/LINUX.md` says.

## Tests

- **Rust** (`crypto/src/hybrid/tests.rs`, `crypto/src/mls/tests.rs`, `crypto/src/primitives.rs`), as WebAssembly with `npm run test:crypto` and natively: each kind's sizes; neither half holding on its own, from a broken one, a mixed pair, a spliced key or another kind; a seed making the same keys and each kind its own; ML-DSA's keys against NIST's known answers; the vectors Go made and Node's ML-DSA-65; X-Wing's sizes and that a 32-byte key isn't sealed to; groups and key packages under 0x0052 and every leaf a device's hybrid key; key packages signed with Ed25519 alone, ML-DSA-44 alone or under the old suite refused; a group info cut to its Ed25519 half not joined; the emoji's new golden value.
- **Go** (`server/internal/hybrid`, `server/internal/api/post_quantum_test.go`, `server/cmd/zuna-server/tls_test.go`, `server/internal/merkle`): Rust's vectors derived and verified and its own written; nothing of the old suite taken, as a key package, welcome or group info; keys of the old shapes refused at sign-up and for devices; a request proof refused with Ed25519 alone, either half broken, or Ed25519's half alone; a welcome sent once reaching every device it names; the server's TLS agreeing on X25519MLKEM768, and on X25519 with a client that doesn't know it.
- **The core** (`packages/core/test`): everything as it was, now with hybrid keys and X-Wing end to end, which is the point, and the log's vectors with a hybrid head. The tests that make an attacker's keys make them of the kind the attacker needs.
- **The desktop app:** the updater taking a release both of a channel's keys signed and refusing either signature alone, broken, from another channel or swapped (`updates.rs`); `apps/desktop/test/windows-update-check.mjs`, which installed a build, refused releases with no second signature, another's, or the other channel's, and installed and started the one signed with both; and TLS offering X25519MLKEM768 first (`host/tls.rs`). The web check ran in Chromium (`apps/web/test/web-check.mjs`): 67 of its 69 steps passed, signing up, messages, files, an encrypted voice channel, a device signing in and a bot set up through its link among them, and the two that failed are a bot's name shown as its username, which failed the same way before this work.
- **The release script** (`scripts/release.test.mjs`): ML-DSA-65 keys kept as seeds, signing and checking, the app's keys read, and a key from a seed being the one Rust checks with.

## What wasn't checked

Everything above ran on Windows on 2026-11-11: the crate's tests as WebAssembly and natively, the server's, the core's end to end, `zuna-bot`'s against a real server, the watch player's, the release script's, the desktop app's, the Windows update check, and the web check in Chromium.

- **The iPhone app was built, not run.** Swift can't be compiled on Windows, but the release workflow archived it on macOS for `v0.1.0-nightly.1202` on 2026-11-12 and sent it to TestFlight, so it compiles. No Swift changed but the bridge test's expected sizes, as the bridge's functions kept their names and arguments, and the core bundle and the crate it calls through UniFFI are the ones tested here. Nobody has used it on a phone since, nor run its tests on a Mac. Its notification extension now follows only groups of up to about fifty devices, which no test on a phone has covered, and its TLS from iOS 26 is the system's.
- **The native app on Linux and macOS wasn't built.** aws-lc-rs builds there as rustls's own default, but the app's build with it, and its tests, ran on Windows alone.
- **The installer's check** (`deploy/test/install-check.sh`) needs Lima: the summary's new line and the larger body limits were only checked by `bash -n` and by testing the version comparison.
- **The web check in Firefox and WebKit,** which don't run on Windows, and the landing page's check, as its change was two lines of copy, looked at in the browser.
- **PostgreSQL:** no SQL changed, and no schema, but the server's tests ran in SQLite only.
- **The first release signed with the new keys** is `v0.1.0-nightly.1202`, on 2026-11-12: its `update.json.sig2` holds for a nightly ML-DSA-65 key the app carries, and for no stable one, as checked against the published files. No installed build has updated to it, or from it to a later one, outside `apps/desktop/test/windows-update-check.mjs`, which does both with keys made for its run.
- **Groups of a thousand were measured, not used:** no client ran a channel of that size end to end, through the server, with its uploads.
- **Interoperating with anything but Zuna,** which 0x0052's signatures wouldn't.

## Questions for a reviewer

1. **The composite inside MLS.** 0x0052's signature scheme carries Ed25519 and ML-DSA-44 together, through a provider that wraps OpenMLS's. Is there anywhere OpenMLS treats a signature or key by its scheme's expected size, or signs outside the `Signer` and `verify_signature`, which this would get wrong?
2. **One seed for both keys.** Each algorithm's seed is HKDF-SHA-256 of the secret's, under its own label, which FIPS 204 then makes a key from. Is that sound, the plan's question 7, also for the server's log key and a bot's, which come from seeds kept elsewhere?
3. **The signed input.** Both halves sign a label, the kind and the public key's hash, then the message, with ML-DSA's context left empty. Is binding by the key's hash enough to keep a half from being lifted, or should the other half's signature be in what each signs?
4. **ML-DSA-44 for devices,** category 2 beside a KEM of category 3, as the draft's only suite with a hybrid KEM and post-quantum signatures has it, the plan's question 6.
5. **Hedged signing** through `ExpandedSigningKey::sign_internal` with the pure variant's prefix of an empty context, as the `ml-dsa` crate exposes nothing else that takes randomness without a newer `rand_core`. Is that FIPS 204's ML-DSA.Sign?
6. **Go's Ed25519 check** isn't strict about small-order keys, where Rust's is. Both halves have to hold anyway, so is there anything a key the server takes and the apps refuse could do?
7. **Tokens,** the plan's question 5: unlinkable against any attacker, the proof sound against a quantum server, and only forgery lost?
8. **SHA-384 in the suite, SHA-256 outside,** the plan's question 8: does anything Zuna derives from the exporter want to follow the suite's hash?
9. **The draft's code point.** Zuna gives 0x0052 a signature the draft doesn't. If a later OpenMLS drops its provisional suites, groups need stage 5 or OpenMLS pinned: is anything lost by pinning it?

## Sources

- [FIPS 203, ML-KEM](https://csrc.nist.gov/pubs/fips/203/final) and [FIPS 204, ML-DSA](https://csrc.nist.gov/pubs/fips/204/final)
- [ML-KEM and Hybrid Cipher Suites for Messaging Layer Security](https://datatracker.ietf.org/doc/draft-ietf-mls-pq-ciphersuites/), and [X-Wing](https://datatracker.ietf.org/doc/draft-connolly-cfrg-xwing-kem/)
- The sources of `openmls` 0.9.2, `openmls_rust_crypto` 0.6.0, `ml-dsa` 0.1, `hpke-rs-rust-crypto` 0.7 and `circl` 1.6.5, as pinned
- NIST's ACVP vectors for ML-DSA key generation, as `circl` carries them
- [rustls's defaults](https://docs.rs/crate/rustls/latest/source/src/manual/defaults.rs), and LiveKit's `KeyProviderOptions` in `livekit-client`
