# Key transparency: plan

**Status:** a plan, written on 2026-11-11 against commit `9b4d8fed`. Nothing here is built, and nobody independent has reviewed it. Section 12 is what a reviewer and the owner should look at first.

**Scope:** which keys and devices each account on a server has. Today that's whatever the server says, held to the signatures it can't forge. This plan makes it a record the server can't change afterwards, can't show differently to different people without leaving proof, and that every account's own devices read.

**The owner's constraint holds:** no part of this may add a step, prompt or setting for people using the app.

Read [SECURITY.md](../SECURITY.md), [SECURITY_DETAILS.md](SECURITY_DETAILS.md) and [ACCOUNT_KEY_ROTATION.md](ACCOUNT_KEY_ROTATION.md) first. This builds on generations, links and carried devices, and uses their words.

## 1. Summary

1. **Each server keeps one log:** an append-only Merkle tree with an entry for every change to who holds which keys. An account is made, a device is added or removed, a certificate is replaced, an account moves to a new generation, an account is deleted. The entry is written in the same transaction as the change.
2. **The server signs the log's head:** how many entries there are, and the tree's root.
3. **Every device reads the whole log,** as it already reads the whole list of people, and works the root out itself. So there are no proofs to ask for, and nothing about anyone can be left out without the root coming out wrong.
4. **A key or a device counts only if the log names it.** That's one more condition in the one place a certificate is judged today (`certificateStanding` in `session/chains.ts`).
5. **Each account's devices look for themselves in it.** Whatever a contact would accept for an account, that account's own devices are shown too, and they hold it to what they know.
6. **Devices tell each other which head they hold,** where the server can't touch it: inside signed messages, in the account's vault manifest, and in invite links. Two heads that don't fit together are proof the server told two stories.

Three limits, stated plainly because they decide whether this is worth building:

- **It finds out, and doesn't prevent.** A server can still hand out a false key. What changes is that the key's real owner sees it, or the server has to keep two logs, which the first message between the two sides gives away. The emoji check stays the only proof.
- **Someone kept apart from everyone, from their first moment, learns nothing.** Devices compare heads through each other. A server that plays every one of a person's contacts to them has nobody honest left to compare with, until that person compares emoji with anyone at all (section 8).
- **Nobody outside the server checks the log.** There's no central service in Zuna, so there are no outside auditors or witnesses. The members' devices are the auditors.

## 2. Terms

| Term | Meaning |
|---|---|
| Log | A server's append-only list of entries, hashed into a Merkle tree as RFC 6962 does. |
| Entry | One change to an account's keys or devices. It has a record and a body. |
| Record | The 80 bytes of an entry that go into the tree. Everyone gets every record. |
| Body | What the entry says, as JSON. Only those the account is there for get it. |
| Tag | A short hash in a record that whoever knows an account's ID, or its username, can recognize, and nobody else can. |
| Head | An era, a size and the root of the tree at that size, signed with the log key. |
| Log key | An Ed25519 key the server makes once, and signs heads with. |
| Era | A number that goes up when a server starts its log again, as after restoring a backup. |
| Frontier | The roots of the full subtrees a tree of some size is made of, at most one for each bit of the size. It's all a device needs to keep to append to a tree and find its root. |

"Server", "reader" and "holder" mean what they do in section 4 of [ACCOUNT_KEY_ROTATION.md](ACCOUNT_KEY_ROTATION.md): a malicious operator, a copy of the server's data, and someone with an account's keys as of some generation.

## 3. What a server can do today

Checked against the code at commit `9b4d8fed`. Short paths are in `packages/core/src/` and `server/internal/`.

| | What happens | Where |
|---|---|---|
| 1 | **The first key for someone is whatever the server shows.** A device pins it, and only comparing emoji shows it was false | `applyUser`, `session/local.ts:293` |
| 2 | **Each person is told about devices separately.** Nothing makes what Alice is shown of Bob's devices agree with what Bob is shown. Bob's "a new device just signed in" alert comes from the same list, so it's the server's to send or not | `GET /api/users`, the `user` frame, `session/local.ts:336` |
| 3 | **A rotation or a removal can be kept from a contact.** A contact follows a chain when the server says the generation went up, or when a leaf in a shared tree names a newer one. With neither, they go on counting a removed device | `followChain`, `session/chains.ts:136`, and section 9.2 of the rotation's design |
| 4 | **With an old identity key and the server, a contact can be shown a false link,** if they haven't seen the real one | "Limits" in `SECURITY.md` |
| 5 | **With the current identity key and the server, a device can be added that contacts accept,** and kept from the owner's list | Section 10 of the rotation's design, first row |
| 6 | **A brand-new device can be served an old generation,** or with a holder's help, keys of the holder's choosing | "Limits" in `SECURITY.md` |
| 7 | **An old seal key can be offered again** to a device that never saw the newer one | `sealKeyOf`, `session/chains.ts:288`, and question 15 of the rotation's design |
| 8 | **An account can be made under a name that's taken,** and shown to one person in place of the real one. Usernames are unique only because the server says so | `usernameTaken`, `store/bots.go` |

What already holds, and stays exactly as it is: a certificate needs the identity key's signature, a link needs three, a device removed by a link stops counting whatever the server says, pins and the manifest keep what a device has seen, and the emoji check proves a key. The log replaces none of it. It covers what signatures can't: what was never shown, and what was shown to someone else.

## 4. Attackers and goals

| Attacker | Has |
|---|---|
| **Server** | Reads and writes all server data, signs heads, answers each device as it likes |
| **Holder and server** | The above, and an account's identity key, old or current |
| **Member** | An account on the server, a modified app, the conversations they're in |

**Goals**, for devices that hold the same head:

- **K1. One story.** What the server told one of them about anyone's keys, it told the others.
- **K2. Nothing left out.** Each knows every change up to that head, for every account that's there for it.
- **K3. Owners see what's said of them.** A key, device or link a contact would accept for an account is in front of that account's own devices, and so is another account under its username.
- **K4. Two stories leave proof.** Devices shown different logs find out from the first signed message that passes between them, and hold two signatures by the log key that can't both be true.
- **K5. A member can't make it look like the server lied.**
- **K6. Nobody does anything new.**

**Not goals:** stopping a false key before it's used, hiding who's on a server from its members, who already have the list, keeping a server from refusing service, a device that's compromised now, and anyone outside the server checking it.

## 5. The design

### 5.1 Why every device reads all of it

Other systems (section 9) let a device ask about one person and get a short proof, because nobody there can hold the whole directory. Here everybody already does: the conversation list is flat, so `syncUsers` fetches every account with every device's certificate. A log that every device reads in full costs less than that, and it needs no proofs, no verifiable map, no new cryptographic primitive, and no auditor.

- **Size.** A record is 80 bytes and a body about 150. A server of 200 people that has seen 2,000 changes is 160 KB of records, once for each device, then only what's new. A hundred thousand changes is 8 MB of records, which a device reads in the background.
- **Nothing to get wrong.** A device appends each record to its frontier and compares the root with the signed one. That's the whole check. Inclusion and consistency proofs aren't used anywhere.
- **Leaving something out is impossible, not just detectable.** A device that has every record can test each against any account it knows (5.3), so the server can't pass one over.

If servers ever outgrow this, the log is the right base for the proofs the other designs use, and nothing here would have to be undone.

### 5.2 Entries

Every change to an account's keys or devices appends one entry, inside the transaction that makes the change. A change that isn't in the log didn't happen, as far as devices are concerned.

| Kind | Says | Written by |
|---|---|---|
| `account` | The account's ID, its username, the identity key it began with, its first HPKE key | `CreateUser` |
| `device` | A device's ID and signing key, and hashes of its certificate, its enrollment proof and its seal key | `AddDevice` |
| `certificate` | The hash of a device's new certificate | `SetDeviceCertificate` |
| `seal` | The generation and hash of a device's new seal key (Stage 6) | `SetDeviceSealKey` |
| `revoked` | A device is gone | `revokeDevice`, and for each device in `BanUser` and `DeleteAccount`, which revoke in bulk today |
| `link` | A generation and the hash of its link's payload, before that rotation's `revoked` entries | `ApplyRotation` |
| `deleted` | The account is deleted, and its username is free | `DeleteAccount` |

Bodies carry hashes of certificates and links, not the things themselves. Those go on travelling as they do now, in `GET /api/users`, in MLS leaves and from `GET /api/users/{id}/identity-links`, and are held to the hash.

Nothing in an entry says when. Other people aren't told when someone's devices were added or removed (`seenByOthers` in `api/users.go`), and the log keeps to that. It does give the order of changes, which someone who's always connected sees already.

### 5.3 Records, tags and private bots

Everyone must get every record, or roots couldn't be worked out. But a private bot is there only for its owner and the people in a chat with it. So a record says nothing by itself:

```
record = nonce (16) | user tag (16) | name tag (16) | body hash (32)
```

- **The user tag** is a hash of the account's ID and the nonce. IDs are 16 random bytes, so only someone who knows an ID can tell a record is about it.
- **The name tag,** on an `account` entry, is a hash of the username and the nonce. On every other entry it's 16 random bytes, so nobody can tell kinds apart.
- **The body** goes only to those `canSee` allows, as everything else about an account does.

A device checks tags in both directions:

- **A body it's given** must hash to the record, name an ID the user tag fits, and for an `account`, a username the name tag fits. So a server can't file an entry about Bob under a tag Bob wouldn't recognize.
- **A record it's given no body for** is tested against every ID the device knows, its own first, and against the usernames it knows. A match means the server is keeping back something about someone who's there for this device. It asks again, and says so if that goes on.
- **When an account becomes visible later,** as a private bot does to someone added to a chat with it, the device tests the records it holds against the new ID and asks for those bodies (`GET /api/log/bodies`).

What leaks: a modified app can count records about nobody it can see, which says that private bots exist and that their keys changed, and can test guesses at a private bot's username offline, where today it would have to try signing up under each. `SECURITY.md`'s row for bots will say so.

### 5.4 Heads

A head is `{ era, size, root }` and the log key's signature over it. The server signs one whenever the log grows.

- **No time in it.** A time on every head would tell everyone when a device was added or removed. A head's size only goes up, and that's all the order devices need.
- **The log key** is made once and kept in the database, as token keys are. Its public half is in `GET /api/info` for someone signed in.
- **Devices pin it** from the invite link they joined with (5.8), or failing that from the first answer, and keep it in the manifest, so an account's later devices take it from there and not from the server.

The signature is what gives K4 and K5. Without it devices would still notice that roots differ, but any member could make one up, and nobody could show anyone else what the server did.

### 5.5 Reading and checking

A device holds every record, the root after each, and the bodies it was given, in a local table. `GET /api/users` says the log's era and size, so an app coming back from the background asks for the log only when it grew, and a `log` frame on the socket says so live. The log is read before the list of people, since the list is judged by it.

For each batch of new records, in order:

1. Append each record to the frontier. The root at the batch's end must be the signed head's, the signature must be the pinned key's, and the size mustn't be less than what's held.
2. Check each body against its record and its tags (5.3).
3. Apply each body, by its kind:

| Kind | Rule | Breaking it |
|---|---|---|
| `account` | The first for this ID. Its username isn't held by an earlier account with no `deleted` entry. If this device has a pin for the ID, the key is the pin's | A second for an ID, or a key that isn't the pin's, is today's `changed`. An account under a held name counts for nothing, and its devices with it |
| `device` | The account exists and isn't deleted, and the device's ID is new for it | Ignored, and said once |
| `certificate`, `seal` | The device exists and isn't revoked | Ignored |
| `revoked` | The device exists | Ignored |
| `link` | Its generation is the account's next. The link fetched for it must have the payload hash the entry names, and then passes `verifyLink` as today | A second for a generation is today's fork (`noteFork`). A link the server won't hand over is a generation this device knows it's missing, and it keeps asking |
| `deleted` | The account exists | Ignored |

A device with no pin for someone takes it from their `account` entry. It no longer pins what `GET /api/users` shows.

### 5.6 What counts

`certificateStanding` gains one condition: the log names this device for this account, with this signing key and a certificate of this hash, in a `device` or `certificate` entry. Its four callers then all follow: the list of people (`session/local.ts`), claimed key packages (`session/groups.ts`), the members of a tree (`session/joining.ts`) and this account's own devices (`certifiedKey`).

- **A device the server lists but the log doesn't** counts for nothing. In a tree it's a stale leaf, removed and warned about as a false one is today.
- **A device the log says is gone** is revoked for this device whatever `revoked_at` says, alongside the carried rule, which stays.
- **A leaf the log doesn't name yet** makes the device read the log to its newest head first. A device has to be registered before it can join anything, so its entry is already there on an honest server.
- **What a device already counted stays counted** if the log can't be read. Only what's new waits. A server that withholds the log gets no further than one that withholds the list of people.

### 5.7 Watching your own account

The entries tagged for this account get the checks a device already makes of what the server says about itself, but now nothing can be kept from it:

- **Its `account` entry** has the root its slot named and its own username.
- **Each `device` entry** is this device, or passes `ownDeviceAccepted`: carried by the head link, or enrolled through a slot. The "new device just signed in" alert is raised from the entry, so the server can't skip it. One that fails is the fake device of the rotation's design, handled as it is today.
- **Each `link` entry** is one this account's devices made. Anything else is the existing "different history of your account's keys" warning.
- **A name tag that fits its username** on another account's entry gets a warning that someone was signed up under its name.

A device signing in reads the log before it registers, with records and its own account's bodies open to a session that has no device yet, and holds what it was handed to it: the generation and head link have to be the newest the log has for the account.

### 5.8 Telling each other

A head only means something once it's compared. Three places carry one where the server can't change it:

| Where | What | Why there |
|---|---|---|
| **Signed messages** | `log: { e, n, r, s }` in the body, beside `tokenKeys`, which already compares what people were shown this way. Sent when the sender's head is newer than the last it sent to that conversation, or weekly | It's inside the encryption and under the sender's signature. Every conversation joins its members' views |
| **The vault manifest** | `log: { key, era, size, root }`, written with any other change to the manifest, and by itself at most daily | A new device of an account starts from what its other devices verified, not from what the server shows it |
| **Invite links** | `&log=` in the fragment, with the key and the inviter's head when the link was made: about a hundred characters | Whoever joins checks the log they're given against a head the server never saw. Everyone who was on the server when the link was made then has the key the inviter had for them, before a word is exchanged |

A link's head is only as good as the way the link came, as its community key is: a server's invite page could change the fragment of a link opened in a browser, which is why links are pasted into the app.

A device given someone's head, signed by the key it pinned:

- **No bigger than its own:** the root it holds at that size must be the same.
- **Bigger:** it reads the log up to that size, then compares.
- **From an earlier era:** ignored.

### 5.9 When heads disagree

| What a device finds | What it means | What it does |
|---|---|---|
| Two roots for one size, both under the log key's signature | The server kept two logs. This is proof | Keeps both signed heads. A `security` event: the server showed different people different records of who holds which keys |
| The server's log is shorter than a head someone holds, or than this device's own | The server went back, or is holding entries from this device | The same event, worded for it. Section 5.10 is the way out for a restored backup |
| A head signed by another key | Either the server gave someone another log key, or their app made it up | A milder warning that names whose message it was in, as `compareTokenKeys` does. This is the one a member can cause |

None of these erases, blocks or asks anything. What a device holds stays, and what it does next is what it already does when someone's keys are in doubt.

### 5.10 When a server loses its log

A server restored from a backup has a shorter log than its members' devices have seen, and they'd warn about it for good. So a log has an era:

- **The server's owner starts a new one** with a flag of `zuna-server`, run once. The server writes the log again from its tables, under the next era and the same key.
- **Devices take a newer era** signed by the key they pinned, say so once, and read it from the start.
- **Nothing they hold is given up.** Pins, chains and known devices are kept in tables of their own, and the new era's entries are held to them by the rules in 5.5. A key that changed across the reset is `changed`, as it would be today.

So a malicious server gains nothing by starting again but a warning on every device. The same rewrite, as era 1, is how a server that had accounts before the log gets its first one.

## 6. What changes for an attacker

Numbers are section 3's rows.

| | Today | With the log |
|---|---|---|
| 1. A false first key | Silent until emoji are compared | In the log, where the owner's devices see it under their own ID, or in a second log, which the first message across gives away. Not possible at all against someone who joined by a link made after the real account was, if the link reached them unchanged |
| 2. Different device lists for different people | Silent | Not possible under one head |
| 3. A rotation or removal kept from a contact | Works until a shared tree shows it | Not possible under one head. A device knows which generation it's missing |
| 4. A false link from an old key | Silent to an unverified contact | In the log, where the owner's devices see a link they didn't make, and the real one can't share its generation. Or a second log |
| 5. A device added with the current key | The owner may never be told | The owner's devices are always told. It can't be stopped, as whoever holds the current key is the account |
| 6. A new device served an old generation | Lasts until a contact or another device warns | Refused at sign-in if the manifest's head is past it. Otherwise ends at the first head from anyone |
| 7. An old seal key offered again | Works on a device that never saw the newer | Not possible under one head (Stage 6) |
| 8. A second account under a name | Silent | The later one counts for nothing, and the name's holder is told |

## 7. What people see

Checked against the constraint. Every line is a notice through the existing `security` event, or something that already exists.

| Who | What | Asked to do |
|---|---|---|
| Everyone, always | Nothing | Nothing |
| Someone making an invite | A longer link | Nothing |
| The owner of an account someone was signed up over, or given a device or link | The existing warnings, which now always come | Nothing new |
| Everyone, when a server kept two logs or went back | One warning | Nothing. Comparing emoji stays optional |
| Everyone, when a server's owner starts its log again | One notice | Nothing |

## 8. What it can't do

1. **Prevent.** Between a false key going into the log and its owner's device reading it, contacts use it. An account with no device online isn't watched until one comes back, when it reads everything since.
2. **Reach someone who's alone.** A server that gives a person a log of their own, and stands between them and every contact, can rewrite the heads that pass. It has to do that in every conversation they're in, for as long as it wants to go unnoticed. One emoji check ends it: a verified contact's messages can't be rewritten, so their head is real, and it ties that person's log to everyone that contact talks to. An invite link's head ends it sooner, for everyone who was there before the link.
3. **Speak for someone who isn't asked.** There are no outside witnesses. A server with one member has nobody to compare with.
4. **Stop an era being started.** Anyone with the log key can start the log again. Everyone is told, and it changes nothing they hold.
5. **Hide the log's shape.** Members learn the order of changes, and that hidden accounts exist (5.3).
6. **Keep a member from raising the milder warning** (5.9), as with token keys today.
7. **Anything about messages.** What a removed device could already read, forged old messages, and metadata are as the rotation's design leaves them.

## 9. Alternatives considered

| | Why not |
|---|---|
| **A prefix tree with a VRF, and a chain of signed roots** (CONIKS) | Answers "what's Bob's key" with a short proof and hides who's in the directory. Here everyone has the directory, and an owner has to check their entry in every root or trust an auditor to. The VRF is a new primitive in every binding of the crypto core |
| **An append-only versioned map** (SEEMless, Parakeet, as WhatsApp runs it) | Built for billions of accounts, and needs auditors to check each update only appends. Zuna has none |
| **The IETF's key transparency protocol,** in its mode without a third party | The closest standard, and where to go if a server outgrows full reading. Its searches are intricate, and the draft was still changing when this was written |
| **Only each account's own chain,** which links already are | No shared head, so nothing to compare between people. It can't cover a first key, a device, or anything left out |
| **Inclusion proofs for the people a device talks to, and no full read** | A proof shows an entry is there, never that a later one isn't. That takes the full read or a map |
| **A witness that countersigns heads,** such as the push relay | A central service, which Zuna doesn't have. It could be added later without changing the log |

## 10. Implementation plan

Each stage ships on its own and leaves things working. Nothing is kept for older apps, as nothing is released. The attack tests are permanent, as those in `security.test.ts` are, in a new `packages/core/test/transparency.test.ts`, driving real clients against a real server whose database the test changes as a malicious server would.

### Stage 0: decisions and review

This document, and answers to section 12.

### Stage 1: the server keeps the log

**Change:**

- `server/internal/merkle`: leaf and node hashes, the frontier, the root. About a hundred lines, with no new dependency.
- `store/log.go`: `appendLog`, called inside the transactions in section 5.2, and reading records and bodies. Tables at the end of `migrations` and `postgresMigrations`. The key and era in `settings`.
- `api/log.go`: `GET /api/log` and `GET /api/log/bodies` under `withDevice`, with bodies by `canSee`, the head's signature, the `log` frame, and `log_key` in `GET /api/info`.
- The first era written from the tables when a server with accounts has no log.
- Vectors in `packages/core/test/fixtures/log-vectors.json`, which Go's tests and the core's both read, so the two can't drift.

**Tests:**

- RFC 6962's roots for trees of one to eight leaves, and the shared vectors.
- Each route in section 5.2 appends exactly its entries, and a change that's rolled back appends none.
- Two changes at once get two places, in SQLite and with `ZUNA_TEST_POSTGRES`.
- A private bot's bodies go to its owner and to whoever is in a chat with it, and to nobody else.
- A server with accounts and no log gets one that its tables agree with.

### Stage 2: devices read it, and watch themselves

**Change:** `packages/core/src/transparency.ts` (the tree, records, tags, heads, bodies, pure functions on the `sha256` and `verify` every host already gives). A new part of `ServerSession`, `session/directory.ts`, after `chains.ts`, under `// --- Key transparency ---`. Local tables at the end of `MIGRATIONS`. `api.ts`. The log read before the list of people in `lifecycle.ts`. Section 5.7. Nothing depends on the log yet.

**Tests:**

- A device's root is the server's, from an empty log and from a later place.
- A record changed in the database, a body that doesn't fit its record, and a tag that doesn't fit its body are each refused.
- A log shorter than the one held raises the warning.
- A device added straight to the database with a certificate the identity key signed, and left out of the owner's list of people: the owner is warned.
- An account added under someone's username: they're warned.
- A body kept back about someone the device knows is noticed.
- A first read of 100,000 records, timed in Node, QuickJS and JavaScriptCore. If hashing through a host is too slow, a batched append goes into the Rust core, with everything a new crypto function changes.

### Stage 3: only what's in the log counts

**Change:** section 5.6, and pins taken from `account` entries. `session/chains.ts`, `session/local.ts`.

**Tests:**

- A device in the list of people and not in the log counts for nothing, and is removed from a tree with the warning.
- A removal the list of people hides is known from the log.
- A link the server withholds: the contact knows the generation is missing, and the real device isn't removed over it.
- Two `link` entries for a generation give the fork warning.
- A second account under a held name gets no message encrypted to it.
- The whole of `rotation*.test.ts` and `security*.test.ts`, which mustn't change.
- `node apps/web/test/web-check.mjs` and the native app's check on its system, as how the app starts changes.

### Stage 4: heads in messages

**Change:** `log` in `MessageBody` (`types.ts`, `validate.ts`), sent from `sending.ts` and compared in `ingest.ts`, with sections 5.8 and 5.9. `previewPush` ignores it.

**Tests:**

- Two people given different logs, through a proxy that answers `GET /api/log` for one of them from a second log signed with the server's key: both warn at the first message, and both hold the two heads.
- A head from someone ahead makes the device read on, then agree.
- A head under another key gives the milder warning, naming its sender.
- An old head sent again does nothing.
- A message carries a head only when section 5.8 says so.

### Stage 5: the manifest, invite links and signing in

**Change:** `log` in the manifest (`manifest.ts`, `session/vault.ts`). `&log=` in `inviteLink` and `parseInviteLink` (`account.ts`), which the setup link for bots follows. Reading the log before a device registers, with records and its own account's bodies open to `authed`.

**Tests:**

- A new device starts from the manifest's head, and refuses a log that doesn't hold it.
- Someone joining by a link is warned when the server's log doesn't hold the link's head.
- A new device served an old generation, with a newer `link` entry in the log, doesn't take it.
- An invite link without `log` still works, as on a server with open sign-ups.

### Stage 6: eras and seal keys

**Change:** a flag of `zuna-server` that starts a new era. Devices taking one (5.10). `seal` entries, and `sealKeyOf` going by the log's newest instead of what this device has seen. "Restoring a backup" in `docs/SELF_HOSTING.md`.

**Tests:**

- A new era gives one notice, and every pin and chain holds.
- A key changed across a new era is `changed`.
- An older era's head from someone does nothing.
- An old seal key offered to a device that never saw the newer is refused.

### After each stage

The docs say only what's built, so they change with the stage that makes it true, not before:

- `SECURITY.md`: "Knowing who you're talking to", the row for bots, and under "Limits" the lines about a brand-new device, old keys fooling a contact, and what the emoji check alone covers.
- `docs/SECURITY_DETAILS.md`: a section for the log, and "Identity and devices".
- `docs/ARCHITECTURE.md`: the server's job, and the order of catching up.
- `docs/ACCOUNT_KEY_ROTATION.md`: section 10's table and question 15.
- `apps/site`, if a page claims any of it.
- `.agents/FEATURE_PARITY.md`: one row. It's in the core, so every platform has it at once.
- `CLAUDE.md`: the session's parts, the quick reference, and the rows in section 11.

The core's commits are a patch for the native app, as a security fix is. The server's alone are under the hood.

## 11. What will have to change together

For `CLAUDE.md`, once Stage 1 is in:

| When you change | Also change |
|---|---|
| Anything on the server that adds, removes or changes an account's keys or devices | An entry in the same transaction (`appendLog`), its kind and rule in `transparency.ts`, and section 5.2 here |
| The log's formats: records, tags, heads, bodies | `server/internal/merkle`, `store/log.go`, `packages/core/src/transparency.ts`, and the shared vectors |
| Who an account is there for (`canSee`) | Who gets a body in `api/log.go` |

## 12. Questions

### For the reviewer

1. **Full reading and heads in messages, with no outside witness.** Is section 8's second limit the whole of what's left, or does a server get more from choosing who to keep apart?
2. **Tags.** Are 16 bytes of SHA-256 over an ID and a nonce enough, given that both the one who files an entry and the one who looks for it work out the same hash? Should the name tag be keyed with the community key, which would keep a server with a copy of the log from testing names, though not members?
3. **No time in a head.** Is the size alone, and heads from other people, enough to call a log fresh? What does a signed time buy that's worth telling everyone when devices change?
4. **Eras.** Is a reset that everyone is told of, and that can't change what a device holds, safe enough to give a server's owner? Should the first era differ from later ones?
5. **Order.** Can a holder with the server gain anything from where it files an entry, such as a `device` just before the `link` that would leave it out?
6. **Commits.** Should a commit that adds a device name the head its entry is under, so that nobody is ever told "not yet" by a server that's holding the log back from them?
7. **Bodies as exact JSON bytes,** as certificates and links are signed. Anything to gain from a binary format here?

### For the owner

Each has what this plan assumes, and is the owner's to change.

1. **Every device reads the whole log** (5.1). Assumed, since every device already reads the whole list of people. The other way is section 9's, at several times the work.
2. **Usernames are in the log** (row 8 of section 3). Assumed. Without it the log ties keys to an ID nobody ever sees.
3. **Invite links grow by about a hundred characters** (5.8). Assumed, as it's the one thing here that prevents and doesn't only find out. Without it, someone joining takes the server's first answer on trust.
4. **New warnings in the existing place** (section 7). They ask for nothing, but they're messages people didn't get before.
5. **Private bots show as records about nobody** (5.3). Assumed acceptable. The other way is a second log for them alone, which only their owners would read.
6. **Restoring a backup takes a flag, and tells everyone once** (5.10). The other way is devices warning for good.

## Appendix A: formats

Hashes are SHA-256, and `[0..16]` is a hash's first 16 bytes. JSON is hashed as the exact bytes sent.

### The tree

```
leaf  = H(0x00 | record)
node  = H(0x01 | left | right)        split at the largest power of two below the size
empty = H("")                         as RFC 6962, section 2.1
```

### Records

```
record    = nonce (16) | user_tag (16) | name_tag (16) | body_hash (32)
user_tag  = H("zuna/log/user/v1|" | user | "|" | nonce)[0..16]
name_tag  = H("zuna/log/name/v1|" | username, in lower case | "|" | nonce)[0..16]     an account entry
name_tag  = 16 random bytes                                                           any other
body_hash = H("zuna/log/body/v1|" | nonce | body)
```

### Bodies

```
{ v: 1, t: "account",     user, username, root, hpke, hpke_sig }
{ v: 1, t: "device",      user, device, key, cert, enroll, seal }
{ v: 1, t: "certificate", user, device, cert }
{ v: 1, t: "seal",        user, device, gen, seal }
{ v: 1, t: "revoked",     user, device }
{ v: 1, t: "link",        user, gen, link }
{ v: 1, t: "deleted",     user }

cert   = H(certificate)
enroll = H(enrollment proof)
seal   = H(seal key | generation as 8 bytes | seal proof)
link   = H(link payload)
```

### Heads

```
head      = { era, size, root }
signature = Sign(log key, "zuna/log/head/v1|" | era as 8 bytes | size as 8 bytes | root)

in a message    log: { e: era, n: size, r: root, s: signature }
in the manifest log: { key, era, size, root }
in a link       &log= base64url(key (32) | era as 4 bytes | size as 8 bytes | root (32))
```

### Server

Tables: `log_entries(era, idx, record, body, user_id, root)`, with `root` the tree's root once this entry is in. The log key, the era and the frontier are in `settings`.

| Route | Wrapper | Purpose |
|---|---|---|
| `GET /api/log?era=&after=&limit=` | `withDevice`, and `authed` for records and the session's own account's bodies | The signed head, and the records after a place, each with its body if its account is there for whoever asks |
| `GET /api/log/bodies?user=` | `withDevice` | The bodies of one account's entries, for someone it has just become visible to |
| `GET /api/users` | `withDevice` | Also says the log's era and size |
| `GET /api/info` | `pageLimited` | Also gives `log_key` to someone signed in |

The `log` frame says an era and a size, to everyone connected.

### On the device

A local migration adds `log_records(idx, record, root, body)` at the end of `MIGRATIONS`. The head, the pinned key, the frontier and any two heads kept as proof are in `kv`, sealed as the chain's state is.
