# Post-quantum cryptography: plan

**Status:** written on 2026-11-11 against commit `d6db95a6`. Nothing of it is built, and nothing here has been measured: the sizes in section 8 are worked out from the standards, and stage 0 replaces them with what a build shows. Nobody independent has reviewed it. Section 10's decisions are the owner's, and section 11's questions are what a reviewer should look at first.

**Scope:** every place Zuna agrees on a key or signs something with X25519, Ed25519, P-256 or ristretto255, which is all of its public-key cryptography. A large enough quantum computer breaks each of them. This plan says where each is used, what breaking it would give, what replaces it, in what order, and what it costs.

**The owner's constraint holds:** no part of this may add a step, prompt or setting for people using the app.

Read [SECURITY.md](../SECURITY.md), [SECURITY_DETAILS.md](SECURITY_DETAILS.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [ACCOUNT_KEY_ROTATION.md](ACCOUNT_KEY_ROTATION.md) first. This uses their words.

## 1. Summary

1. **There are two threats, and only one is urgent.** What's sealed to a public key today can be recorded now and opened once a quantum computer exists. A signature can only be forged once one does. So key agreement comes first, and signatures after it.
2. **The server's data is the recording.** It sees every welcome and commit of every group, and holds every account key sealed to its slots and devices. Whoever keeps a copy and later has a quantum computer gets every epoch's keys, and with them every message, file and name, without guessing a password. Nothing done afterwards takes that back, which is why stage 1 matters more than the rest together.
3. **Key agreement becomes ML-KEM-768 together with X25519,** in MLS and in Zuna's own sealing, so that both have to be broken. The OpenMLS already pinned has the suites, behind a feature.
4. **Signatures become Ed25519 together with ML-DSA,** both required, starting with the keys everything else hangs from: identity keys, the log's key, and the keys updates are signed with.
5. **What's symmetric stays as it is.** Content, files, the vault and what's stored on a device are under 256-bit keys, which a quantum computer doesn't threaten.
6. **It should land before 1.0.0.** Until the first stable release nothing has to stay compatible, so each stage is a cut-over to the new format and nothing else. After it, each would mean two formats side by side, and a way to move every group and account from one to the other.

Four limits, stated plainly because they decide what this is worth:

- **What was recorded before stage 1 stays open to a quantum computer.** That's test servers and the owner's own installs today, and everyone's from the first stable release on, if it ships without stage 1.
- **ML-KEM and ML-DSA are young.** That's why each is paired with what's there now, and why nothing here removes X25519 or Ed25519.
- **The MLS suites aren't a standard yet.** They're an IETF draft whose code points are still to be assigned (section 9).
- **Everything gets bigger.** A group's state by about five times after stage 1, and a short message by about ten after stage 3 (section 8).

## 2. Terms

| Term | Meaning |
|---|---|
| Quantum computer | Here, one large enough to break X25519 and Ed25519. None is today, and nobody knows when one will be. |
| Record now, open later | Keeping ciphertext until a quantum computer can find the key it was sealed to. It needs no quantum computer on the day of the recording. |
| Recorder | Someone who keeps what crosses the network, or a copy of a server's data, to open later. |
| ML-KEM-768 | NIST's key encapsulation standard, FIPS 203. A public key is 1,184 bytes and a ciphertext 1,088. |
| ML-DSA-44, ML-DSA-65 | NIST's signature standard, FIPS 204, at two strengths. A public key is 1,312 or 1,952 bytes, and a signature 2,420 or 3,309. |
| Hybrid | Two algorithms used together so that an attacker has to break both: ML-KEM-768 with X25519 for agreeing on a key, ML-DSA with Ed25519 for signing. |
| MLKEM768-X25519 | The hybrid of those two, which the drafts for HPKE define, with KEM ID `0x647a`. It's also known as X-Wing. A public key is 1,216 bytes and a ciphertext 1,120. |
| Suite | An MLS cipher suite: which key agreement, cipher, hash and signature a group uses. A group keeps the one it was made with. |
| Cut-over | A release from which the newest apps and server speak only the new format. What was made in the old one stops working. |

"Server", "reader" and "holder" mean what they do in section 4 of [ACCOUNT_KEY_ROTATION.md](ACCOUNT_KEY_ROTATION.md): a malicious operator, a copy of the server's data, and someone with an account's keys as of some generation.

## 3. Where Zuna uses what

Checked against the code at commit `d6db95a6`. Short paths are in `packages/core/src/` and `server/internal/`.

### Sealed to a public key: can be recorded now

| | What | With | Where | A quantum computer later gives |
|---|---|---|---|---|
| 1 | MLS: welcomes, the tree's path secrets, external joins | DHKEM X25519 | `crypto/src/mls.rs:16` | A welcome or an external join gives its epoch's secrets, and each commit after it the next epoch's. So every content key, and what's read under it, to a server or a reader |
| 2 | An account key sealed to its password's and recovery key's slots | HPKE, X25519 | `generations.ts:70` | The account key from the slot's public key alone, with no password to guess, then the vault and every content key in it |
| 3 | An account key sealed to each device's seal key | HPKE, X25519 | `generations.ts:109` | The same |
| 4 | History grants, sealed to an account's HPKE key | HPKE, X25519 | `crypto.ts:500` | The older epochs' content keys the grant hands over |
| 5 | TLS to the chat server, `zuna-web`, the push relay and LiveKit's signalling | X25519 or P-256 | The Go servers, a proxy, each app's own stack | What the server sees: who's where and when. Also sign-in keys, which allow guessing a password offline, the key pushes are sealed with, and the community key where open sign-ups hand it over |
| 6 | WebRTC's own encryption to LiveKit | ECDHE | libwebrtc, browsers | What LiveKit sees: who sends how much, and how loud. The media itself is under the room's key, from row 1 |

Rows 1 to 3 are each enough to read everything. Row 2 is the simplest: one public key for each account.

### Signed: can be forged once one exists

| | What | With | Where | A quantum computer then gives |
|---|---|---|---|---|
| 7 | Identity keys: device certificates, links between generations, profiles, the HPKE key | Ed25519 | `crypto.ts:221`, `generations.ts:175` | A device of the attacker's on anyone's account, or a new generation of their keys. With the server's help, since the log has to name it |
| 8 | Device keys inside MLS: leaves, key packages, commits, group infos | Ed25519, by the suite | `crypto/src/mls.rs` | A key package as someone's real device, so a welcome sealed to the attacker. A server could read a group that way |
| 9 | Device keys outside MLS: envelopes, rosters, details, grants, seal proofs | Ed25519 | `crypto.ts:358`, `roster.ts:47`, `crypto.ts:539` | A member writing as another member, or as an admin |
| 10 | The log's key | Ed25519 | `store/log.go:294`, `transparency.ts:203` | Heads nobody signed, so two logs can no longer be proved, and someone else can pose as the server's log |
| 11 | Update keys | Ed25519 | `apps/desktop/src/platform/updates.rs` | An update of the attacker's on every Windows install that it can serve one to |
| 12 | Slot signing keys, for enrollment proofs | Ed25519 | `generations.ts:101` | A false word on which secret a new device signed in with |
| 13 | A bot's setup key | Ed25519 | `account.ts:349`, `session/server.ts:377` | A bot its owner's app takes for the one it set up |
| 14 | Request proofs | Ed25519 | `session/base.ts:212`, `api/proof.go` | What a stolen session token can't do today: removing devices, vault writes, anything an admin does |
| 15 | Send keys | Ed25519, from the exporter | `api/sealed.go:109` | A reader with an account writing what nobody can open into a group, for the rest of its epoch |
| 16 | Item keys | Ed25519, from the account key | `api/sealed.go:57` | A reader with an account having the server take down or replace its copy of a message. Apps still go by the signature inside |
| 17 | Tokens | VOPRF, ristretto255 | `crypto/src/primitives.rs`, `tokens/` | Tokens nobody was issued, so no limit on what one sender floods. Who spent a token stays hidden (section 6, stage 4) |
| 18 | A server's own certificate, without a domain | ECDSA P-256 | `server/cmd/zuna-server/certificate.go` | Posing as that server to someone on the path, seeing what the server sees |

### Not threatened

XChaCha20-Poly1305 for content, files, the vault and data on a device, AES-256-GCM for pushes, HKDF and the log's Merkle tree on SHA-256, Argon2id, the community key and what's derived from it, and a recovery key's 200 bits. A quantum computer halves a symmetric key's strength at most, and these have 256 bits. The emoji check is a hash too, though what it hashes changes in stage 2.

One to raise: LiveKit encrypts voice and video frames with AES-GCM under 128-bit keys in the web app (`keySize` in `livekit-client`, which `packages/ui/src/voice/room.ts` leaves at its default). That's still thought safe, but it's the one place under 256. The native app's and the iPhone's haven't been checked.

### Not Zuna's to change

Apple's push service and notarizing, GitHub, YouTube, 7TV, Authenticode, and the certificates of the web: a server's HTTPS certificate is signed with today's algorithms by an authority, and stays so until browsers and authorities move. Nothing end-to-end leans on it, and updates are signed apart from it, but the web app does: its code comes over that connection on every visit.

## 4. What's chosen

| For | Today | Becomes |
|---|---|---|
| Agreeing on a key, in MLS and in Zuna's own sealing | X25519 | MLKEM768-X25519 |
| Signatures by keys that last: identity keys, the log's key, update keys, slot signing keys | Ed25519 | Ed25519 and ML-DSA-65, both checked |
| Signatures by a device | Ed25519 | Ed25519 and ML-DSA-44, both checked |
| The MLS suite, stage 1 | `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519` | `MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519` |
| The MLS suite, stage 3 | | `MLS_128_MLKEM768X25519_CHACHA20POLY1305_SHA384_MLDSA44` |
| Ciphers and hashes outside MLS | 256-bit keys, SHA-256 | Unchanged |

- **Hybrid everywhere, never ML-KEM or ML-DSA alone.** Both are a few years old, and their implementations younger. If either turns out weak, what's there today still holds. The cost is 32 or 64 bytes beside a kilobyte or more.
- **One key agreement for everything.** The same KEM in MLS, slots, bundles and grants, through the same HPKE code, as today.
- **ML-DSA-44 for devices, since the draft's only suite with a hybrid KEM and a post-quantum signature uses it,** and a device signs every message, so its size counts most. ML-DSA-65 for keys that sign rarely and last for years, where a kilobyte more costs nothing.
- **A signature that's hybrid is two signatures over the same labelled input,** and a check that both hold. Never one or the other.
- **The implementation is OpenMLS's own,** so MLS and Zuna's sealing don't disagree: its Rust provider uses the `ml-kem` and `ml-dsa` crates, and its libcrux provider Cryspen's verified ML-KEM. Stage 0 picks between them by what builds for all five targets. The server only checks signatures, with `circl`, which it already has for tokens.

Signal and iMessage went the same way round: hybrid key agreement first, signatures left for later.

## 5. The order, and why

| Stage | What | Changes formats | Size |
|---|---|---|---|
| 0 | Measure and prepare | No | Small |
| 1 | Nothing recorded can be opened later: MLS, slots, bundles, grants, TLS | Groups, accounts' sealed keys | Medium |
| 2 | The keys everything hangs from: identity keys, the log, updates | Accounts, the log, the update manifest | Medium |
| 3 | Device signatures: the MLS suite, envelopes, rosters | Groups, devices, every message | Large |
| 4 | What the server checks: proofs, send keys, item keys, tokens, pinned certificates | Requests | Small, mostly decisions |
| 5 | Being able to change again | Groups | Medium |

Stage 1 is first because it's the only one where waiting loses something for good. Stage 2 is next because its keys last longest and sign least, so it costs little, and because an update key has to be in an installed app before anything can be signed with it. Stage 3 costs the most and protects against what's furthest off. Stage 4 is mostly deciding what's worth it. Stage 5 is what lets any of this be done a second time once people depend on it.

## 6. The stages

### Stage 0: measure and prepare

Nothing anyone runs changes.

- **Build the suites.** Turn on `draft-ietf-mls-pq-ciphersuites` in `crypto/Cargo.toml` for `openmls`, `openmls_rust_crypto` and `openmls_traits`, in tests only, and check it builds for `wasm32-unknown-unknown`, Windows, Linux, macOS and iOS. Try the libcrux provider on the same five.
- **Measure groups of 10, 100 and 1,000 devices** under today's suite and both of section 4's: a key package, a commit, a welcome, the group info, the stored state, and the time to commit and to join, natively and as WebAssembly. Section 8's table is what to fill in.
- **Measure what else grows:** the list of people, which carries every identity key and device, how often it's read in full, a head inside a message, and an invite link.
- **Check the limits these run into:** `maxKeyPackageBytes` (16 KiB) and the 500 kept for each device, `maxCommitBody` (16 MiB), `maxDetailBytes` (16 KiB, which a certificate has to fit), `MAX_LOADED` in `mls.rs`, and how large a header a proxy passes.
- **Shared vectors for ML-DSA,** made in Rust and checked in Go, as the log's and the tokens' are.
- **Make section 10's decisions,** with the numbers.

### Stage 1: nothing recorded can be opened later

- **The suite.** `CIPHERSUITE` in `mls.rs` becomes `MLS_128_MLKEM768X25519_AES256GCM_SHA384_Ed25519`. The exporter's labels and lengths stay, so content, send and voice keys are made as they are now. The server reads a commit's suite and ignores it (`api/mlsframe.go:131`): it should refuse any other, so that no group goes on in the old one.
- **Zuna's own sealing.** `HPKE_CONFIG` in `primitives.rs` takes the same KEM, for slots, bundles and grants, with new labels (`zuna/history-grant/v3` and the slots' and bundles'). Public keys there are 1,216 bytes, so the server's checks that one is 32 change (`api/accounts.go:166`, `api/devices.go:31`, `api/generations.go:24`, `:71`, `:309`), with `types.ts` and what mirrors it.
- **TLS, preferred and not required.** A server behind an older proxy still works.
  - The Go servers already offer X25519MLKEM768, as Go has by default since 1.24. A test should hold them to it.
  - The desktop app's rustls is built on `ring` (`apps/desktop/Cargo.toml:37`, `host/tls.rs:106`), which has no ML-KEM. It moves to rustls's `aws-lc-rs` provider with `prefer-post-quantum`, for the core's requests, the socket, and LiveKit's. That adds CMake and NASM to what a Windows build needs, which CI has to have.
  - The web app takes the browser's, which current Chrome, Firefox and Safari have. The iPhone app takes the system's, from iOS 26, and the app runs from iOS 18. `zuna-bot` takes Node's, on by default from 22.20.
  - Proxies: Caddy has it from 2.10. nginx and Apache have it where the system's OpenSSL is 3.5 or newer. `deploy/install.sh`, the examples in `docs/SELF_HOSTING.md` and `docs/LINUX.md`, and `deploy/test/install-check.sh` say and check which.
- **Voice frames under 256-bit keys,** if LiveKit's three SDKs can agree on it.
- **Tests.** In `packages/core/test`: a group made here is under the new suite, a slot and a bundle open only with the new keys, and the server refuses a commit of the old suite. The rest of the suite passes unchanged, which is the point.
- **Docs.** The suite and "Keys on new devices" in `SECURITY_DETAILS.md`, a paragraph in `SECURITY.md`, the key hierarchy in `ARCHITECTURE.md`, question 13 of the rotation's design, and the landing page, which may then say it and not before.

What it leaves: everything in the second table of section 3. A quantum computer, once there is one, could still forge. It couldn't read what was said before.

### Stage 2: the keys everything hangs from

- **Identity keys.** An account's identity key becomes an Ed25519 key and an ML-DSA-65 key, made together, sealed in the vault's core together, and replaced together by a rotation. Certificates, links, the profile's signature and the HPKE key's are signed by both. The server checks both on a link (`api/generations.go:63`).
- **The emoji check** hashes both people's whole identity keys, under `zuna/safety/v3`. Its golden value changes once, on every platform.
- **The log's key.** A head is signed by both, under `zuna/log/head/v2`, with new shared vectors (`UPDATE_LOG_VECTORS=1`). An invite link carries a hash of the log's key and not the key, so it doesn't grow by two kilobytes.
- **Update keys.** This is the one place old builds have to keep working, since an installed build must always be able to update.
  - A release gains `update.json.sig2`, an ML-DSA-65 signature of the same bytes. `update.json.sig` stays exactly as it is.
  - A new build requires both. An old build checks the one it knows and updates as before, to a build that requires both.
  - Four new keys: one in use and one spare for each channel, the spares' private halves never on GitHub, as now.
  - The order is the table's in `CLAUDE.md`: the public keys in the app first, then the environments' secrets and the offline copies. The first release that carries the keys can be the first signed with them, as nothing older reads the new file.
  - `windows-update-check.mjs`, `docs/RELEASES.md` and "Updates" in `SECURITY_DETAILS.md` follow.
- **A bot's setup link** carries one 32-byte seed in place of an Ed25519 secret, and both key pairs are made from it, so the link doesn't grow.
- **Slot signing keys** sign with both.

### Stage 3: device signatures

- **A device has two signing keys,** Ed25519 and ML-DSA-44, and its certificate names both.
- **The suite** becomes `MLS_128_MLKEM768X25519_CHACHA20POLY1305_SHA384_MLDSA44`, whose leaves and commits are signed with ML-DSA-44 alone, as MLS has no suite with two signatures. So that Ed25519 still has to be broken too, each key package, commit and group info travels with the device's Ed25519 signature beside it, kept by the server with it and checked by the core before OpenMLS is given it.
- **A leaf's credential shrinks** from the certificate to the account, the device and a hash of the certificate. The certificate comes with the list of people, and the log already says which hash counts. Otherwise every leaf would carry an identity key's signature, of three kilobytes.
- **Envelopes** carry both signatures, as version 4, so everything signed grows by 2,420 bytes: messages, reactions, read positions, pins, deletions, typing. `previewPush` and "Message content" follow, as for any change to the envelope.
- **Rosters, details, grants and seal proofs** carry both.
- **If stage 0 shows a tree of ML-DSA leaves is too heavy,** the other way round is the fallback: the suite stays stage 1's, and the ML-DSA signature is the one beside each key package, commit and group info. A leaf stays a third of the size. It's less standard, and what a member could do with a forged leaf inside a commit needs a reviewer's eye (section 11).

### Stage 4: what the server checks

Each of these is checked by the server on a request, and none decides what an app trusts.

- **Request proofs** carry both signatures, in the body where a header would be too long.
- **Send keys and item keys stay Ed25519,** as section 10 recommends. Forging either takes a copy of the server's data, a quantum computer and an account, to do what the server itself always could: write what nobody can open, or take down its own copy of a message. Making them hybrid would add 2,420 bytes to every sealed request, which is every message, reaction and typing signal. "Limits" in `SECURITY.md` says so.
- **Tokens stay as they are.** As we read it, who spent a token stays hidden whatever the attacker can compute, since a blinded token is a uniformly random element, and the server's proof that it used the key it shows doesn't rest on a hard problem either. What a quantum computer breaks is the limit: it could find a period's key within the twelve hours its tokens redeem in, and make its own. There's no standard post-quantum replacement to move to.
- **A server's own certificate** becomes ML-DSA once Go's `crypto/tls`, rustls and iOS can check one. The link carries a hash of the key, so it doesn't grow.

### Stage 5: being able to change again

A group keeps the suite it was made with, and OpenMLS doesn't move one to another. Before 1.0.0 that's no matter. After it, a second change, as when the draft's code points are assigned or an algorithm falls, needs a way to start a group again:

- **A member's device makes a new MLS group for the same conversation,** under the new suite, and the others join it by external commit, as a device repairing itself does today.
- **History stays readable,** as its content keys are in each account's vault, apart from MLS.
- **Epoch numbers go on from where they were.** Content keys, envelopes and the server's order are all by epoch, so the new group's count starts after the old one's last.
- **Who may start one again, and how a device knows it isn't a way to drop members,** is this stage's own design, with the roster carried across under an admin's signature.

It can be built after 1.0.0, since an installed build can always update. It has to exist before anything forces a second change.

## 7. The cut-overs

Stages 1, 2 and 3 each change what's stored and sent. Under the rule that nothing stays compatible before the first stable release, each is a cut-over: no second format, no fallback, no move of saved data.

- **Stage 1 orphans every group,** as its suite is fixed, and every account's sealed keys. Stages 2 and 3 orphan every account and device.
- **So an account made before a cut-over is made again after it.** Test servers start from `npm run dev:clean`. Schema migrations still go at the end of their lists.
- **Two cut-overs, not three:** stage 1 on its own, as soon as it's ready, then stages 2 and 3 together.
- **If what exists has to carry over,** stage 5 comes first, and accounts move by an ordinary rotation. That keeps a check of Ed25519-only links for the generations from before, which is what the rule says not to keep, and is the first of the owner's decisions.

The update manifest is the exception, as it always is: stage 2 adds to it and takes nothing away.

## 8. What it costs

Worked out from the standards' sizes, not measured. Stage 0 replaces this table.

| | Today | After stage 1 | After stage 3 |
|---|---|---|---|
| A key package | about 0.6 KB | about 3 KB | about 9 KB |
| A leaf of a group's tree | about 0.5 KB | about 1.7 KB | about 5 KB, or 10 with the certificate inside |
| The group info a commit carries, 100 devices | about 55 KB | about 0.3 MB | about 0.6 MB |
| The same, 1,000 devices | about 0.55 MB | about 2.9 MB | about 6.3 MB |
| A commit's own path, 1,000 devices | about 1 KB | about 25 KB | about 27 KB |
| The shortest message, as stored | about 0.3 KB | the same | about 2.9 KB |
| An identity key in the list of people | 32 bytes | the same | about 2 KB, from stage 2 |

- **Large channels are where it shows.** Every commit carries the group info with the whole tree, and every device that joins fetches it. At a hundred devices that's bearable. At a thousand it's megabytes for each commit, on a phone too.
- **If that's too much,** the lever is the tree: kept by the server apart from the group info, with a commit sending only the nodes it changed. The server can read a tree, which is public, but that's a design of its own, and only worth it if stage 0 says so.
- **Short messages grow most,** by about ten times, and reactions and read positions with them. A server's database grows by something near that for a chat that's mostly text.
- **Time** matters less than size. ML-KEM is about as fast as X25519, and ML-DSA signs and checks in a millisecond or less natively. WebAssembly is what to measure.
- **The build.** `aws-lc-rs` in the desktop app, and more for the crypto crate to compile on every target.

## 9. What this doesn't do

- **What was recorded before stage 1.** Nothing reaches back.
- **The draft.** `draft-ietf-mls-pq-ciphersuites` was at version 06 in July 2026, with a 07 since, and its code points are placeholders. OpenMLS 0.9 implements version 05's behind a feature. Zuna only ever talks to itself, so a code point is a label in its own data, but a later OpenMLS may drop the provisional ones, and a group made under one then needs stage 5, or OpenMLS pinned.
- **Young implementations.** A timing leak in an ML-KEM or ML-DSA library is likelier than in code that's had fifteen years of attention. The hybrid covers a broken algorithm better than a leaking one.
- **What the server sees** is what it saw before. None of this hides who talks to whom, or when.
- **The connection to LiveKit for media.** Whether libwebrtc agrees its keys with ML-KEM wasn't confirmed. What's said and shown is under the room's key either way.
- **An iPhone before iOS 26,** whose connections to the server stay as they are.
- **The web app's code,** which is only as safe as the HTTPS certificate of its host.
- **Whoever has an account's password or recovery key** opens its history, as now.
- **No independent review,** of this or of what it builds on.

## 10. Decisions for the owner

| | Decision | Recommended |
|---|---|---|
| 1 | At a cut-over, start accounts and groups again, or carry them over | Start again, as the rule says. Carrying over means stage 5 first, and a check of old links kept for good |
| 2 | One cut-over for everything, or stage 1 first | Stage 1 first, then 2 and 3 together |
| 3 | Whether stage 3 goes in before 1.0.0, at ten times the size of a short message | Yes, if stage 0's numbers are bearable for a channel of a few hundred devices. It's the last time it's free. If not, stage 5 first, and stage 3 when a smaller signature is a standard |
| 4 | Send keys and item keys: leave as they are, or make hybrid | Leave, and say so in "Limits" |
| 5 | Update keys: ML-DSA-65, or SLH-DSA, which rests on hashes alone and signs in seconds with an 8 KB signature | ML-DSA-65, so there's one signature algorithm to bind, test and have reviewed. Where the new spares' offline copies go is the owner's to say |
| 6 | Whether an app ever refuses a server whose TLS isn't hybrid | No. It would cut off servers behind an older proxy, for what's metadata |
| 7 | Whether 1.0.0 waits for the draft to become an RFC | No |

## 11. Questions for a reviewer

1. **Two signatures side by side.** Is "both over the same labelled input, both must hold" enough everywhere Zuna signs, or does any use need the two bound to each other, so that one can't be lifted from a pair and shown alone to something that would take it?
2. **Ed25519 beside MLS's own ML-DSA** (stage 3). Does a signature over the bytes of a key package, commit or group info, checked before OpenMLS reads them, give what a hybrid suite would? What should it cover besides the bytes: the group, the epoch?
3. **The fallback, the other way round.** With Ed25519 in the suite and ML-DSA beside it, a member with a quantum computer could put a forged key package for someone's real device inside a commit of their own, where the signature beside it isn't. They'd hold a leaf as that device after being removed, until the real device joins. Is that all of it?
4. **A credential that's a hash of the certificate.** Is leaning on the log and the list of people for the certificate itself sound, given a leaf that can't be checked yet already counts for nothing?
5. **Tokens.** Is section 6's reading right: unlinkable against any attacker, the proof sound against a quantum server, and only forgery lost?
6. **ML-DSA-44 for devices.** Is category 2 enough beside a KEM of category 3, or should the choice of suite wait for one with ML-DSA-65 and a hybrid KEM?
7. **Keys from seeds.** A bot's setup link, and a send key if decision 4 goes the other way, make an ML-DSA key from 32 bytes of the exporter or a link. FIPS 204 makes a key from a seed, but is deriving that seed with HKDF from one shared with an Ed25519 key sound?
8. **SHA-384 in the suite, SHA-256 outside it.** The exporter gives 32 bytes as before. Does anything Zuna derives from it want to follow the suite's hash?
9. **Question 13 of the rotation's design** asked whether slots and bundles were the place to start. This says they go with MLS, in the same stage, as either alone leaves the other open.

## 12. What changes together

Beyond what each stage names, the table in `CLAUDE.md` applies as for any change to cryptography:

- **A crypto function:** `mls.rs`, `primitives.rs`, `wasm.rs`, `native.rs`, `apps/ios/core-bundle/src/crypto.ts`, `CryptoBridge.swift` and `apps/desktop/src/host/crypto.rs`.
- **`types.ts`:** `Models.swift` and `apps/desktop/src/models.rs`, for every key that's no longer 32 bytes.
- **The log's formats:** `server/internal/merkle`, `store/log.go`, `transparency.ts`, the vectors, and section 5.2 of the log's plan.
- **Every claim:** `SECURITY.md`, `SECURITY_DETAILS.md` and the landing page say what's built, stage by stage, and nothing ahead of it.
- **`.agents/FEATURE_PARITY.md`:** the core's changes reach every platform. TLS is each host's own, so each stage 1 row says which of the desktop, the web, iOS and the bot has it.
- **An end-to-end test in `packages/core/test`** for each stage's behavior, and the PostgreSQL run for the columns that grow.

## 13. Sources

- [FIPS 203, ML-KEM](https://csrc.nist.gov/pubs/fips/203/final) and [FIPS 204, ML-DSA](https://csrc.nist.gov/pubs/fips/204/final)
- [ML-KEM and Hybrid Cipher Suites for Messaging Layer Security, draft 06](https://datatracker.ietf.org/doc/html/draft-ietf-mls-pq-ciphersuites-06), read on 2026-11-11
- [OpenMLS's changelog](https://github.com/openmls/openmls/blob/main/CHANGELOG.md), and the sources of `openmls_traits` 0.6.0 and `openmls_rust_crypto` 0.6.0 as pinned
- [Post-Quantum OpenMLS](https://cryspen.com/post/pq-openmls/), Cryspen
- [rustls's defaults](https://docs.rs/crate/rustls/latest/source/src/manual/defaults.rs) and [rustls-post-quantum](https://docs.rs/rustls-post-quantum/latest/)
- [Go 1.26's release notes](https://tip.golang.org/doc/go1.26)
- [Cloudflare's table of who supports what](https://developers.cloudflare.com/ssl/post-quantum-cryptography/pqc-support/), for Caddy, nginx and Node
- [Post-Quantum Cryptography support in NGINX](https://blog.nginx.org/blog/pqc-nginx)
- [Apple's platform security guide](https://support.apple.com/en-ca/guide/security-pdf/secc7c82e533/web), for TLS in iOS 26
