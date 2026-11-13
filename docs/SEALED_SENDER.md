# Sealed sender

Nothing a member adds to a conversation tells the server who sent it, and nothing the server keeps says. This says what was built, how, why, and what it doesn't do, for whoever changes it next. It was planned and built on 2026-11-10.

[SECURITY.md](../SECURITY.md) says in plain words what it promises, and "Sealed sender" in [SECURITY_DETAILS.md](SECURITY_DETAILS.md) says it in full. Read both, and [ARCHITECTURE.md](ARCHITECTURE.md), before changing any of it, as for any change to cryptography.

## What it does

- **The server isn't told who sent something in a conversation.** A request that adds to one carries no session, no user, no device and no signature a known key checks: messages, edits, an author's own deletions, reactions and taking them back, pins and unpins, and typing. Bots send the same way. No named route for any of these stands beside the sealed one.
- **The server keeps nothing that says it.** Messages and reactions have no column for who sent, pinned or deleted them, a file a message carries has no owner, and no total rises by a message's size.
- **Members still know.** Every app learns who wrote what from a signature inside the encryption, and checks it as before.
- **Nothing got weaker.** A member can't use being unnamed to write as someone else, or change or delete someone else's messages. Tokens bound how much they can add, and what each thing added makes everyone else carry is bound too: a reaction goes to members on its own, never with the message and all its others, a message's reactions are held to a total size, past the first hundred each costs a large token, and a group's admin's app has the server drop any that open for nobody.

What it doesn't do:

- **The server still knows who's in each conversation.** It hides which member wrote, not who the members are. In a direct message that leaves two people.
- **A server that sets out to can often work a sender out,** from addresses and timing, as the last section lists. Signal's sealed sender has the same limit. The claim is about what the server is told and keeps, never "the server can't know".
- **Commits, undoing them, a group's details, a group admin deleting someone else's message, read positions, files being uploaded and fetched, calls, voice, presence and reports** still name who they're from. Each is about someone being somewhere, or something the server has to check.

## Who it's against

| Against | What they have | What holds |
|---|---|---|
| **A copy of the server's data** | The database, files and logs, once or over time: a break-in, a backup, a seizure | No sender of any content, and no exact way to work one out, but for a file's on a day few people uploaded, as the last section says |
| **An honest server someone watches** | Whatever the server as written receives | It's never handed a sender, so there's nothing to write down or hand over |
| **A server changed to find out** | Addresses, timing, every request | Not promised. It's no easier than timing and addresses already made it |
| **A member** | The conversation's keys | Can't write as anyone else, can't touch others' messages, and can't cost the conversation more than they could with their name on it |

A mechanism that hands the server the sender and asks it not to look fails the second row, however little it stores.

## How it works

### The envelope, with the signature inside

```
envelope   = nonce || XChaCha20-Poly1305(content key, aad, pad(inner))
inner      = 4 || user ID || device ID || signature || body          (the IDs with their lengths)
signature  = Sign(device key, "zuna/envelope-sig/v4|user|device|" || SHA-256(aad) || commitment || SHA-256(body))
             a device's hybrid signature, Ed25519 and ML-DSA-44 together, 2,485 bytes
commitment = HKDF(content key, "zuna/envelope-commit/v1")
aad        = kind, group, item, epoch
```

`sealEnvelope`, `openEnvelope` and `checkEnvelope` in `packages/core/src/crypto.ts`. Every kind goes in it: messages, reactions, pins, deletions, typing and read positions. `frameSigned` is `[3, epoch (u32), envelope]`, with no device in the clear.

- **Who signed is inside,** so the server can't try each member's device key to find whose it is, as it could when the signature was over the ciphertext.
- **The commitment keeps what signing the ciphertext gave:** a good signature proves its signer used this very key, which a key from a history grant proves itself by (`keyProvedItself`). Without it, a member who opens someone's signed body could seal it again under a key of their own choosing. A test fails without it.
- **The authenticated data names the group, the item and the epoch,** so a signed body can't be moved.

`checkEnvelope` says one of four things, and `ingest` in `session/ingest.ts` acts on each:

| It | What happens |
|---|---|
| Opens under a key this device trusts, and a device it knows signed it | Shown, checked as always (`couldBeSent`, `changedAfterLeaving`, `editedSince`, the author never changing) |
| Opens, and names a device this one doesn't know yet | Held in `withheld`, shown nowhere, and tried again once people and devices are caught up (`learnDevice`, `retryWithheld`) |
| Doesn't open under a key that has proved itself, or nobody it names signed it | Nobody's: kept in `withheld` without being shown, counted or notified about, and never as from whoever it names, then forgotten after 30 days. This is what stops one member framing another |
| This device has no key for its epoch | A message that can't be opened yet, as always |

The author of a row that hasn't opened isn't known, so its `senderId` is "", and the native app, the web and iOS draw it under no name, with no avatar, and never run it on with the one before. A message is never taken as from someone because the server said so: the server doesn't say. The core's tests pass behind a proxy that scrambles any sender field the server might send (`packages/core/test/junk-proxy.ts`, `ZUNA_TEST_JUNK_SENDERS=1`), which proves nothing reads one.

### The send key: being a member, shown with a key every member holds

```
send secret = MLS-Exporter("zuna/send/v1", epoch, 32)      an Ed25519 seed
send key    = its public half, which the server holds for the group's current epoch
```

- **Whoever makes an epoch gives the server its send key** with the commit (`send_key`), external commits too. The server can't check it, and needn't.
- **A sealed request is signed with the send secret,** and the server checks it against the one key it holds for the group. Any member's signature looks the same.
- **Only the current epoch's key is taken,** so someone removed can't write. A request for an older epoch is answered `409 stale_epoch`, and `sealAndRetry` tries again.
- **The server forgets the key when a device goes without a commit:** its person leaves, is banned or deletes their account, or the device is signed out or removed (`voidSendKey`, `voidSendKeysOf` in `server/internal/store/commits.go`). That device is still in the tree, so it would make the key, and pay with tokens it fetched before, until a member's commit took it out. Nothing sealed is taken for the group until that commit gives the next epoch's key, which an app sends before anything else (`ensureTreeClean`), and a send refused with `not_sealed` reads who's in the group again and does the same.
- **The secret is never stored or handed on,** like `voiceKey`: not in the vault, not in a history grant. Its exporter label isn't the content key's, so holding old content keys gives no way to write.
- **Every member checks the server's key against its own** when it applies a commit or reads the group (`checkSendKey` in `session/changes.ts`). One that differs is put right by a member's commit after a random wait, as every commit carries a key.
- **Undoing commits restores it:** the server holds each send key beside its group info (`group_infos.send_key`, and the replaced key on the undone commit's event), and restores both together.

`sendKey` in `session/groups.ts`; `SendKey` in `server/internal/store/messages.go`, and the undoing in `commits.go`.

### Tokens: a limit on a person the server can't follow

A limit on a person needs a name, and a limit on a whole group would let one member use it up for everyone. So each sealed request that changes something spends a token the server issued to someone signed in, and can't tie back to them.

- **[RFC 9497](https://www.rfc-editor.org/rfc/rfc9497.html)'s verifiable oblivious PRF, suite `ristretto255-SHA512`.** In Rust, Meta's [`voprf`](https://crates.io/crates/voprf) 0.5.0, in `crypto/src/primitives.rs` (`tokenBlind`, `tokenFinalize`) and every binding; in Go, Cloudflare's `circl` 1.6.5, in `server/internal/tokens`. Both pass the RFC's vectors in tests of Zuna's own, and each other's output (`crypto/src/testdata/rust-client.json`). Nothing found says what independent review `voprf` has had.
- **A key of its own for each size and each six-hour period,** made at random when a period first needs one and kept in `token_keys`, so several servers on one PostgreSQL share them. A token redeems in its own period and the next, and the keys are deleted with the tokens spent under them once their period can redeem none (`background.go`). A copy of the database makes tokens for twelve hours at most, and a token only gets someone past a limit: writing still takes the send secret.
- **Two sizes.** A small token pays for an envelope up to 32 KiB, which holds any text message and one with a preview picture; a large one for up to the 256 KiB limit.
- **Limits, counted against the person across their devices** (`token_issues`): 1,000 small and 100 large in each period, and for a bot 10,000 and 500. The most one person can make a server keep in a day is about 225 MiB, and a bot 1.7 GiB.
- **Asked for while signed in, at times of their own** (`POST /api/tokens`, behind `withDevice`): a device fetches 100 small once it holds fewer than 40 for the current period, and 10 large below 4, a random one to ten minutes after it notices, and its first as soon as it's signed in. One with none, as a new device sending at once, fetches then and sends, which says something that one time. They're kept sealed in the core's `tokens` table (`session/sending.ts`, the Tokens part).
- **Spent in the same transaction as the write,** so one refused for `stale_epoch` costs nothing (`spent_tokens`). Reactions, edits, pins and deletions spend a small one. Typing spends none.
- **What changes nothing costs nothing, and is told to nobody.** A message sent again with the item key it came with, a reaction added again and a deletion of what's deleted spend no token, so they're not sent on to the group or pushed either: any member, whom nothing names, could otherwise have the server send a message it holds to everyone as often as they liked.
- **Everyone must be shown the same keys.** `GET /api/tokens/keys` takes no session, and the server proves each batch was evaluated under the key shown there. Each signed body carries a short hash of the keys its sender was shown (`tokenKeys`), and an app whose own differ for the same period warns once (`compareTokenKeys`), as a key made for one person would let the server follow their tokens.
- **Bots** get tokens at a bot's pace. There's no pace for a bot in each chat any more: it can't be held without a name, and members see a bot flooding and remove it.

A token on the wire is the period (8 bytes), the size (1 byte), the input (32) and the output (64).

### Sealed requests: nothing shared with the session

`sealedRequest` in `packages/core/src/api.ts`, and the `sealed` wrapper in `server/internal/api/sealed.go`.

```
POST   /api/sealed/groups/{id}/messages
PUT    /api/sealed/groups/{id}/messages/{mid}              an edit
DELETE /api/sealed/groups/{id}/messages/{mid}              an author's own deletion
POST   /api/sealed/groups/{id}/messages/{mid}/reactions
DELETE /api/sealed/groups/{id}/messages/{mid}/reactions/{rid}
PUT    /api/sealed/groups/{id}/messages/{mid}/pin          and DELETE to unpin
POST   /api/sealed/groups/{id}/typing
```

- **Headers:** `X-Zuna-Seal`, the send key's signature; `X-Zuna-Time`; `X-Zuna-Epoch`; `X-Zuna-Token`; and `X-Zuna-Item`, the item key's signature, to change or delete something. What's signed is `zuna/sealed/v1|METHOD|PATH|TIME|EPOCH|`, then the SHA-256 of the token and of the body.
- **The wrapper checks,** in order: the address's limit, the epoch, the signature, the time, that it's the first time this signature was seen, and that the token is well formed. The handler spends the token with its write. Nothing a sealed route keeps says who sent it, and its log lines carry no address.
- **No `Authorization`, no cookie, nothing kept from an earlier request.** The native app sends them on a second `reqwest::Client` (`sealed_http` in `apps/desktop/src/host/runtime.rs`), the iPhone on a second ephemeral `URLSession` (`sealedSession` in `ZunaHost/NetworkBridge.swift`), and `zuna-bot` and the tests on a second undici `Agent`, each with connections and TLS sessions of its own (`ZunaClientOptions.sealedFetch`). A browser decides for itself which connection a request takes, so the web app only leaves its credentials out.
- **Typing** is passed on without a name and kept nowhere, held by a limit for each group and address. The socket's typing frame is gone.

### Item keys: only an author changes what's theirs

```
author root = subkey(account key, "author")
item secret = HKDF(author root, "zuna/item-key/v1|kind|group|item")     an Ed25519 seed
```

- **A message and a reaction each go up with their item key's public half,** which the server keeps beside them (`item_key`), and checks an edit, an author's deletion or a reaction taken back against (`itemSigned`).
- Item keys can't be told apart or tied to anyone without the author root, so they name nobody. The same message ID sent again is a retry only with the same item key.
- **A reaction taken back keeps its ID on the server,** without what it carried (`reactions.removed_at`). What a reaction carries is signed by whoever added it, and every member was sent it, so another member could otherwise send the same bytes again under the same ID with an item key of their own: it would show as its author's, who couldn't take it back. A deleted message's row stays for the same reason.
- **Any of the author's devices can make one.** After the account's keys are replaced, a device tries the root from each key it holds, the older ones included (`itemSecret`, `heldItemSecret`).
- **It only stands in for the server's own check.** What the apps trust is still the signature inside.

### A group admin deleting someone else's message stays named

It needs the admin's role, which is the server's to check, and it says who moderated, not who wrote (`moderateMessage` in the core, and `handleDeleteMessage`, with the device's proof, in the server). The server doesn't keep who: the proof inside says so to the apps. In a direct message there's only the author's own deletion.

### Files belong to someone until a message carries them

- **Uploading is named,** and counted against the uploader.
- **A file is made with the SHA-256 of a share secret** (`share_hash`), and the secret travels inside the message with the file's key (`Attachment.share`).
- **A sealed message shows each of its files' secrets,** which the server checks, ties the file to the message, and clears its owner. Forwarding shows the same secret, so it still shares the file rather than uploading it again.
- **Who may fetch a file, and when it's removed,** go by the messages that carry it, as before. What a bot may upload is checked as it uploads.
- **Quota is what someone uploads in 30 days, counted in whole MiB** (`uploads`), so no total gives one file's size away. It doesn't fall when messages are deleted. `stored_bytes` counts the vault alone.

### Waking phones without knowing whose message it is

- **Every notification waits about a second and a half** (`defaultPushHold` in `server/internal/api/push.go`), through the same hold as a push waiting while someone is on another device.
- **The device that sent a message reads it at once,** at its own message. That cancels the push for its person's phones, and looks the same as anyone reading as it arrives.

A phone that's in use is never pushed, as before.

### Slow mode and the most reactions are held by the apps

The server can't hold someone it can't see to a pace. Each app holds its own person to a channel's slow mode before sending (`slowModeHolds`), and hides a message from anyone else that came sooner after the same author's last than the channel allows, less two seconds for the network, by the server's times (`cameTooSoon`, `SLOW_MODE_MARGIN_MS`), unless its author is one of the channel's admins. One whose author's previous message this device doesn't hold shows. The 32 reactions one person may put on a message are held the same way (`readReactions`). Tokens bound how much a changed app can send past either.

### Commits stay named, and old epochs are renewed as groups sync

A commit that changes who's in a group names people by its nature, and the server holds back whoever sends bad ones by name. Renewing a week-old epoch is done as a group is synced, by whichever member's random wait ends first (`rotateIfOld`, from `reconcile` in `session/changes.ts`), so sending rarely has to commit first, which would say who sent what came next. Sending still renews one that syncing hasn't, and removes anyone who shouldn't hold the keys (`ensureTreeClean`).

## What the owner chose

| Question | Chosen |
|---|---|
| What quota means once files belong to nobody | Uploads in 30 days, in whole MiB |
| Slow mode | Held by the apps |
| Holding notifications | About 1.5 seconds |
| Messages already on a server | They stopped opening, in the old envelope, as there's no backward compatibility |
| Messages nobody can open | Stay on the server, bounded by tokens and hidden by the apps |

## Tests

`packages/core/test/sealed-sender.test.ts`, driving real clients against a real server, each an attack or a promise:

- The send key is given with every commit and is what every member makes; a wrong one is noticed and put right; undoing a commit brings the right one back.
- An old epoch is renewed as its group is synced, so sending needn't commit just before.
- Tokens are fetched at once and kept sealed, fetched again a while after running low and at once when there are none, and a device warns when someone was shown other keys.
- No sealed request carries a session, and nothing the server says of a message names anyone.
- Someone removed can't write with the last epoch's send key, and someone outside the group can't with tokens of their own.
- Someone who left or was banned can't write with the key their device still makes, and those who stay send again at once.
- A reaction someone took back can't be put back as theirs by another member.
- What nobody signed, or what names another, shows nowhere and notifies nobody.
- A signed body can't be moved to another group, message or epoch, or sealed again under another key.
- Only an author changes, deletes or takes back what's theirs, from any of their devices, also after their keys were replaced.
- A token works once, and a member past their own can't send while others still do.
- The sender's phone is spared by its device reading at once.
- Slow mode hides a changed app's message that came too soon.
- A file belongs to nobody once a message carries it, and is shared again only with its secret.
- The server's database, after a conversation with every kind of content in it, names nobody in any row about a message, a reaction or a file one carries.

The Go side is in `server/internal/api/sealed_test.go`, `tokens_test.go` and `server/internal/tokens`, and `zuna-bot`'s tests run grammY's echo bot through all of it. `sealed_audit_test.go` beside them holds what an audit on 2026-11-10 found and fixed, each as the attack it was: a device that left, was banned or signed out writing with the key it held, a reaction taken back being put back by another member, and requests that cost no token being sent on to everyone.

## What the audit left as it is

- **The server says a group's epoch before it checks the signature,** as it holds only the current epoch's key and a member who's behind signs with an older one. Someone who knows a group's ID, as a former member does, can ask how many times its keys have changed since.
- **A message the server's retention erased can be sent again by a member** while its epoch lasts, with its ID and the bytes its author signed, as nothing is left to say the ID was used. It shows as its author's, at a new time, with the note apps show when a message's own time differs from the server's. A disappearing message can't: it runs out by its signed time, wherever it arrives (`expiryOf`).
- **A pin's proof can be sent again** by a member, as it could before sealed sender. Apps take the latest by its signed revision, so only a device that never saw a later one shows it.

## What wasn't checked

- **PostgreSQL.** The new SQL ran in SQLite only, as the machine it was built on had no PostgreSQL. Run the server's and the core's tests with `ZUNA_TEST_POSTGRES`.
- **A row with no known author on iOS.** Its drawing was written on Windows and builds on a Mac, but no test has such a message, and nobody has looked at one. iOS's sealed connection, written the same way, has run since: the core's tests on the iOS host and the app's UI tests send through it.
- **The native app on Linux and macOS,** which was built on Windows only at the time. Every release has built it on both since.
- **The web's check in Firefox and WebKit,** which don't run on that machine. Chromium's passed every step up to the bots, which fail as they did before sealed sender.

## What a determined server can still tell

- **The address** a sealed request comes from, which is also that device's socket's. With a SOCKS5 proxy set, in the desktop app, the iPhone app or `zuna-bot`, it's the proxy's address instead, and still the same for both.
- **In the web app, the connection,** which a browser may share with the session's requests.
- **Timing:** a device coming online, typing just before a message from the same address, a file uploaded just before a message carries it, a commit just before a message, a read position just after.
- **Who it didn't have to wake,** and who never fetched a file because they already had it.
- **Two people.** In a direct message, who wrote is one of two, and most of the above settles which.
- **Tokens asked for** just before sending, when a device had none left.

And from a copy of its data alone, with nothing watched:

- **Who uploaded on which day.** Quota keeps how many MiB each person uploaded each day, for thirty days (`uploads`), and a file keeps when it was made. On a day only one person uploaded, the files made that day were theirs, and so was each message that first carried one.
- **Who was issued tokens** in the last twelve hours, and how many (`token_issues`), which says who was about to send something, not what.

## How it was built

The plan had eleven stages. The cryptography, the envelope, the send key and tokens each landed on their own. Requests without a session, the sealed routes, taking the sender out of what's kept, typing and files landed together, in "Seal what members add to a conversation, and keep no sender of it": a sealed send has no user for the server to check a file's owner, take a slow mode turn or leave the sender's phones out by, so files' secrets, slow mode in the apps, the push hold and the read after sending had to come with it. The interfaces' rows with no known author, and renewing old epochs as groups sync, came after the documents, and this file last.

Two things came up on the way. Windows Defender started taking Go test servers with a build ID for a trojan, so every build drops it (`-buildid=`). And with no server round trip to wait on, a message held back for slow mode could leave one after it in another chat waiting, so the outbox takes another pass for anything queued while it was sending (`flushAgain`).

## Later

- Sealing commits that change no membership, so that renewing keys names nobody, with an answer for holding back whoever sends ones nobody can apply.
- Hiding who's in a conversation from the server, which is a different design: the server delivers by membership.
