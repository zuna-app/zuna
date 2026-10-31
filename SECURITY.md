# Security model

Zuna's goal is that a server you don't fully trust still can't read your messages. This page says exactly what that means, including what it doesn't protect against.

**Zuna hasn't had an independent audit.** OpenMLS, the library at its core, has been audited, but Zuna's own code, including how it uses that library, hasn't. Keep this in mind for high-risk uses.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" feature on the repository's Security tab, rather than in a public issue.

## What the server can and can't see

| | Server can see | Server can't see |
|---|---|---|
| **Accounts** | Username, role, sign-up date, which devices exist | Password, display name, avatar, bio |
| **Conversations** | Who is in each conversation | Group names, pictures and descriptions |
| **Messages** | Who sent one, when, to which conversation, and its rough size (padded to 256-byte blocks) | Text, replies, mentions, formatting, emotes used, links and their previews, whether and from whom it was forwarded |
| **Reactions** | Who reacted to which message | Which reaction it was |
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

Each MLS epoch exports a content key (RFC 9420 section 8.5). Messages are encrypted under it with XChaCha20-Poly1305 and signed with the sender's device key (Ed25519). The signature matters because all members share the content key: without it, any member could impersonate another.

Using exported keys rather than MLS's per-message ratchet is a deliberate trade-off, and it's what makes history on new devices possible:

- **Gained:** a device you add later can read your past messages, and new group members can receive history if an admin allows it.
- **Given up:** forward secrecy within an epoch and, for stored history, against theft of your account key. See "Limits" below.

### Keys on new devices

Your **account key** is random. It encrypts your identity keys and a vault of content keys, all stored on the server as ciphertext. It's unlocked by either:

- your **password**, stretched on your device with Argon2id (64 MiB, 3 iterations), or
- your **recovery key**, 200 random bits shown once at sign-up.

Your password never leaves your device. A key derived from it authenticates you, and a separate one decrypts the account key. Clients refuse to derive keys with weak parameters, so a malicious server can't downgrade them.

### Identity and devices

Each account has one long-term Ed25519 **identity key**. Each device's MLS credential is a certificate signed by it, so the server can't add a device to someone's account or to any group without that key.

Clients pin the first identity key they see for each person. Zuna accounts keep one identity key for life, so a later change produces a loud warning.

### The emoji check

Pinning alone doesn't protect a first conversation: a malicious server could hand out a fake key from the start. The emoji check closes that gap. Two people compare 12 emoji (72 bits, from an iterated SHA-512 over both identity keys, in the style of Signal's safety numbers). If they match, each app holds the other person's real key.

### Membership can't change silently

Membership announcements in chats come from authenticated MLS data, not from the server. If someone joins a conversation without a member having added them, everyone sees a warning.

### Profiles

Display names and avatars are encrypted under a **community key**, carried in the fragment of invite links (`#k=...`). Browsers don't send fragments to servers. Profiles are also signed by their owners.

If an admin turns on open sign-ups, there's no invite link to carry that key, so the app gives it to the server, and the settings screen says so. This exposes profiles, not messages.

### Files

Each file gets its own random key. It's split into 1 MiB chunks encrypted with XChaCha20-Poly1305 in the STREAM construction, which detects reordered, missing or truncated chunks. The key travels inside the encrypted message.

### Link previews

The sender's device makes a link's preview while they write: it fetches the page, and the title, description and a small picture travel encrypted inside the message. Recipients never contact the site, and the server never sees the link. The site sees the sender's IP address, as it would if they opened the link. Pages are fetched without cookies, only over HTTPS, and redirects are checked one at a time. Previews can be turned off on each device.

A preview is the sender's claim about the page, like the message's text. The app only shows a preview for a link that's in the message's own text, so a preview can't present one site as another, and its picture must be inline: a preview can't make your device load anything.

### Forwarding

A forwarded message is a new message from whoever forwarded it. On the same server it names the original author, and its files aren't uploaded again: the copy refers to the same encrypted file, so the server can tell that a file was forwarded, though not what's in it. The file stays until the last message using it is deleted. Forwarded to another server, a message only says it's forwarded, and its files are uploaded there again. The "forwarded from" label is the forwarder's claim, as in other messengers.

### Data on your device

Sensitive local data is encrypted with a device key held in your OS keychain (DPAPI, Keychain or Secret Service). The search index stores keyed hashes of words instead of readable text. If Linux has no keychain available, the app warns you in Settings, because this protection is weaker there.

## Limits

These are real limitations, stated plainly:

- **A malicious server can try to guess weak passwords.** It holds what's needed to test guesses offline. Argon2id slows this down and sign-up rejects very weak passwords, but a long, unique password is your real protection.
- **Stealing your account key exposes your history.** Anyone with your password or recovery key, combined with the server's data, can read everything you had access to. Stored history has no forward secrecy; this is the cost of history on new devices.
- **Stored epoch keys limit post-compromise recovery.** MLS heals a stolen device's state as keys rotate, but while an attacker also has your account key, they can read new content keys from your vault. Change your password and remove the device.
- **Metadata is visible to the server.** See the table above.
- **Group permissions are enforced by the server.** It decides who may add and remove members. A malicious server can't add someone invisibly, but it could allow actions a client's interface wouldn't offer. Those appear in the conversation.
- **A kicked member keeps the community key.** They could still read profile data if they had access to the server's database. They lose access to the server itself and to new messages.
- **The server can withhold or delay delivery.** It can also serve an old version of an edited message, or claim a message was deleted. It can't forge content.
- **Timestamps come from the server.**
- **Deleting is best effort.** "Delete for everyone" removes the server's copy and the copies on members' apps, but a modified client or a screenshot can keep it.
- **Invite pages run on your server.** An invite link's landing page is served by that server, which could read the fragment with altered page code. Pasting links directly into the app avoids this.
- **A compromised device is out of scope.** Malware on your computer can read what you can read.

## Why there's no web client

A web app's code comes from the server on every visit. A malicious or hacked server could quietly send code that steals keys, which defeats the purpose of end-to-end encryption. Installed apps avoid this.

## Electron hardening

The renderer runs sandboxed with context isolation and no Node access. A strict content security policy applies, the main process only accepts requests from the app's own origin, and links only open in your browser for `http(s)` addresses. Message text never loads remote content, so a link can't be used to track whether you've seen it.
