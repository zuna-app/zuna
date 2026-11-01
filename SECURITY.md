# Security model

Zuna's goal is that a server you don't fully trust still can't read your messages. This page says exactly what that means, including what it doesn't protect against.

**Zuna hasn't had an independent audit.** OpenMLS, the library at its core, has been audited, but Zuna's own code, including how it uses that library, hasn't been reviewed by anyone independent. Keep this in mind for high-risk uses.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" feature on the repository's Security tab, rather than in a public issue.

## What the server can and can't see

| | Server can see | Server can't see |
|---|---|---|
| **Accounts** | Username, role, sign-up date, which devices exist | Password, display name, avatar, bio |
| **Conversations** | Who is in each conversation | Group names, pictures and descriptions |
| **Messages** | Who sent one, when, to which conversation, and its rough size (padded to 256-byte blocks) | Text, replies, mentions, formatting, emotes used (with the exception under "Limits"), links and their previews, whether and from whom it was forwarded |
| **Reactions** | Who reacted to which message | Which reaction it was (with the exception under "Limits") |
| **Files** | Size and uploader, and which messages share a file, so it knows a forwarded file is the same one | Name, type, content |
| **Pins and deletes** | Which message was pinned or deleted | The message's content |
| **Read state** | That someone's read position changed | The position itself |
| **Typing** | That someone sent a typing signal | Nothing further; it's encrypted but has no other content |
| **Presence** | Online status, last seen | Hidden from other members if you choose, but not from the server |
| **Phone notifications** | Which devices get pushes, through which relay; until Apple lets the iPhone app filter notifications, which chats a phone muted and until when | What a push is about: it carries the message's IDs, sealed for the device |
| **Network** | IP addresses of connecting devices | |
| **Search** | Nothing: it runs on your device | Your queries |

Zuna's messages hide content, not metadata. A server operator can see who talks to whom and when.

## How it works

### Group encryption: MLS

Every conversation, including DMs, is an [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) group, using the ciphersuite `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`. The implementation is [OpenMLS](https://github.com/openmls/openmls), compiled to WebAssembly.

Each device is its own member of each group. Keys change at every membership change and at least weekly on active conversations. The server's only role in MLS is enforcing one order of commits per group.

### Message content

Each MLS epoch exports a content key (RFC 9420 section 8.5). Messages are encrypted under it with XChaCha20-Poly1305 and signed with the sender's device key (Ed25519). The signature matters because all members share the content key: without it, any member could impersonate another. What's signed says who wrote it as well as what it says, so a server can't put one person's words under another's name, even with a member's help. Reactions and read positions are signed the same way, and say which message or person they're about.

Using exported keys rather than MLS's per-message ratchet is a deliberate trade-off, and it's what makes history on new devices possible:

- **Gained:** a device you add later can read your past messages, and new group members can receive history if an admin allows it.
- **Given up:** forward secrecy within an epoch and, for stored history, against theft of your account key. See "Limits" below.

### Keys on new devices

Your **account key** is random. It encrypts your identity keys and a vault of content keys, all stored on the server as ciphertext. It's unlocked by either:

- your **password**, stretched on your device with Argon2id (64 MiB, 3 iterations), or
- your **recovery key**, 200 random bits shown once at sign-up.

Your password never leaves your device. A key derived from it authenticates you, and a separate one opens a key pair that the account key is sealed to, so any of your devices can seal a new account key to your password without knowing it. An account from before this has a plain wrapper of the account key instead, until you next enter that secret. The first is bound to the server's address and your username, so one a malicious server collects is no use anywhere else, even if you use the same password on several servers. Clients only derive keys within fixed limits, so a malicious server can't downgrade them or make the app run out of memory.

### Identity and devices

Each account has one long-term Ed25519 **identity key**. Each device's MLS credential is a certificate signed by it, naming the key that device signs with. Certificates are public, so holding one proves nothing: clients check every member of every group, whenever a group's tree may have changed and before encrypting anything, against the identity key they know for that person, and that the member really signs with the key its certificate names. So without that identity key, the server can't add a device to anyone's account. Whoever tries is removed, and everyone is warned. A leaf nobody can check yet counts for nothing, and nothing is encrypted to a group while one is on its roster. A server can make accounts of its own, as it can sign anyone up. It can put one in a group, where it shows as having joined, but never in a direct message: a direct message's two people are settled when a device first sees it, and anyone else in its tree is removed.

Clients pin the first identity key they see for each person, and share those pins, and what you've verified, with your other devices through your encrypted vault. An account moves on from that key only by a signed chain that starts from it. Anything else, including two chains for the same person, produces a loud warning, including on a new device of yours.

### Replacing your account's keys

When a device is removed or signs out, your password or recovery key changes, or someone signs in with your recovery key, your app replaces your account key, identity key and HPKE key, in the background. It seals the new account key to each remaining device and to your password and recovery key, and publishes one signed link from the old identity key to the new one, listing the devices that stay. Contacts follow that chain, and from then on a certificate signed by the old identity key means nothing unless its device is on the list. The vault is sealed again under the new key. The design and what it can't do are in `docs/ACCOUNT_KEY_ROTATION.md`, and **no independent cryptographer has reviewed it yet.**

### The emoji check

Pinning alone doesn't protect a first conversation: a malicious server could hand out a fake key from the start. The emoji check closes that gap. Two people compare 12 emoji (72 bits, from an iterated SHA-512 over both identity keys, in the style of Signal's safety numbers). If they match, each app holds the other person's real key, and since every device in a chat has to be signed by that key, nobody else's device can be in the chat as them. After someone's keys are replaced, the emoji change, and a verification only carries over if a device the other person has known for at least a week made the change. Otherwise that person goes back to unverified, and a line in your chat says so.

### Who's in a conversation

The server keeps the list of who's in each conversation, and it says who may do what. What MLS proves is who actually holds the keys. Clients go by that:

- Someone joining without a member having added them, or a device that isn't what it claims, gets a warning in the conversation.
- That someone left is only announced once their keys are really gone. Who removed them is named only if MLS shows it: otherwise, it would be the server's word.
- The member list shows a difference if there is one: someone who holds the keys but isn't listed, or who's listed with no device in the group.
- Only an admin's device can set a group's name and picture, which it signs, and an older copy can't be served again. Group details from before these were signed count only until signed ones are seen.
- A member can't remove someone from a group's keys: everyone is told, and the person removed rejoins straight away.

### What the server can't make your app do

The server can say you're out of a conversation or signed out, but your messages stay on your device until you clear them, sign in again, or 30 days pass. That includes a device you removed from your account in Settings, so a lost device isn't wiped if it comes back online: removing it cuts off its access, not what it already holds.

### Profiles

Display names and avatars are encrypted under a **community key**, carried in the fragment of invite links (`#k=...`). Browsers don't send fragments to servers. Profiles are also signed by their owners.

If an admin turns on open sign-ups, there's no invite link to carry that key, so the app gives it to the server, and the settings screen says so. This exposes profiles, not messages.

### Files

Each file gets its own random key. It's split into 1 MiB chunks encrypted with XChaCha20-Poly1305 in the STREAM construction, which detects reordered, missing or truncated chunks. The key travels inside the encrypted message.

### Link previews

The sender's device makes a link's preview while they write: it fetches the page, and the title, description and a small picture travel encrypted inside the message. Recipients never contact the site, and the server never sees the link. The site sees the sender's IP address, as it would if they opened the link, and from when the link is typed, even if the message is never sent. Pages are fetched without cookies, only over HTTPS, and only from public addresses: redirects are checked one at a time, and names that lead to this machine or a private network are refused. A determined attacker controlling a site's DNS could still try to switch where it points between the check and the fetch, though HTTPS certificates make that hard to use. Previews can be turned off on each device.

In the web app, the page can't fetch other sites, so its host, `zuna-web`, fetches pages for it by the same rules, and only on port 443. It checks the address a name leads to as it connects, which closes the gap above. The web app's host therefore sees which links are previewed, and sites see the host's address instead of the sender's. The chat server still never sees them. A host can turn previews off.

A preview's title and picture are the sender's claim about the page, like the message's text, so a card can say anything. The app only shows a preview for a whole link in the message's own text, always shows which site that link really goes to, and requires its picture to be inline: a preview can't make your device load anything.

### Forwarding

A forwarded message is a new message from whoever forwarded it. On the same server it names the original author, and its files aren't uploaded again: the copy refers to the same encrypted file, so the server can tell that a file was forwarded, though not what's in it. The file stays until the last message using it is deleted. Forwarded to another server, a message only says it's forwarded, and its files are uploaded there again. The "forwarded from" label is the forwarder's claim, as in other messengers.

### Data on your device

Sensitive local data is encrypted with a device key held in your OS keychain (DPAPI, Keychain or Secret Service). The search index stores keyed hashes of words instead of readable text. If Linux has no keychain available, the app warns you in Settings, because this protection is weaker there.

The web app has no keychain to use, so its device key is in the browser's own storage, next to the data it protects. Anyone who can copy the browser's profile can read that data, and Settings says so.

## Limits

These are real limitations, stated plainly:

- **A malicious server can try to guess weak passwords.** It holds what's needed to test guesses offline. Argon2id slows this down and sign-up rejects very weak passwords, but a long, unique password is your real protection.
- **Stealing your account key exposes your history.** Anyone with your password or recovery key, combined with the server's data, can read everything you had access to. Stored history has no forward secrecy; this is the cost of history on new devices.
- **Replacing your keys only takes effect once the secret has changed.** If you think your password or recovery key was stolen, change them and remove any device you don't recognize in Settings. Removing a device evicts someone who has that device but not your password, and changing your password evicts someone who only had that. What they could already read, they keep.
- **Accounts from before key replacement keep a weakness until you next enter both secrets.** A recovery key's wrapper can't be converted without the recovery key, so until you use it or replace it in Settings, new account keys are also sealed under your first account key. Someone with a copy of that key who also has the server's data can then still read new items. An honest server keeps them out. New accounts don't have this limit.
- **A contact can't always tell a real change of key from a stolen one.** Someone with your old identity key and a malicious server's help can show a false chain to a contact who hasn't seen the real one. The first one a contact sees stays, a second produces a warning, and comparing emoji shows which is real.
- **People on older versions of the app aren't protected by key replacement.** They go on trusting your first identity key. Anyone on a current version in the same chat still removes a device signed by it, and warns about it.
- **Metadata is visible to the server.** See the table above.
- **Group permissions are enforced by the server, and checked by clients where MLS allows.** It decides who may add and remove members. A malicious server can't add someone invisibly, but it could allow actions a client's interface wouldn't offer. Those appear in the conversation. Whether a group shares its history with people added later is an admin's signed choice, not the server's.
- **A member can hold up a group for a while.** MLS can't let the server check a commit, so a member can send one nobody can apply. Any member's app then undoes it, without anyone doing anything, back to what the server held before, and whoever sent it has to wait longer each time. The same undoing means a member can make another wait, by undoing their commits. An admin can remove someone doing either, and a plain member can't undo an admin's commit.
- **A kicked member keeps the community key.** They could still read profile data if they had access to the server's database. They lose access to the server itself and to new messages.
- **The server can withhold or delay delivery.** It can also serve an old version of an edited message, or claim a message was deleted. It can't forge content.
- **What older apps wrote says less.** A message from an app too old to sign who wrote it can be put under another member's name by a server with that member's help, and a reaction from before they were signed can be worked out from its ID. New ones can't.
- **A server can see some emote pictures being fetched.** The desktop and web apps fetch a server's whole emote set in the background, so showing an emote asks the server for nothing. An emote from outside the current set is still fetched when a message first shows it, and so is every emote on iPhone and iPad, which tells the server which emote, from which address, and roughly when.
- **An account from before sign-in keys were bound to their server can be taken with a copy of its database,** until that account next signs in, which binds its key. The server says how many it has when it starts. A backup of the server's data is worth protecting for this reason, among others.
- **`zuna://` links can be claimed by another app** on iPhone, iPad and Linux. A link for an invite carries the community key, which protects profiles. Universal links can't help here, since each server is on a domain of its own that the app can't list in advance.
- **The time shown comes from the server.** The sender's device also signs the time it sent a message, and the app flags a message if the two are far apart.
- **Deleting is best effort.** "Delete for everyone" removes the server's copy and the copies on members' apps, but a modified client or a screenshot can keep it.
- **Invite pages run on your server.** An invite link's landing page is served by that server, which could read the fragment with altered page code. Pasting links directly into the app avoids this.
- **A compromised device is out of scope.** Malware on your computer can read what you can read.

## The web app

A web app's code comes from its host on every visit. A malicious or hacked host could quietly send code that steals keys, which defeats the purpose of end-to-end encryption. Installed apps avoid this, so they remain the safer choice. The web app is for people who host it themselves, or trust whoever does as they'd trust their own computer.

What limits the risk:

- **The web app's host is never a chat server.** It runs as its own program, `zuna-web`, on an address of its own. A chat server, or someone who breaks into one, can't change the code, and its pages can't reach the web app's storage.
- **It loads nothing from anyone else.** Every file comes from its host, under the desktop's content security policy: no inline scripts, and images only from memory. The host also sends `frame-ancestors 'none'`, `X-Frame-Options`, `Cross-Origin-Opener-Policy` and `nosniff`, and pages it fetches for previews are marked so they can never run as pages there.
- **A copy can be checked.** Each release lists the SHA-256 of every file the web app serves, and `scripts/check-web.mjs` compares a running copy with it. This shows what the host serves when you check, not what it serves to everyone at every moment.
- **Its local data is weaker,** as described under "Data on your device".

`docs/WEB.md` says how to run it.

Installed apps only hold their advantage if the app you installed is genuine, so **install Zuna only from the [official releases](https://github.com/SocketByte/zuna-chat/releases)**. Each release lists SHA-256 checksums for its files. Signed Windows and macOS builds update themselves, and only ever to an update signed by the same publisher. Linux builds don't update themselves yet.

## Electron hardening

The renderer runs sandboxed with context isolation and no Node access. A strict content security policy applies, the main process only accepts requests from the app's own origin, and links only open in your browser for `http(s)` addresses. Nothing in a message can load remote content: images only ever come from memory, so a link or an attachment can't be used to track whether you've seen it. Packaged builds can't be started as a plain Node process or with an inspector, and their code is checked for changes when they start. Anything a message says is checked before it's shown, and one that can't be displayed can't take the rest of the app with it.
