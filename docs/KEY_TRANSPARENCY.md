# Key transparency

Each server keeps a log of every change to who holds which keys, and every device reads all of it. This page is the design. It was written on 2026-11-11 against commit `9b4d8fed`, and built the same day, at the owner's word, ahead of review: nobody independent has reviewed it, and its questions for a reviewer (section 10) are what a reviewer should look at first. The code is `server/internal/merkle`, `server/internal/store/log.go`, `server/internal/api/log.go`, `packages/core/src/transparency.ts` and `packages/core/src/session/directory.ts`, and the tests `packages/core/test/transparency.test.ts` and `server/internal/api/log_test.go`.

**Scope:** which keys and devices each account on a server has. Without the log, that's whatever the server says, held to the signatures it can't forge. The log makes it a record the server can't change afterwards, can't show differently to different people without leaving proof, and that every account's own devices read.

**The owner's constraint holds:** no part of this may add a step, prompt or setting for people using the app, with one exception the owner made: a device signing in to someone's account is a question on each of their devices from before it (5.7).

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
| Log key | A lasting hybrid key, Ed25519 and ML-DSA-65, which the server makes once from a seed it keeps, and signs heads with ([POST_QUANTUM.md](POST_QUANTUM.md)). |
| Era | A number that goes up when a server starts its log again, as after restoring a backup. |
| Frontier | The roots of the full subtrees a tree of some size is made of, at most one for each bit of the size. It's all a device needs to keep to append to a tree and find its root. |

"Server", "reader" and "holder" mean what they do in section 4 of [ACCOUNT_KEY_ROTATION.md](ACCOUNT_KEY_ROTATION.md): a malicious operator, a copy of the server's data, and someone with an account's keys as of some generation.

## 3. What a server could do without it

As the code stood at commit `9b4d8fed`, before the log. Short paths are in `packages/core/src/` and `server/internal/`.

| | What happens | Where |
|---|---|---|
| 1 | **The first key for someone is whatever the server shows.** A device pins it, and only comparing emoji shows it was false | `applyUser`, `session/local.ts:293` |
| 2 | **Each person is told about devices separately.** Nothing makes what Alice is shown of Bob's devices agree with what Bob is shown. Bob's "a new device just signed in" alert comes from the same list, so it's the server's to send or not | `GET /api/users`, the `user` frame, `session/local.ts:336` |
| 3 | **A rotation or a removal can be kept from a contact.** A contact follows a chain when the server says the generation went up, or when a leaf in a shared tree names a newer one. With neither, they go on counting a removed device | `followChain`, `session/chains.ts:136`, and section 9.2 of the rotation's design |
| 4 | **With an old identity key and the server, a contact can be shown a false link,** if they haven't seen the real one | "Limits" in `SECURITY_DETAILS.md` |
| 5 | **With the current identity key and the server, a device can be added that contacts accept,** and kept from the owner's list | Section 10 of the rotation's design, first row |
| 6 | **A brand-new device can be served an old generation,** or with a holder's help, keys of the holder's choosing | "Limits" in `SECURITY_DETAILS.md` |
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

- **Size.** A record is 80 bytes. A body is about 150, but a `device` entry's is about 2 KB and an `account` entry's about 9 KB, as they carry hybrid keys ([POST_QUANTUM.md](POST_QUANTUM.md)). A server of 200 people that has seen 2,000 changes is 160 KB of records, once for each device, then only what's new. A hundred thousand changes is 8 MB of records, which a device reads in the background.
- **Nothing to get wrong.** A device appends each record to its frontier and compares the root with the signed one. That's the whole check. Inclusion and consistency proofs aren't used anywhere.
- **Leaving something out is impossible, not just detectable.** A device that has every record can test each against any account it knows (5.3), so the server can't pass one over.

If servers ever outgrow this, the log is the right base for the proofs the other designs use, and nothing here would have to be undone.

### 5.2 Entries

Every change to an account's keys or devices appends one entry, inside the transaction that makes the change. A change that isn't in the log didn't happen, as far as devices are concerned. Each of those transactions goes through `logTx`, which on PostgreSQL lets one at a time append and takes the log as its first statement (`claimLog`), and `appendLog` writes the log's state before its entry, so two at once never take the same place: the second starts again from the log the first left.

| Kind | Says | Written by |
|---|---|---|
| `account` | The account's ID, its username, the identity key it began with, its first HPKE key | `CreateUser` |
| `device` | A device's ID and signing key, and hashes of its certificate, its enrollment proof and its seal key | `AddDevice` |
| `certificate` | The hash of a device's new certificate | `SetDeviceCertificate` |
| `seal` | The generation and hash of a device's new seal key | `SetDeviceSealKey` |
| `revoked` | A device is gone | `revokeDevice`, and for each device in `BanUser` and `DeleteAccount`, which revoke in bulk today |
| `link` | A generation and the hash of its link's payload, before that rotation's `revoked` entries | `ApplyRotation` |
| `deleted` | The account is deleted, and its username is free | `DeleteAccount` |

A device's own `certificate` and `seal` entries are the only ones it can append whenever it likes, so each device may publish each at most 60 times at once and then once every 30 seconds, twice what following its account's rotations at their limit takes (`sealKeyLimiter`, `certificateLimiter`), and the one the log already has for it, sent again, is answered and appends nothing.

Bodies carry hashes of certificates and links, not the things themselves. Those go on travelling as they do now, in `GET /api/users`, in MLS leaves and from `GET /api/users/{id}/identity-links`, and are held to the hash.

Nothing in an entry says when. Other people aren't told when someone's devices were added or removed (`seenByOthers` in `api/users.go`), and the log keeps to that. It does give the order of changes, which someone who's always connected sees already.

### 5.3 Records, tags and private bots

Everyone must get every record, or roots couldn't be worked out. But a private bot is there only for its owner and the people in a chat with it. So a record says nothing by itself:

```
record = nonce (16) | user tag (16) | name tag (16) | body hash (32)
```

- **The user tag** is a hash of the account's ID and the nonce. IDs are 16 random bytes, so only someone who knows an ID can tell a record is about it.
- **The name tag,** on an `account` entry, is a hash of the username and the nonce. On every other entry it's 16 random bytes, so nobody can tell kinds apart.
- **The body** goes only to those `canSee` allows, as everything else about an account does. The one exception is the entry that says an account is deleted, which every device gets: it names the account's ID and nothing else, and it's what frees the account's username.

A device checks tags in both directions:

- **A body it's given** must hash to the record, name an ID the user tag fits, and for an `account`, a username the name tag fits. So a server can't file an entry about Bob under a tag Bob wouldn't recognize.
- **A record about the device's own account always comes with its body.** A page that has one without is refused whole, as at sign-in: read bare and asked for afterwards, it would be taken as old news, a new device in it too.
- **A record it's given no body for** is tested against every other ID the device knows, and against its own username. A match means the server is keeping back something about someone who's there for this device, which may be that one of their devices was removed. Until the bodies come, none of that account's devices is encrypted to, as an unchecked leaf isn't, and none of its key packages is taken, from the moment the app starts again too, before the log can be read (`holdWithheld`). The device asks again, however the request fails, and says so after three tries, or at once if the server says the account isn't there while this device shares a conversation with it.
- **An answer to `GET /api/log/bodies` has to hold every body of that account's the device opened before,** as what it says of the account is worked out again from the answer alone: leaving out a removal would take it back. One that doesn't is refused, and said so.
- **When an account becomes visible later,** as a private bot does to someone added to a chat with it, the device tests the records it holds against the new ID and asks for those bodies (`GET /api/log/bodies`).
- **An `account` entry that follows records about the same ID that came without their bodies** isn't that account's first, whatever it says. No key is taken from it, and nothing of the account counts until all of them have come, in their order.
- **A username an account is made under** is tested against every record before it that came without its body. One filed under that name that isn't this account's is an account that held the name first, which the server keeps from this device: the later account counts for nothing, as under any held name (5.5), and the device says the server is keeping part of someone's record back. The server keeps a body back only for a private bot that isn't there for the device, and a bot's `deleted` entry comes to everyone, so a name a deleted bot had is free (`nameHeldBefore`, `forgetDeleted`).

What leaks: a modified app can count records about nobody it can see, which says that private bots exist and that their keys changed, and can test guesses at a private bot's username offline, where today it would have to try signing up under each. It learns when one was deleted, with its ID, which says which of those records were its. `SECURITY_DETAILS.md` says so under bots.

### 5.4 Heads

A head is `{ era, size, root }` and the log key's signature over it. The server signs one whenever the log grows.

- **No time in it.** A time on every head would tell everyone when a device was added or removed. A head's size only goes up, and that's all the order devices need.
- **The log key** is made once and kept in the database, as token keys are. Its public half is in `GET /api/info` for someone signed in.
- **Devices pin it** from the server if it has the hash their invite link carries (5.8), or failing that from the first answer, and keep it in the manifest, so an account's later devices take it from there and not from the server.

The signature is what gives K4 and K5. Without it devices would still notice that roots differ, but any member could make one up, and nobody could show anyone else what the server did.

### 5.5 Reading and checking

A device holds every record, with what it needs to work out a root from before, and what the bodies it was given say, in local tables (the implementation notes say how). `GET /api/users` says the log's era and size, so an app coming back from the background asks for the log only when it grew, and a `log` frame on the socket says so live. The log is read before the list of people, since the list is judged by it.

For each batch of new records, in order:

1. Append each record to the frontier. The root at the batch's end must be the signed head's, the signature must be the pinned key's, and the size mustn't be less than what's held.
2. Check each body against its record and its tags (5.3).
3. Apply each body, by its kind:

| Kind | Rule | Breaking it |
|---|---|---|
| `account` | The first for this ID. Its username isn't held by an earlier account with no `deleted` entry, nor is an earlier record that came without its body filed under it (5.3). If this device has a pin for the ID, the key is the pin's | A second for an ID, or a key that isn't the pin's, is today's `changed`. An account under a held name counts for nothing, and its devices with it. It holds no name either, so one written ahead of the account the name was held for doesn't take it from that one |
| `device` | The account exists and isn't deleted, and the device's ID is new for it | Ignored, and said once |
| `certificate`, `seal` | The device exists and isn't revoked | Ignored |
| `revoked` | The device exists | Ignored |
| `link` | Its generation is the account's next. The link fetched for it must have the payload hash the entry names, and then passes `verifyLink` as today | A second for a generation is today's fork (`noteFork`). A link the server won't hand over is a generation this device knows it's missing, and it keeps asking |
| `deleted` | The account exists, or was never there for this device (5.3). No `account` entry for the ID follows it | Ignored |

A device with no pin for someone takes it from their `account` entry. It no longer pins what `GET /api/users` shows.

### 5.6 What counts

`certificateStanding` gains one condition: the log names this device for this account, with this signing key and a certificate of this hash, in a `device` or `certificate` entry. Its four callers then all follow: the list of people (`session/local.ts`), claimed key packages (`session/groups.ts`), the members of a tree (`session/joining.ts`) and this account's own devices (`certifiedKey`).

- **A device the server lists but the log doesn't** counts for nothing. In a tree it's a stale leaf, removed and warned about as a false one is today.
- **A device the log says is gone** is revoked for this device whatever `revoked_at` says, alongside the carried rule, which stays. In a tree it's a stale leaf, whether or not the server still lists it, and one of someone else's that the server stops listing is held as unchecked until it says what became of it. A change to any of this, or to who a group lists, makes every tree be checked again before anything else is encrypted, rather than trusting a check from before (`ensureTreeClean`).
- **A leaf the log doesn't name yet** makes the device read the log to its newest head first. A device has to be registered before it can join anything, so its entry is already there on an honest server.
- **What a device already counted stays counted** if the log can't be read. Only what's new waits. A server that withholds the log gets no further than one that withholds the list of people.
- **A device that came with a head counts nothing until the log has held it.** One that joined by an invite link, or signed in, has a head the log has to hold (5.8). Until it has read the log that far, and the root there was the head's, what it read may not be the log the head is of: no key is taken from it, it names no device, no link in it is followed, and nothing it says of anyone is said. All of that is taken at once when the head is held. A first page with other records in it, from a server that then gives no more, gets nobody counted.

### 5.7 Watching your own account

The entries tagged for this account get the checks a device already makes of what the server says about itself, but now nothing can be kept from it:

- **Its `account` entry** has the root its slot named and its own username.
- **Each `device` entry** is this device, or passes `ownDeviceAccepted`: carried by the head link, or enrolled through a slot. One that fails is the fake device of the rotation's design, handled as it is today.
- **A device of the account after this one's own entry** is a question: it's kept until the person answers whether it was them, which each app asks over everything, with nothing but an answer to close it (`getNewDevices`, `answerNewDevice`, the `new_devices` event). No removes it and asks them to change the secret its enrollment proof names (`enrolledWith`). The answer isn't passed to the account's other devices, as whoever signed in could give it: each asks, and stops when a `revoked` entry for that device comes. The question is asked from the log's entry, so the server can't skip it, and there's no alert from the list of people beside it. A log written again in a new era is quiet about the devices the old one named, and asks about any other of the account's it has, wherever it stands in it (`ownBefore`).
- **Each `link` entry** is one this account's devices made. Anything else is the existing "different history of your account's keys" warning.
- **A name tag that fits its username** on another account's entry gets a warning that someone was signed up under its name.

A device signing in reads the log before it registers, with records and its own account's bodies open to a session that has no device yet, and holds what it was handed to it: the generation and head link have to be the newest the log has for the account. A page that says there's more and gives none of it is refused, as is one of another era than the first, which starts the sign-in again. The head it read then is one the log has to hold from there on, beside the manifest's (5.8).

### 5.8 Telling each other

A head only means something once it's compared. Three places carry one where the server can't change it:

| Where | What | Why there |
|---|---|---|
| **Signed messages** | `log: { e, n, r, s }` in the body, beside `tokenKeys`, which already compares what people were shown this way. Sent when the sender's head is newer than the last it sent to that conversation, or weekly | It's inside the encryption and under the sender's signature. Every conversation joins its members' views |
| **The vault manifest** | `log: { key, era, size, root }`, written with any other change to the manifest, and by itself at most daily | A new device of an account starts from what its other devices verified, not from what the server shows it |
| **Invite links** | `&log=` in the fragment, with the hash of the log's key and the inviter's head when the link was made: about a hundred characters | Whoever joins checks the log they're given against a head the server never saw. Everyone who was on the server when the link was made then has the key the inviter had for them, before a word is exchanged |

A link's head is only as good as the way the link came, as its community key is: a server's invite page could change the fragment of a link opened in a browser, which is why links are pasted into the app. A server in a later era than the link's holds the newcomer to it all the same (5.10).

A device given someone's head, signed by the key it pinned:

- **No bigger than its own:** the root it holds at that size must be the same.
- **Bigger:** it reads the log up to that size, then compares.
- **From an earlier era:** held to what this device read of that era, whose records it keeps (5.10). One from an era it never read is ignored.

A device's first read is held to the heads it came with, of which there can be two: the one its invite link carried, or the one it read as it signed in, and the one its account's manifest carries.

- **Each is checked as the log goes past it,** and the log has to get to the furthest. A page that runs past one with another root is refused whole.
- **Nothing counts until then** (5.6). When a head turns out not to be held, what the device read on the way is let go, as it was a log the head isn't of, and it starts again: only the log's own tables go, which is all that read wrote.
- **Two heads of one size with different roots** can't both be held. The device says so at once, and takes no log while it's so.
- **A log that ends before a link's head** is refused, with the link's warning, and nothing of it is taken. Whoever joins can ask for another link.
- **A log that ends before the manifest's head, or the one signed in with,** gets that head's warning and is taken as it is: a new device of an account has no other way in to a server restored from a backup, and holds its other devices' key for everyone, which the log is held to. The head stays, for when the log gets there.
- **The head signed in with is the server's own,** so a log that doesn't hold it gets the warning for a log gone back, not the link's.

A server can't keep the rest of a log back by failing the request. While something it didn't write says there's more than a device holds, one of those heads or one from someone's message, the device asks again some seconds later, and the third refusal gets the warning a log that doesn't hold that head would: the link's, the manifest's, or the one for a log gone back. Not reaching the server at all counts for nothing, and a log that can't be read while nothing says it goes further is only a server that's down.

### 5.9 When heads disagree

| What a device finds | What it means | What it does |
|---|---|---|
| Two roots for one size, both under the log key's signature | The server kept two logs. This is proof | Keeps both signed heads. A `security` event: the server showed different people different records of who holds which keys |
| The server's log is shorter than a head someone holds, or than this device's own, or the server refuses three times to give the rest of it (5.8). Or an earlier era, as the server kept it, is shorter than a head someone holds of it (5.10) | The server went back, or is holding entries from this device. For an earlier era that includes its going on for everyone else, with the era after it shown to this device alone | The same event, worded for it. Section 5.10 is the way out for a restored backup |
| A head signed by another key | Either the server gave someone another log key, or their app made it up | A milder warning that names whose message it was in, as `compareTokenKeys` does. This is the one a member can cause |

None of these erases, blocks or asks anything. What a device holds stays, and what it does next is what it already does when someone's keys are in doubt.

### 5.10 When a server loses its log

A server restored from a backup has a shorter log than its members' devices have seen, and they'd warn about it for good. So a log has an era:

- **The server's owner starts a new one** with a flag of `zuna-server`, run once. The server writes the log again from its tables, under the next era and the same key.
- **Devices take a newer era** signed by the key they pinned, say so once, and read it from the start.
- **Nothing they hold is given up.** Pins, chains and known devices are kept in tables of their own, and the new era's entries are held to them by the rules in 5.5. A key that changed across the reset is `changed`, as it would be today.
- **Nor who held each username.** A device keeps the names the era it leaves gave (`log_past_names`). An honest server writes every name again as its holder had it, and gives one to another account only once its holder is deleted, so a later era that gives a name to an account ahead of the one the era before gave it to, which isn't deleted, wrote that account itself: it counts for nothing, as under any held name, and the device says the server's record had something in it that it ignored (`nameWasTheirs`). A device knows its own account's name whatever era it's in, and says someone was signed up under it. A name whose holder the new era leaves out, as a backup restored from before they signed up does, is free for whoever signs up under it next.
- **The eras before are kept** as they were, and given whole, with heads signed for them, to whoever asks for one (`GET /api/log?era=…&past=1`). A device that has read nothing yet, whose invite link's or manifest's head is of an earlier era than the server's, reads that era first, held to the head, taking each account's first key from it as a device that read it then did, and then the server's era, held to those as any device's is. So whoever was there when the link was made keeps the key they had, one the new era changes is `changed`, and a restored backup, which changes nobody's, says nothing to them. A server that keeps no such era, or answers in one before the head's, gets the link's warning, as a log that doesn't fit the head does (`readEraOfFloor`).
- **What that era said is kept across the move** (`log_kept_records`, `log_kept_names`), as its head holds the records, not what the server says is in them, and the later era is held to it three ways:
  - **What it kept back.** Its records that came without their bodies stay. When a later era names an account one of them is about, that account's first key is owed from the earlier era: the device asks for those entries (`GET /api/log/bodies?user=…&era=…`), holds each to its record, and takes the key from the `account` entry among them, so the later era's key for them is `changed` if it's another. Until they come, no key is taken for the account and nothing of it counts, and a server that doesn't give every one of them gets the link's warning (`askForKept`). A private bot that wasn't there for the device when it joined, and is later, goes the same way, and nothing is said. Records of an account that era said was deleted stop holding its username, and are still what its key is taken from, should a later era have it after all.
  - **Usernames.** A username that era gave to an account doesn't go to another in a later one unless the later one says the first is deleted, and nor does one that a record it kept back was filed under. Such an account counts for nothing, with the link's warning (`nameHeldBefore`).
  - **Who was there.** Once the later era has been read, everyone that era named and didn't say was deleted has to be in it, as a server's tables hold them whatever it restored. Someone left out is the link's warning (`checkKept`).
- **A server that refuses that era** is asked again, and its third refusal, some seconds apart, is the link's warning. Until it's given, the device has read nothing, and counts nobody.
- **A new device of an account** signs in under the server's own era, with a head of it (5.7), while its manifest's head may be of the era before. It reads that era first, held to the manifest's head, and then the server's, held to the head it signed in with and to what the earlier one said, as above. If the server has none of that era left, the device says so with the manifest's warning and reads on: it has no other way in, and it holds everyone's key from the manifest already, which the server's era is held to.
- **An era a device leaves stays with it as a tree:** its records, as far as the device read them (`log_past`). One that read an era only to hold a link's or manifest's head to read it to its end. One that was in an era and moved on asks the server where it ended and reads the rest, as kept, onto what it has: the records alone, as what they say was written again in the era after (`readRestOfEra`). A server that has no more of it has said where it ended, and so has one that refuses three times.
- **A head of an era a device left,** from someone's message or its account's manifest, is held to that tree as a head of its own era is (`comparePast`). Another root for a size the device read is two logs, and the two signed heads are kept as the proof. One longer than the server said the era was gets the warning for a log gone back, which says both things it can be, since an honest server adds nothing to an era once the next has begun: the log went back, as a backup from before that head leaves it, and a device that hadn't read the new era yet still carried the old head; or the era went on for everyone else, and the one after it was shown to this device alone. That head is kept, beside the last one the device was given of that era. The two aren't proof to anyone else, as nothing the server signs says where an era ended.

So a malicious server gains nothing by starting again but a warning on every device. A server's log starts empty, at era 1, with its key (`ensureLog`). Writing it from the tables is only `--new-log-era`'s (`rewriteLog`), which exits once it's done, so that it's run once.

## 6. What changes for an attacker

Numbers are section 3's rows.

| | Without the log | With it |
|---|---|---|
| 1. A false first key | Silent until emoji are compared | In the log, where the owner's devices see it under their own ID, or in a second log, which the first message across gives away. Not possible at all against someone who joined by a link made after the real account was, if the link reached them unchanged |
| 2. Different device lists for different people | Silent | Not possible under one head |
| 3. A rotation or removal kept from a contact | Works until a shared tree shows it | Not possible under one head. A device knows which generation it's missing |
| 4. A false link from an old key | Silent to an unverified contact | In the log, where the owner's devices see a link they didn't make, and the real one can't share its generation. Or a second log |
| 5. A device added with the current key | The owner may never be told | The owner's devices are always told. It can't be stopped, as whoever holds the current key is the account |
| 6. A new device served an old generation | Lasts until a contact or another device warns | Refused at sign-in if the manifest's head is past it. Otherwise ends at the first head from anyone |
| 7. An old seal key offered again | Works on a device that never saw the newer | Not possible under one head |
| 8. A second account under a name | Silent | The later one counts for nothing, and the name's holder is told |

## 7. What people see

Every line but one is a notice through the existing `security` event, or something that already exists. The one is the question about a new device, the owner's exception (5.7).

| Who | What | Asked to do |
|---|---|---|
| Everyone, always | Nothing | Nothing |
| Someone making an invite | A longer link | Nothing |
| The owner of an account someone was signed up over, or given a link | The existing warnings, which now always come | Nothing new |
| The owner of an account a device signs in to | A question on each of their devices from before it: was it them | Yes or No, which closes it |
| Everyone, when a server kept two logs or went back | One warning | Nothing. Comparing emoji stays optional |
| Everyone, when a server's owner starts its log again | One notice | Nothing |

## 8. What it can't do

1. **Prevent.** Between a false key going into the log and its owner's device reading it, contacts use it. An account with no device online isn't watched until one comes back, when it reads everything since.
2. **Reach someone who's alone.** A server that gives a person a log of their own, and stands between them and every contact, can rewrite the heads that pass. It has to do that in every conversation they're in, for as long as it wants to go unnoticed. One emoji check ends it: a verified contact's messages can't be rewritten, so their head is real, and it ties that person's log to everyone that contact talks to. An invite link's head ends it sooner, for everyone who was there before the link.
3. **Speak for someone who isn't asked.** There are no outside witnesses. A server with one member has nobody to compare with.
4. **Stop an era being started.** Anyone with the log key can start the log again. Everyone is told, and it changes nothing they hold.
5. **Tell a deletion the server made up from a real one.** A `deleted` entry is the server's word, signed by nobody else. It frees the account's username, so a server can say someone is gone and give their name to another account: a different one, with another ID and a key of its own. In the era everyone reads, the account's own devices and everyone who knew it are shown the same entry. In an era made for one newcomer nobody else is, and what gives it away is the era before, which everyone else is still in: the first head of it past where the server said it ended, in a message to the newcomer from anyone, is a warning on their device (5.10). Until one comes, nothing tells them.
6. **Hide the log's shape.** Members learn the order of changes, and that hidden accounts exist (5.3).
7. **Keep a member from raising the milder warning** (5.9), as with token keys today.
8. **Anything about messages.** What a removed device could already read, forged old messages, and metadata are as the rotation's design leaves them.

## 9. Alternatives considered

| | Why not |
|---|---|
| **A prefix tree with a VRF, and a chain of signed roots** (CONIKS) | Answers "what's Bob's key" with a short proof and hides who's in the directory. Here everyone has the directory, and an owner has to check their entry in every root or trust an auditor to. The VRF is a new primitive in every binding of the crypto core |
| **An append-only versioned map** (SEEMless, Parakeet, as WhatsApp runs it) | Built for billions of accounts, and needs auditors to check each update only appends. Zuna has none |
| **The IETF's key transparency protocol,** in its mode without a third party | The closest standard, and where to go if a server outgrows full reading. Its searches are intricate, and the draft was still changing when this was written |
| **Only each account's own chain,** which links already are | No shared head, so nothing to compare between people. It can't cover a first key, a device, or anything left out |
| **Inclusion proofs for the people a device talks to, and no full read** | A proof shows an entry is there, never that a later one isn't. That takes the full read or a map |
| **A witness that countersigns heads,** such as the push relay | A central service, which Zuna doesn't have. It could be added later without changing the log |

## 10. Questions

### For the reviewer

1. **Full reading and heads in messages, with no outside witness.** Is section 8's second limit the whole of what's left, or does a server get more from choosing who to keep apart?
2. **Tags.** Are 16 bytes of SHA-256 over an ID and a nonce enough, given that both the one who files an entry and the one who looks for it work out the same hash? Should the name tag be keyed with the community key, which would keep a server with a copy of the log from testing names, though not members?
3. **No time in a head.** Is the size alone, and heads from other people, enough to call a log fresh? What does a signed time buy that's worth telling everyone when devices change?
4. **Eras.** Is a reset that everyone is told of, and that can't change what a device holds, safe enough to give a server's owner? Should the first era differ from later ones?
5. **Order.** Can a holder with the server gain anything from where it files an entry, such as a `device` just before the `link` that would leave it out?
6. **Commits.** Should a commit that adds a device name the head its entry is under, so that nobody is ever told "not yet" by a server that's holding the log back from them?
7. **Bodies as exact JSON bytes,** as certificates and links are signed. Anything to gain from a binary format here?

### What the owner chose

Decided on 2026-11-11. Each is still the owner's to change.

1. **Every device reads the whole log** (5.1), since every device already reads the whole list of people. Turned down: proofs on request, section 9's way, at several times the work.
2. **Usernames are in the log** (row 8 of section 3). Turned down: the account's ID alone, which ties keys to something nobody ever sees.
3. **Invite links carry the log key and the inviter's head,** its hash since the key became a hybrid one ([POST_QUANTUM.md](POST_QUANTUM.md)), about a hundred characters more (5.8), as it's the one thing here that prevents and doesn't only find out. Turned down: the key alone, and a link left as it is, where someone joining takes the server's first answer on trust.
4. **All of section 5.9's warnings are shown,** in the existing place, the milder one a member can cause included. They ask for nothing, but they're messages people didn't get before. Turned down: only the proven ones, which would leave a server that gave someone another log key unnoticed.
5. **Private bots show as records about nobody** (5.3), with what that leaks. Turned down: a second log for them alone, and leaving them out of the log.
6. **Restoring a backup takes a flag, and tells everyone once** (5.10). Turned down: no eras, with devices warning for good.

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

root and key are hybrid keys: an account's first identity key, a lasting one of 1,985 bytes, and a
device's key, of 1,345. hpke is an X-Wing key, of 1,216, and hpke_sig a lasting signature, of 3,374.
```

### Heads

```
head      = { era, size, root }
signature = Sign(log key, "zuna/log/head/v2|" | era as 8 bytes | size as 8 bytes | root), Ed25519 and ML-DSA-65 both

in a message    log: { e: era, n: size, r: root, s: signature }
in the manifest log: { key, era, size, root }
in a link       &log= base64url(H("zuna/log/key/v1|" | key) (32) | era as 4 bytes | size as 8 bytes | root (32))
```

### Server

Tables: `log_entries(era, idx, record, body, user_id, root)`, with `root` the tree's root once this entry is in. The log key, the era and the frontier are in `settings`.

| Route | Wrapper | Purpose |
|---|---|---|
| `GET /api/log?era=&after=&limit=` | `authed`. A session with a device gets each body its account is there for, and every `deleted` entry's, and one with none yet, signing in, only its own account's | The signed head, and the records after a place, each with its body if its account is there for whoever asks. With `past=1`, an earlier era as it was kept |
| `GET /api/log/bodies?user=&era=&after=` | `withDevice` | The bodies of one account's entries from `after` on, a thousand at most, and whether there are `more`, for someone it has just become visible to, whose device reads on from the last until it has them all (`readLogBodies`). With `era`, those of an earlier era as it was kept, for a device that was given its records there without them |
| `GET /api/users` | `withDevice` | Also says the log's era and size |
| `GET /api/info` | `pageLimited` | Also gives `log_key` to someone signed in |

The `log` frame says an era and a size, to everyone connected.

### On the device

A local migration adds `log_records(idx, record, frontier, opened)`, `log_accounts` and `log_names` at the end of `MIGRATIONS`, and later ones `log_kept_records(idx, record, gone)` and `log_kept_names`, for what an era read before the server's own said, `log_past(era, idx, record, frontier)`, for each era the device left, and `log_past_names`, for who held each username in it (5.10). The head, the pinned key, the frontier and any two heads kept as proof are in `kv`, sealed as the chain's state is.

## Implementation notes

Where the code goes into more detail than the design above:

- **Roots before now.** A device keeps the tree's frontier after every 256th record rather than a root after each (`log_records.frontier`), and works out a root from before from the nearest one, which is at most 256 records to hash again. A root after every record would have tripled the hashing of a first read.
- **Bodies.** A device doesn't keep the bodies, only whether each record's came (`log_records.opened`, which also marks the records of a deleted account that was never there for the device), and what they say of each account, sealed, one row each (`log_accounts`), with the usernames held, by a keyed hash of the name (`log_names`).
- **Every page is signed.** `GET /api/log` signs the head at the end of each page, not only the newest, so a device checks each page as it comes and keeps none it can't.
- **A floor.** The furthest head a device has still to reach is its floor (`LogState.floor`), and the others of that era are kept beside it (`marks`), each checked in `takeLogPage` as the log goes past it (`holdTo`). A device that came with one is `unheld` until the floor is reached: records are kept and what they say is worked out, but nothing goes by it (`counted`), and `settleLog` takes it all once the floor is held. A head that isn't held is `refuseHead`'s, which on an unheld device lets go of what was read (`forgetUnheld`). On a device that has read the log before, a head from the manifest that's further than it has read is a floor too, and what it counted before still counts.
- **A log the server won't give.** `logOwes` says what the server didn't write that shows there's more of the log, and `noteLogRefused` counts the refusals and asks again. A head from a message that the log couldn't be read for is compared once it has been (`compareHeadAhead`).
- **Timing.** A first read of 100,000 records, checked and hashed, took about half a second in Node, and the same hashing through the iOS host's crypto in JavaScriptCore without a JIT, as on a device, 2.9 seconds (`tests/e2e/test/performance.test.ts`), both on an M-series Mac. That's in the background and once, so hashing stays in the core. QuickJS, the native desktop app's, wasn't timed.
