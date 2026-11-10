# Sealed sender: the plan

This is the plan for hiding from a server who sent each message. It's written for whoever builds it, starting cold: it says what the server learns today and where, what was decided and why, what's still to settle, and the order to build in. Nothing here is built yet.

Read [SECURITY.md](../SECURITY.md), [SECURITY_DETAILS.md](SECURITY_DETAILS.md) and [ARCHITECTURE.md](ARCHITECTURE.md) first, as for any change to cryptography. There's no backward compatibility to keep: only the newest apps and server have to work together, and no old route, field or format stays.

When it's built, rewrite this file as `docs/SEALED_SENDER.md`, saying what was built in place of what's planned, and delete this one.

## The goal

Today the server is told who sends every message, reaction, edit, pin, deletion and typing signal, and keeps most of it. After this:

- **The server isn't told who sent something in a conversation, and can't work it out from what it's sent.** A request that adds to a conversation carries no session, no user, no device and no signature a known key checks.
- **The server keeps nothing that says it.** A copy of its data, its backups and its own logs name no sender of any message, reaction, edit, pin or deletion, and nothing a sender could be worked out from exactly.
- **Members still know.** Every app checks who wrote what, as now, from a signature inside the encryption.
- **Nothing gets weaker.** Everything the apps check today still holds, and a member can't use being unnamed to flood a conversation, write as someone else, or change or delete someone else's messages.

What it doesn't do, which the docs must say as plainly:

- **The server still knows who's in each conversation.** Sealed sender hides which member wrote, not who the members are. In a direct message that leaves two people.
- **A server that sets out to can often work a sender out,** from the address a message comes from, who was online, who uploaded a file or changed a group's keys just before, and whose phones it didn't have to wake. Signal's sealed sender has the same limit. The claim is about what the server is told and keeps, never "the server can't know".
- **Commits, calls, voice, presence, read positions and reports** still name who they're from. Each is about someone being somewhere or changing who's in a group, which the server takes part in.

## Who it's against

| Against | What they have | What's promised |
|---|---|---|
| **A copy of the server's data** | The database, files and logs, once or over time: a break-in, a backup, a seizure | No sender of any content, and no exact way to work one out. This is the promise to hold without exception |
| **An honest server someone watches** | Whatever the server as written receives | It's never handed a sender, so there's nothing to write down or hand over |
| **A server changed to find out** | Addresses, timing, every request | Not promised. Don't make it easier than timing and addresses already do, and where it's cheap, make it harder |
| **A member** | The conversation's keys | Can't write as anyone else, can't touch others' messages, and can't cost the conversation more than they could with their name on it |

Hold every decision against that table. A mechanism that hands the server the sender and asks it not to look fails the second row, however little it stores.

## What names a sender today

Everything below was read in the code on 2026-11-10. Check each again before changing it.

| Where | What it does with the sender |
|---|---|
| `server/internal/api/server.go`, `member` and `withDevice` | Every message route sits behind the session token, so the server knows the user and device of every request |
| `server/internal/api/groups.go`, `handleSendMessage` | Stores `sender_user` and `sender_device`, limits by user (`messageLimiter`, and for bots `botChatLimiter` and `botMessageLimiter`), checks `botMaySendFiles` |
| `server/internal/store/messages.go`, `CreateMessage` | Counts the envelope against the user's `stored_bytes`, takes their slow mode turn (`takeSlowModeTurn`, table `channel_sends`), checks they may share each file (`mayShareFile`), and treats the same ID from another user as a conflict |
| `EditMessage` | Only the user who sent it may edit, and records the editing device |
| `handleDeleteMessage`, `DeleteMessage` | The sender, or a group's admin, may delete. Stores `deleted_by` |
| `AddReaction`, `RemoveReaction` | Stores `user_id`, allows 32 a person on a message, and only the person who made one removes it |
| `SetPinned` | Stores `pinned_by` and `pin_by` |
| `server/internal/api/socket.go`, `relayTyping` | Typing goes over the device's own socket and is passed on with `user_id` |
| `server/internal/api/push.go`, `pushMessage`, and `PushTargets` in `store/push.go` | Leaves the sender's phones out of who's woken |
| `server/internal/api/files.go`, `store/files.go`, `retention.go` | A file has an `owner_id`, and `file_refs` ties it to the message that carries it, so a file names its message's sender |
| `packages/core/src/crypto.ts`, `sealEnvelope` | **The signature is outside the encryption.** An envelope is `signature || ciphertext`, and what's signed is the authenticated data and the ciphertext, both of which the server has. So the server can try every member's device key and find whose it is, whatever else changes |
| `frameSigned` in the same file | Reactions, pins, deletions, typing and read positions carry the device's ID in the clear, before the envelope |
| `packages/core/src/session/ingest.ts`, `push.ts` | The apps take `sender_user` and `sender_device` from the server to pick the key to check with, then check `by` inside (`namesItsSender`) |

One more that isn't about a message but would give a sender away to two copies of the data: `users.stored_bytes`, which rises by each message's size.

## Decisions

These are made. Each says why, and what was turned down. If one turns out wrong while building, stop and say so rather than working around it.

### 1. Everything a member adds to a conversation goes sealed, and no named route stays

Messages, edits, an author's own deletions, reactions and taking them back, pins and unpins, and typing. Bots send the same way. A named route left beside a sealed one is a way to make an app use it, so the old ones are removed in the same stage the sealed ones replace them.

Named still: commits, undoing commits, a group's details, a group admin deleting someone else's message, read positions, files being uploaded and fetched, voice and calls.

### 2. The signature moves inside the encryption

A new envelope, for every kind `sealEnvelope` makes:

```
envelope  = nonce || XChaCha20-Poly1305(content key, aad, pad(inner))
inner     = version || user ID || device ID || signature || body
signature = Ed25519(device key, "zuna/envelope-sig/v3|user|device|" || SHA-256(aad) || commitment || SHA-256(body))
commitment = HKDF(content key, "zuna/envelope-commit/v1")
aad       = as now: kind, group, item, epoch
```

- **Who signed is inside,** so an app opens first, reads who it claims to be from, then checks the signature with that device's key. `frameSigned` keeps only the epoch.
- **The commitment keeps what signing the ciphertext gave.** Today a good signature proves the signer used this very key, which `keyProvedItself` relies on to trust a key from a history grant. Signing the plaintext alone would let a member seal someone's signed body again under a key of their choosing. Signing a value derived from the key closes that. Write a test that fails without it.
- **The authenticated data still names the group, the item and the epoch,** so a signed body can't be moved.
- Padding stays as it is.

Turned down: keeping the signature outside and hiding only the IDs, which hides nothing, as the table says. MLS's own `PrivateMessage` framing, which would mean giving up exported keys, and with them history on new devices.

### 3. Being a member is shown with a key every member of an epoch holds

```
send secret = MLS-Exporter("zuna/send/v1", epoch, 32)      an Ed25519 seed
send key    = its public half, which the server holds for the group's current epoch
```

- **Whoever makes an epoch gives the server its send key,** in the commit that makes it, from `exportPendingSecret`, as the content key is taken there. An external commit does the same. The server can't check it, and doesn't need to.
- **A sealed request is signed with the send secret.** The server checks it against the one key it holds for that group. Any member's signature looks the same, which is the point.
- **Only the current epoch's key is taken,** so someone removed can't write, exactly as `stale_epoch` works now. A request under an older epoch is answered `stale_epoch`, and the app retries through `sealAndRetry`.
- **The secret is never stored and never handed on,** like `voiceKey`: not in the vault, not in a history grant. It's a different exporter label from the content key, so holding old content keys gives no way to write.
- **Every member checks the server's send key against its own** when it applies a commit or syncs a group. One that differs means whoever made the epoch, or the server, gave a wrong one, and nobody can send. Any member puts it right by committing, after a random wait, as reconciling does, since every commit carries a key.
- **Undoing commits restores the key.** `VoidCommits` goes back to an earlier epoch's number with a different state, so hold each send key wherever its group info is held (`group_infos`, and `replaced_info` on the commit's event), and restore it wherever group info is restored.
- The public half is what's stored, so a copy of the database gives nobody a way to write.

Turned down: a key or pseudonym for each member, which the server could follow from message to message. Anonymous credentials as Signal's groups use, which is far more cryptography to get wrong, when MLS already gives every member a shared secret that changes when membership does.

### 4. How much anyone may send is held with tokens the server can't trace

Without a name, the server can't limit a person, and a limit on the whole group lets one member use it up for everyone, unnamed. So:

- **A device asks for tokens while signed in, in batches,** and the server counts them against that person as it counts messages now.
- **Each sealed request that changes something spends one.** The server can tell a token is one it issued and hasn't seen, and nothing else: not whose, and not which batch.
- That's a verifiable oblivious PRF, [RFC 9497](https://www.rfc-editor.org/rfc/rfc9497.html), as Privacy Pass uses, where the server both issues and redeems. See "To settle first" for the suite and libraries.
- **A token is for a size and a time:** a small one for an envelope up to a few KiB, which is almost every message, and a large one up to the 256 KiB limit, far scarcer. The server's key changes every few hours and it takes the current and the last, which bounds how many anyone can save up.
- **A token is spent in the same transaction as the write,** so a request refused for `stale_epoch` costs nothing. A function passed to `tx` may run more than once, so the spend goes inside it.
- **Tokens are fetched ahead, at times of their own,** never because a message is about to go, so asking for them says nothing about sending. An app that has run out fetches and sends, which is the one time it does.
- **Everyone must be shown the same key.** A server that gave one person a key of their own could follow their tokens. Each signed body carries a short hash of the token key its sender holds, and an app that sees one differ from its own for the same period warns. It costs a few bytes and turns that from something silent into something seen.
- Bots get tokens at a bot's pace. The pace in each chat (`botChatLimiter`) goes: it can't be held without a name, and members can see a bot flooding and remove it.

A limit by address stays in front of all of it, for requests that never get as far as a token.

Turned down: a limit by group and address only, for the reason above. Limits kept by the apps alone, which a changed app ignores.

### 5. Changing or deleting something takes a key only its author's devices have

```
author root = subkey(account key, "author")
item secret = HKDF(author root, "zuna/item-key/v1|kind|group|item")     an Ed25519 seed
```

- **A message and a reaction each go up with their item key's public half,** which the server keeps beside them. To an edit, an author's deletion or a reaction being taken back, it's a signature by that key, on top of the send key's and a token.
- Item keys can't be told apart or tied to anyone without the author root, so they name nobody.
- **Any of the author's devices can make the key,** since they share the account key. After the account's keys are replaced, a device tries the root from each key it holds, the older ones included, and takes the one whose public half the server shows.
- **The same ID sent twice is a retry only with the same item key.** Otherwise it's a conflict, as a different sender is now.
- **This only stands in for the server's own check.** What the apps trust is still the signature inside: an edit from another person's device changes nothing on anyone's screen now, and that stays.

### 6. What nobody signed is nobody's, and is shown nowhere

Today a member needs the server's help to put something unsigned into a conversation. After this, any member can post bytes without a name. So the rule for what arrives becomes:

- **It opens under a key this device holds and trusts, and a device this device knows signed it:** shown, checked exactly as now (`couldBeSent`, `changedAfterLeaving`, `editedSince`, the author never changing).
- **This device has no key for its epoch:** as now, a message that can't be opened yet.
- **It opens and names a device this device doesn't know yet:** held, shown nowhere, and tried again once people and devices are caught up (`catchUpFirst`).
- **It doesn't open under a key that has proved itself, or its signature is wrong:** nobody's. Kept without being shown, counted or notified about, and never as a message "from" whoever it names. This is what stops one member framing another.

The author of a row that hasn't opened isn't known, so `sender_user` in the core's own database is empty until it is, and the interfaces must draw that.

### 7. A group admin deleting someone else's message stays named

It needs the admin's role, which is the server's to check, and it says who moderated, not who wrote. The server needn't keep who: the proof inside says so to the apps. An author deleting their own goes sealed, by decision 5. In a direct message there's only the author's.

### 8. A file belongs to someone until a message carries it, then to nobody

- **Uploading stays as it is,** named and counted against the uploader.
- **A file is made with the hash of a share secret,** which travels inside the encrypted attachment with the file's key.
- **A sealed message names its files with their share secrets.** The server checks each, ties the file to the message as now, and **clears its owner.** From then on nothing kept says who uploaded it. Forwarding gives the same secret, so it needs no named check, and still shares the file rather than uploading it again.
- **Who may fetch a file, and when it's removed, stay as they are,** by the messages that carry it.
- **What a bot may upload is checked when it uploads.**
- **Quota** can't count what belongs to nobody. See "For the owner to decide".

### 9. Waking phones without knowing whose message it is

The server can't leave the sender's phones out. Two things together do it:

- **A device that sends tells the server how far it has read, at once,** at its own message, as Telegram does. That's the named call it makes anyway, and it looks the same as anyone reading the message as it arrives.
- **The server holds each notification for a moment** before sending it, so that a read cancels it, through `waitingPushes`, which already holds a push while someone is on another device. Start at 1.5 seconds and measure.

A phone that's in use is never pushed, as now.

Turned down: the request saying whose phones to leave out, in any form the server can match, which is telling it the sender.

### 10. Slow mode and the limit on reactions are held by the apps

The server can't hold a person it can't see to a pace. Each app holds its own person to a channel's slow mode before sending, and hides a message that came sooner after its author's last than the channel allows, less a margin for the network, going by the server's times, which every app sees alike. An honest app never sends one, so only a changed app's extra messages are hidden, and tokens bound how many there can be. The 32 reactions a person may put on a message are held the same way. `channel_sends` goes.

### 11. Typing goes sealed, and read positions stay named

Typing just before a message would name its sender to anyone watching, so it's posted like a message, signed with the send key, passed on without a name and never stored, and the apps learn who from inside. It spends no token: a limit by group and address is enough for something that isn't kept.

A read position is about its reader, and the server needs it for notifications. It moves to the new envelope with everything else.

### 12. A sealed request shares nothing with the session

- **No `Authorization` header, no cookie, nothing kept from an earlier request.**
- **Its own connection, wherever the host can give one,** with its own TLS session cache: a second `reqwest::Client` in `apps/desktop/src/host`, a second ephemeral `URLSession` in `ZunaHost/NetworkBridge.swift`, a second undici `Agent` in `apps/bot/src/host.ts` and the tests. A browser decides for itself which connection a request goes down, so the web app can only leave credentials out, and the docs say so.
- **The server's own log lines for sealed routes carry no address.** Check what `server.go` logs for a failure.

### 13. Commits stay named, for now

A commit that changes who's in a group names people by its nature, and the server holds whoever sends bad ones back by name (`commitHolds`). But `deliver` in `session/sending.ts` commits just before it sends when the epoch is old (`rotateIfOld`) or the tree needs cleaning (`ensureTreeClean`), and that names the sender of the message that follows.

In this plan: renew an old epoch when a chat is opened or synced, not when something is sent, so it's rarely left to do at sending time. Sealing commits that change no membership is a later piece of work, with its own answer for holding back whoever sends ones nobody can apply.

## Settled before building

Settled on 2026-11-10, each with what was checked.

1. **The token suite and libraries.** RFC 9497 in verifiable mode (VOPRF), suite `ristretto255-SHA512`, with a key of its own for each size and each period, not the partially oblivious mode. With one key for everything, a copy of the database would make tokens for every period to come; with a key for each period, only for the few hours that period has left. And the apps check every key against the one a request with no session is shown (decision 4), which is as simple with several keys as with one.
   - Rust: [`voprf`](https://crates.io/crates/voprf) 0.5.0, Meta's, MIT, the implementation `opaque-ke` uses, with the RFC's vectors in its own tests (`src/tests/cfrg_vectors.rs`). It takes `curve25519-dalek` 4, `sha2` 0.10 and `elliptic-curve` 0.13, which `crypto/Cargo.lock` already holds. It builds for `wasm32-unknown-unknown`, and `cargo check --target aarch64-apple-ios` passes. 0.6 is still a pre-release. Nothing here says what independent review it's had, and nothing was found that says.
   - Go: `github.com/cloudflare/circl` 1.6.5, Cloudflare's, BSD, with the RFC's vectors in `oprf/testdata`. Its batched proofs are the RFC's (`ProveBatchRFC9497`).
   - Both pass the RFC's VOPRF vectors for `ristretto255-SHA512` in tests of Zuna's own (`crypto/src/primitives.rs`, `server/internal/tokens`), and each other's output: a fixture of tokens blinded by the Rust client and evaluated by the Go server is finalized in Rust and redeemed in Go.
2. **Numbers.**
   - A **period** is six hours, counted from the Unix epoch, and a token redeems in its own period and the next, so it lasts between six and twelve hours.
   - A **small** token is for an envelope up to 32 KiB, which holds any text message, and one with a photo's or video's preview picture (22 KiB at most). A **large** one is for up to the 256 KiB limit.
   - A person may have 1,000 small and 100 large issued in each period, across all their devices, and a bot 10,000 and 500. That's a message every 22 seconds around the clock, for someone who sends nothing larger, where today's `messageLimiter` allows 15 a second.
   - A device fetches 100 small at once once it holds fewer than 40 for the current period, and 10 large once it holds fewer than 4, a random 1 to 10 minutes after it notices, and keeps at most twice that. Reactions, edits, pins and deletions each spend a small one.
   - **The most one person can make a server keep in a day**, if they did nothing else: four periods of 1,000 × 32 KiB and 100 × 256 KiB, 225 MiB. A bot, four of 10,000 × 32 KiB and 500 × 256 KiB, 1.7 GiB. Saving up adds one more period's worth at most. Today it's 10 GiB in all, once, since messages count towards a person's quota.
3. **`sign` takes a 32-byte seed.** `RustCrypto::sign` makes an `ed25519_dalek::SigningKey` from exactly the 32 bytes `signing_keygen` returns, which is the seed. `signing_public` is added beside it.
4. **The token keys live in the database,** in `token_keys`, made at random when a period first needs one, inside a transaction, so that several servers on one PostgreSQL issue and redeem with the same keys, as they have to share which tokens were spent anyway. A copy of the database holds only the keys of the current period and the one before, which make tokens for twelve hours at most, and a token only gets someone past a limit: writing still takes a group's send secret. They're deleted with the tokens spent under them once their period can't redeem any more.
5. **First tokens.** A device fetches its first as soon as it's signed in, and from then on at random times as its stock runs low, never because something is about to go. One that has none, as a new device sending at once, fetches then and sends, which says something only that once. The iPhone's share extension and a phone woken to send use the same database as the app, so they spend the app's tokens, and fetch only when there are none.
6. **Slow mode's margin is two seconds,** by the server's times. A message that came less than slow mode less two seconds after the same author's previous one in that channel is hidden, unless its author is one of the channel's admins. If this device doesn't hold the author's previous one, as when it's from before this device came into the channel, the message shows: nobody can be judged on what isn't there.
7. **Every other place a sender shows,** beyond the table above, found by searching the server and the apps:
   - `server/internal/store/limits.go`, `RecountStorage`: sums messages by `sender_user` and reactions by `user_id`.
   - `store/retention.go`, `mayShareFile` and `inSeenMessage`: share a file by its owner, which names the sender of a message carrying it. `store/files.go`, `CreateFile`'s quota: what a person's files come to now.
   - `api/files.go`, `botMaySendFiles`, called from `handleSendMessage`.
   - `store/messages.go`, `AddReaction`: `maxReactionsByPerson` counts by `user_id`.
   - `store/channels.go`, `takeSlowModeTurn`: `channel_sends` by user.
   - `group_events.sender_user` for commits, which stay named (decision 13).
   - The core: `ingest.ts` (`readableNow`, `ingest`, `couldBeSent`, `retryUndecryptable`, `openReaction`, `openPin`, `deletionProven`, `lookForEarlier`), `push.ts` (what a phone shows before the app opens), `conversations.ts` (last messages, unread counts, the slow mode wait), `lifecycle.ts` (typing and read frames), `groups.ts` (`applyReadState`), `sending.ts` (reactions taken back by `user_id`), and `forwardable`, which names the original's author from the core's own row.
   - `apps/desktop/src`, `packages/ui` and `apps/ios` draw `senderId` from the core and never read the server's: they need only draw a row whose author isn't known.

## For the owner to decide

The owner chose every default, on 2026-11-10.

| Question | Default | The other way |
|---|---|---|
| **What quota means once files belong to nobody** | How much a person may upload in 30 days, counted in whole MiB so that no total gives one file's size away. It no longer falls when messages are deleted | Keep "what one person keeps", with the uploader's device claiming a file's space back once the file is gone, by a key made as item keys are. Exact, with more to go wrong, and a claim names the uploader of a file after it's gone |
| **Slow mode** | Held by the apps (decision 10) | A channel with slow mode on takes named messages only. Simpler, and the server sees who writes there, and can turn slow mode on to see it |
| **Notifications held about 1.5 seconds** | Yes (decision 9) | Not held, and a phone that isn't in use may be told of its own person's message from another device |
| **Messages already on a server stop opening** | Yes, as there's no backward compatibility. They're in the old envelope, which needs the server to say who sent each. Say so in the commit, and clear `.dev-data` | Nothing else is consistent with the rule |
| **Messages nobody can open stay on the server** | Yes, bounded by tokens, hidden by the apps | An admin's app offers to delete what doesn't open |

## Stages

Each stage is one or more commits to `main`, leaves everything working, and ends with its checks run. Follow CLAUDE.md's working rules, and its table of what changes together: almost every stage touches a row of it.

### 1. Cryptography

- A public key from an Ed25519 seed, and the token client: blind, check the server's proof, finish. In `crypto/src/primitives.rs`, then every binding the table lists: `wasm.rs`, `native.rs`, `apps/ios/core-bundle/src/crypto.ts`, `ZunaHost/CryptoBridge.swift`, `apps/desktop/src/host/crypto.rs`.
- The server's side of tokens in Go, in a package of its own with the RFC's vectors as tests.
- **Done when** Rust and Go pass the vectors, a token made by the Rust client redeems in Go, and `npm run test:crypto` and `npm run build:crypto` pass.

### 2. The new envelope

Only the apps change: the server still names senders, and the apps stop listening.

- `sealEnvelope`, `openEnvelope`, `frameSigned` and `readSigned` in `packages/core/src/crypto.ts`.
- Every caller: `session/sending.ts`, `ingest.ts`, `groups.ts` (`applyReadState`), `lifecycle.ts` (`onLiveTyping`), `push.ts`, the soundboard's `play`, a group's and a channel's details if they go through it.
- The rule of decision 6 in `ingest`, with the new state for what's held, and `validate.ts` unchanged in what it lets through.
- `sender_user` empty for what hasn't opened: `types.ts`, then `Models.swift` and `models.rs`.
- **Done when** every existing core test passes behind a test proxy that replaces the server's `sender_user` and `sender_device` with junk in every answer and frame, which proves nothing reads them.

### 3. The send key

- Server: a send key with each commit and each undoing, held and restored with group info, returned with a group and with commit events. Both migrations lists, at the end.
- Core: derive it with the content key (`rememberCurrentEpochKey`, and the pending one in `session/joining.ts`), send it with every commit through `commitWithRetry`, check the server's on applying and syncing, put a wrong one right.
- **Done when** tests show a wrong key noticed and replaced, and the right key back after `VoidCommits`.

### 4. Tokens

- Server: issuing behind `withDevice` with a limit by person, keys that change, spent tokens kept until their key is gone, and cleared with it in `background.go`.
- Core: a sealed table of tokens in `db.ts`'s `MIGRATIONS`, fetching ahead, the hash of the token key in signed bodies and the warning when one differs.
- **Done when** a spent token is refused, an old one is refused, a person past their limit gets no more, and two devices of one person share the limit.

### 5. Requests without a session

- A second way to make a request in `packages/core/src/api.ts` that never sends the token and takes the host's separate connection, signed with the send secret over the method, path, time, token and body, as `requestProofInput` does for a device.
- `natives.d.ts` and both native hosts, the bot's host, the tests' host, the web's.
- Server: a `sealed` wrapper beside the others in `server.go`, which checks the address's limit, the signature against the group's send key, the time and that it's new (`seenProofs`), and hands the token to the handler. Add the new headers to `Access-Control-Allow-Headers`.
- **Done when** a test proxy in front of the test server sees no `Authorization` on any sealed path, and the hosts' own tests show a second connection.

### 6. Sealed messages, edits, deletions, reactions and pins

- Server: the routes, `CreateMessage` and the rest without a user, the item key beside each message and reaction, tokens spent in the transaction. The named routes for these go in the same commits.
- Core: item keys, `deliver`, `sendSignal`, `deleteSigned`, `setPinned`, `toggleReaction`, and the moderator's named deletion.
- **Done when** the tests under "Tests" for these pass, in SQLite and with `ZUNA_TEST_POSTGRES`.

### 7. Taking the sender out of what's kept

- Migrations that drop `sender_user`, `sender_device`, `pinned_by`, `pin_by` and `deleted_by` from messages, `user_id` from reactions, and `channel_sends`. `ApiMessage` and `ApiReaction` lose them.
- `stored_bytes` no longer counts messages, and `RecountStorage` follows.
- `PushTargets` without a sender, the hold in `pushMessage`, and the read after sending in the core.
- Slow mode and the reaction limit in the core, and the composer's wait in each interface.
- **Done when** a test opens the server's database after a conversation with every kind of content in it and finds no user or device ID in any row about a message, a reaction or a file a message carries, and no column that rose by a message's size.

### 8. Typing

- A sealed route that passes typing on and keeps nothing. The socket's `typing` frame goes.

### 9. Files

- Decision 8 on the server and in the core, the share secret in `Attachment` (`types.ts`, `Models.swift`, `models.rs`, `validate.ts`), forwarding, and the quota the owner chose.
- **Done when** a file in a message has no owner in the database, forwarding still shares it, and someone without the secret can't attach it.

### 10. Interfaces and parity

- Rows with no known sender, the slow mode wait, and whatever warning decision 4 adds, in `apps/desktop/src/ui`, `packages/ui` and `apps/ios`.
- `.agents/FEATURE_PARITY.md` in each commit, with a Known gap for whatever a platform lacks. The web's shared connection is "Not possible or pointless there". Swift can't be built on Windows: say so in those commits.

### 11. Documents

- `SECURITY.md`: the table's rows for messages, reactions, pins and deletes, files and typing, a paragraph under "How it works", and under "Limits" what a determined server can still work out and that a member can post what nobody can open.
- `SECURITY_DETAILS.md`: "Message content" for the envelope, and a section on the send key, tokens and item keys.
- `ARCHITECTURE.md`: the server's job, and the key hierarchy.
- `ROADMAP.md`, `BOTS.md` for a bot's limits, `SELF_HOSTING.md` and `LINUX.md` for what quota means and that a proxy's access log holds addresses, `CLAUDE.md` for the new rules the core depends on, the `sealed` wrapper, and a row for what changes with the envelope.
- `apps/site`: `Security.tsx`, `Compare.tsx`, `Faq.tsx` and `Privacy.tsx` speak of what the server sees. Change them in the same commit as the docs, and only to what's been checked.
- This file becomes `docs/SEALED_SENDER.md`.

## Tests

End-to-end tests go in `packages/core/test`, in a file of their own, driving real clients against a real server. Each of these is an attack or a promise, and each must fail before its stage and pass after.

- **The server is told nothing:** no sealed request carries a session, and no frame or answer about a message names a user or device.
- **The server keeps nothing:** the database check of stage 7.
- **Members still know:** every existing test of who wrote what passes unchanged.
- **Someone removed can't write,** with the last epoch's send secret.
- **Someone on the server who isn't in the group can't write to it,** with tokens of their own.
- **A member can't write as another:** a body that names someone else, signed by nobody or by the writer, is shown nowhere and notifies nobody.
- **A signed body can't be moved** to another group, message or epoch, or sealed again under another key.
- **A member can't edit, delete or take back what isn't theirs,** and the author's other device can, also after the account's keys were replaced.
- **A token works once,** and only for its size and its time.
- **One member can't use up a group:** past their own tokens they're refused while others still send.
- **The sender's idle phone isn't woken, and everyone else's is,** within the hold.
- **Slow mode holds** an honest app, and hides a changed app's extra message on everyone else's.
- **A wrong send key is noticed and put right,** and undoing a commit brings the right one back.
- **A file loses its owner** when a message carries it, and forwarding needs its secret.
- **Bots:** `npm run test:bot`, with a bot that answers and presses nothing it shouldn't.

Then the checks CLAUDE.md asks for after such changes: `npm run typecheck`, `npm test`, the server's and the core's tests with `ZUNA_TEST_POSTGRES`, the web's check, `cargo test` in `apps/desktop`, and the golden file if `Attachment` changes what the markup sees.

## What a determined server can still tell

List these in `SECURITY.md` as they stand once it's built, and don't call any of it hidden.

- **The address** a sealed request comes from, which is also the address of that device's socket.
- **In the web app, the connection,** which a browser shares with the session's requests.
- **Timing:** a device coming online, typing arriving from the same address as the message after it, a file uploaded just before a message carries it, a commit just before a message, a read position just after.
- **Who it didn't have to wake,** and who never fetched a file because they already had it.
- **Two people.** In a direct message, who wrote is one of two, and most of the above settles which.
- **Tokens asked for** just before sending, when an app had none left.

## Later

- Sealing commits that change no membership, so that renewing keys names nobody.
- Hiding who's in a conversation from the server, which is a different design: the server delivers by membership today.
