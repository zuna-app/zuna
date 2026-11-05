# Security details

How each of Zuna's protections works, for anyone checking them. [SECURITY.md](../SECURITY.md) says what they mean for the people using Zuna, what the server can and can't see, and the limits.

## Group encryption: MLS

Every conversation, including DMs, is an [MLS](https://www.rfc-editor.org/rfc/rfc9420.html) group, using the ciphersuite `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`. The implementation is [OpenMLS](https://github.com/openmls/openmls), compiled to WebAssembly.

Each device is its own member of each group. Keys change at every membership change and at least weekly on active conversations. The server's only role in MLS is enforcing one order of commits per group.

## Message content

Each MLS epoch exports a content key (RFC 9420 section 8.5). Messages are encrypted under it with XChaCha20-Poly1305, padded to 256-byte blocks, and signed with the sender's device key (Ed25519). The signature matters because all members share the content key: without it, any member could impersonate another. What's signed says who wrote it as well as what it says, so a server can't put one person's words under another's name, even with a member's help. Reactions, read positions, pins and deletions are signed the same way, and say which message or person they're about. Every signature also names the account and device it's from, so a device key that someone else's certificate names too can't pass one person's reaction off as another's.

Using exported keys rather than MLS's per-message ratchet is a deliberate trade-off, and it's what makes history on new devices possible:

- **Gained:** a device you add later can read your past messages, and new group members can receive history if an admin allows it.
- **Given up:** forward secrecy within an epoch and, for stored history, against theft of your account key. See "Limits" in [SECURITY.md](../SECURITY.md#limits).

## Keys on new devices

Your **account key** is random. It encrypts your identity keys and a vault of content keys, all stored on the server as ciphertext, each kind under a key derived from it for that alone. It's unlocked by either:

- your **password**, stretched on your device with Argon2id (64 MiB, 3 iterations), or
- your **recovery key**, 200 random bits shown once at sign-up.

Your password never leaves your device. A key derived from it authenticates you, and a separate one opens a key pair that the account key is sealed to, so any of your devices can seal a new account key to your password without knowing it. The first is bound to the server's address and your username, so one a malicious server collects is no use anywhere else, even if you use the same password on several servers. Clients only derive keys within fixed limits, so a malicious server can't downgrade them or make the app run out of memory.

Sealing to that key pair needs no secret, so a server could seal a key of its own to it. What you unlock also names the key your account began with, and signing in only goes ahead with keys that really are that account's. A device that already knows your account also won't give it up for one that began with another key.

## Identity and devices

Each account has one long-term Ed25519 **identity key**. Each device's MLS credential is a certificate signed by it, naming the key that device signs with. Certificates are public, so holding one proves nothing: clients check every member of every group, whenever a group's tree may have changed and before encrypting anything, against the identity key they know for that person, and that the member really signs with the key its certificate names. So without that identity key, the server can't add a device to anyone's account. Whoever tries is removed, and everyone is warned. A leaf nobody can check yet counts for nothing, and nothing is encrypted to a group while one is on its roster. A server can make accounts of its own, as it can sign anyone up, but it can't get one into a conversation. A group's roster (below) says who its admins have let in, and anyone else in its tree is removed before anything more is encrypted. A direct message's two people are settled when a device first sees it, and anyone else in its tree is removed. What you write to someone can't be sent to another conversation either: if the server names one this device knows as something else, nothing is sent.

A device signs in to the server with a session token. Removing a device, deleting a message or a conversation, pinning or unpinning one, leaving one, changing who's a group's admin, managing invites, writing to the vault, replacing the account's keys or anything that carries them to its devices, and anything an admin does also take a signature by the device's own key, so a token found on its own, such as in a proxy's log, can't do them.

Clients pin the first identity key they see for each person, and share those pins, and what you've verified, with your other devices through your encrypted vault. One item there, a manifest, lists all of them with your preferences and how far along each person's chain of keys your devices have got, under a number that only goes up. It's the only place any of that is kept, so the server can't leave out one person's pin or verification, and a device that has seen a manifest refuses an older one and says so. An account starts with one, and each replacement of your keys seals its number in, so a new device warns if it's shown an older manifest than that, or none. If two of your devices hold different keys for someone, they warn too. An account moves on from that key only by a signed chain that starts from it. Anything else, including two chains for the same person, produces a loud warning, including on a new device of yours.

## Replacing your account's keys

When a device is removed or signs out, your password or recovery key changes, or someone signs in with your recovery key, your app replaces your account key, identity key and HPKE key, in the background. It seals the new account key to each remaining device and to your password and recovery key, and publishes one signed link from the old identity key to the new one, listing the devices that stay. Contacts follow that chain, and from then on a certificate signed by the old identity key means nothing unless its device is on the list. The vault is sealed again under the new key. The design and what it can't do are in [ACCOUNT_KEY_ROTATION.md](ACCOUNT_KEY_ROTATION.md), and **no independent cryptographer has reviewed it yet.**

## The emoji check

Pinning alone doesn't protect a first conversation: a malicious server could hand out a fake key from the start. The emoji check closes that gap. Two people compare 16 emoji (96 bits, from Argon2id over both identity keys, at the same cost as a password). A server that swaps both people's keys only needs the two sides to agree, so a match is cheaper to find than for one fixed key: the memory Argon2id needs for every attempt, and the 96 bits, put that out of reach. If they match, each app holds the other person's real key, and since every device in a chat has to be signed by that key, nobody else's device can be in the chat as them. Saying they match only ever trusts the key those emoji were made from, so a server can't use that moment to swap in another. After someone's keys are replaced, the emoji change, and a verification only carries over if a device the other person has known for at least a week made the change. Otherwise that person goes back to unverified, and a line in your chat says so.

## Who's in a conversation

The server keeps a list of who's in each conversation, for what it does itself. A group also has a **roster**: who its admins are, and who they've let in, in a private extension of its MLS group context (`ROSTER_EXTENSION` in `crypto/src/mls.rs`, `packages/core/src/roster.ts`). MLS makes every member hold the same one, and only a commit changes it. Each version is signed by the device that made it and names the hash of the one before. Clients check every change before keeping it: an admin may change anything, anyone may take themselves off it, and when none of the admins is left in the group, the one person the server made its admin may take over and change nothing else. Whoever rejoins a group takes its roster only if it's the version held, the next one, or a later one an admin of the held version signed. Group admins are the roster's, for deletions, the group's details, history grants and who may add or remove people. The server's list of admins follows the roster, taken only from an admin's commit. What MLS proves is who actually holds the keys. Clients go by that, and by the roster:

- Someone the roster doesn't name, or a device that isn't what it claims, is removed before anything more is encrypted, and everyone gets a warning in the conversation.
- That someone left is only announced once their keys are really gone. Who removed them is named only if MLS shows it: otherwise, it would be the server's word.
- The member list shows a difference if there is one: someone who holds the keys but isn't listed, or who's listed with no device in the group.
- Only an admin's device can set a group's name and picture, which it signs, and an older copy can't be served again.
- A member can't remove someone from a group's keys: everyone is told, and the person removed rejoins straight away.

## What the server can't make your app do

The server can say you're out of a conversation or signed out, but your messages stay on your device until you clear them, sign in again, or 30 days pass. It can say a message was deleted, too, but your app only erases its copy if the deletion was signed by the device of whoever wrote it or, in a group, of an admin. Otherwise the message is hidden as deleted and kept for 30 days. That includes a device you removed from your account in Settings, so a lost device isn't wiped if it comes back online: removing it cuts off its access, not what it already holds. Nor can it pin a message on its own: a pin only shows if a member's device signed it, and only a later pin or unpin, also signed, replaces one your app has seen.

## Profiles and the community key

Display names and avatars are encrypted under a **community key**, carried in the fragment of invite links (`#k=...`), with a key derived from it for profiles alone, as channels and sounds have theirs. Browsers don't send fragments to servers. Profiles are also signed by their owners.

If an admin turns on open sign-ups, there's no invite link to carry that key, so the app gives it to the server, and the settings screen says so. This exposes profiles, not messages.

## Channels

Everyone on a server can see and join its channels, so a channel is only as private as the server's membership. What they're called and everything said in them is end-to-end encrypted in the same way as a group's, and the server can't read any of it. The server does see each channel's rules: how many fit, how many may share a screen, whether the soundboard plays there, and its slow mode, which it holds everyone but admins to.

To be in a channel, someone has to show they hold the community key, which comes with invite links and which the server doesn't have. Members check that for each person on the roster, and remove anyone who can't. A server can't get an account of its own making into a channel. Three things to know about that:

- **Open sign-ups** give the server the community key, so there it could.
- **Someone banned** still holds the key. The server takes them off the roster, and members remove them, but a server that wants them back could put them back. They'd get what's said from then on, not what was said while they were gone.
- **Old invite links** carry the key too. Whoever holds one can read channel names if they get hold of the server's data, and can sign up if the invite still works. Nothing else depends on that key.

A newcomer gets a channel's history from a member's device, which signs what it hands over. Any member can do that, since all of them may read all of it, so a member with bad intentions could hand someone a wrong key for an old epoch, and those old messages then wouldn't open. Nothing new is at risk: only MLS's own keys are used for what's sent from then on.

## Voice channels

Media is encrypted in the app with a key from the channel's MLS group, frame by frame, before LiveKit sees it. LiveKit and the Zuna server can't hear or see it. The key exists only for the group's current epoch and is never stored or handed on, unlike the keys to messages: a stolen vault, or someone who joins later, can't open a recording of a call. A device in a room whose epoch has lasted six hours makes a new one, since the nonces frames are encrypted under start repeating after about thirteen hours of video.

- **What they do see.** The Zuna server sees who's in which voice channel, whether they say they're muted, deafened or sharing, and when. LiveKit sees who's in a room, by user and device ID with no names, and from when to when, who's sending what, how big it is, and how loud each person's audio is, since that's what lets it say who's speaking. Frames are encrypted, not hidden: their size and timing can say something about what's being said.
- **Who can hear.** Whoever is in the group. Someone removed goes on being able to open what's sent under the old key for about 1.5 seconds, while everyone moves to the new one. Someone in the room without the key can't open anything: the server can put someone in a room, but not in the group.
- **Who said it.** Everyone in the group can work out everyone's sender key, so a member could send media as another member. LiveKit can't. There are no per-frame signatures.
- **The microphone** is processed entirely on the device. Nothing about it leaves but what's sent.
- **Who can share a screen** is up to each server's admins, and LiveKit enforces it. Coming into a voice channel doesn't allow a screen at all, and the server only allows one after checking its rules, which it can also take back. See [SCREEN_SHARE.md](SCREEN_SHARE.md#what-a-server-says-and-what-a-device-chooses).
- **The iPhone's broadcast extension**, which records the screen before iOS 27, never has a key. It hands frames to the app over a socket in the App Group, which only Zuna's own app and extensions can open, and the app encrypts them. A broadcast started from Control Center goes out only once the server has made room for it, as one from the app's button does.
- **The native screen capture** gets its keys over its standard input, never its command line, and its token can only publish a screen. libwebrtc's logs stay off unless `ZUNA_WEBRTC_LOG` is set, since the native frame cryptor has been reported to log keys. `poc/screenshare/scripts/key-log-check.mjs` looks for that.
- **The soundboard** is a server's sounds, which its admins add. Each one's name and the key to its file are sealed with the community key, as a channel's name is, and signed by the device that added it. Playing one sends nothing through LiveKit: the app tells the others in the room which sound, sealed under the room's group's key and naming who played it, and each of them plays the file themselves. The server passes it on to those in the room without keeping it, and refuses it from someone muted or deafened, by themselves or by an admin, or more often than every two seconds. Apps play a sound only once, and not if it names someone other than whom the server says played it, or is more than five minutes from now by the player's clock.
- **Push to talk from another window** uses a system-wide key hook in the desktop's main process, only while someone is in a call with it on, and only the one key asked for is ever passed on. Under Wayland there's no such hook: the compositor binds that one key through the global shortcuts portal, and only says when it goes down and up.

## Calls in direct messages and groups

A call is a conversation's own room on the same media server, keyed from that conversation's MLS group exactly as a voice channel is from its own, so everything above holds for it: whoever is in the conversation can hear it, and nobody else.

- **Who hears of a call.** Who's in it, whose devices it's ringing and who declined go only to the conversation's members, never to everyone on the server, as a voice channel's do. The server itself sees all of it, and when, as it sees who's in a voice channel.
- **Waking a phone for a call** goes through the push relay and Apple, sealed as any push is, with the conversation's ID and who started the call. They can tell a call's push from a message's, so they learn that a phone is being rung, and when, though not by whom or in which conversation.
- **Ringing is the server's word.** A server can say someone is calling who isn't, or not ring someone. Answering a call nobody made comes into an empty room, and can't let anyone hear anything: the media key still comes from the conversation's group.
- **Admins have no say in a call**, which is between the people in it: muting someone for everyone, disconnecting them and stopping their share are for voice channels. The server's rules on sharing a screen hold in calls too, and a ban takes someone out of their calls.

## Presence and phone notifications

Which of your devices you're using, and when you last used each, decides when the others are notified, so the server knows it, whether or not you hide your online status from other members.

The server knows which devices get pushes, and through which relay. Until Apple lets the iPhone app filter notifications, it also knows which chats a phone muted and until when, among them direct messages with people the person blocked, which look like any other muted chat. It learns that a chat was read, which stops a push waiting for it. A push carries only the message's IDs, sealed for the device.

## Disappearing messages

How long a chat's messages last is part of its details, signed by whoever set it: in a group only an admin's device counts, and in a direct message either person's. Each message then says how long it lasts, under its sender's signature, and tells the server when it's due. Every device erases its copy, with what search and the chat's details knew of it, once it's due, counting from the earlier of the server's time and the sender's own, so neither can make it last longer. An edit can't change it, and a copy the server sends again stays gone. The server removes its own copy and the message's files within a minute of that.

## Files

Each file gets its own random key. It's split into 1 MiB chunks encrypted with XChaCha20-Poly1305 in the STREAM construction, which detects reordered, missing or truncated chunks. The key travels inside the encrypted message.

## Metadata in files

The server can't read files, but everyone who receives one can, and so can anyone they pass it to. So before a file is sent, the sender's device takes out what it says about where, when and on what it was made: the place, the camera or phone and its serial number, dates, the program, editing history, comments, and the thumbnails some cameras keep of the picture as it was before it was cropped. This covers photos (JPEG, PNG, WebP, GIF, HEIC and AVIF), videos (MP4, MOV, 3GP, WebM and MKV), and drawings (SVG), along with pictures inside a drawing. A video loses its tracks of timed metadata too, where some cameras record where they were at each moment, and anything a phone adds after a photo's end, such as a motion photo's video. Nothing is compressed again: what a photo or video shows stays as it was, byte for byte, and so do which way up it goes and its colors. A drawing keeps what's drawn, without what drawing programs keep for themselves, such as layer names and the paths of files on the sender's disk.

This is on unless someone turns it off on a device, in Privacy settings, which first says what files will then show and asks to be sure. Other files, such as documents, sound files and RAW photos, are sent as they are, and so is a file that doesn't read the way its kind should. What a picture shows can't be taken out, and nor can the faint pattern a camera's sensor leaves, which can tie photos to the camera that took them.

## Link previews

The sender's device makes a link's preview while they write: it fetches the page, and the title, description and a small picture travel encrypted inside the message. Recipients never contact the site, and the server never sees the link. The site sees the sender's IP address, as it would if they opened the link, and from when the link is typed, even if the message is never sent. Pages are fetched without cookies, only over HTTPS, and only from public addresses: redirects are checked one at a time, and names that lead to this machine or a private network are refused. What counts is where each connection really went, so a site's DNS can't switch where it points between the check and the fetch: the desktop app connects through a small proxy of its own, which reaches only the address it checked, and the iPhone and iPad app drops what it fetched if the system says it came from this device or a private network. When the system is set to use a proxy for a link, that proxy decides where the connection goes. Previews can be turned off on each device.

In the web app, the page can't fetch other sites, so its host, `zuna-web`, fetches pages for it by the same rules, and only on port 443. It checks the address a name leads to as it connects. The web app's host therefore sees which links are previewed, and sites see the host's address instead of the sender's. The chat server still never sees them. A host can turn previews off.

A preview's title and picture are the sender's claim about the page, like the message's text, so a card can say anything. The app only shows a preview for a whole link in the message's own text, always shows which site that link really goes to, and requires its picture to be inline: a preview can't make your device load anything.

## Shared locations

A shared location is where the sender's device said it was, sent inside the encrypted message like its text. The app only asks the system where it is when someone chooses to share it, and shows what it found before sending. Nothing in a message loads a map, since that would tell a map's server where people are looking: the app shows the coordinates, and only opening them, on OpenStreetMap from the desktop and the web app or in Maps on iPhone and iPad, tells that service.

## Forwarding

A forwarded message is a new message from whoever forwarded it. On the same server it names the original author, and its files aren't uploaded again: the copy refers to the same encrypted file, so the server can tell that a file was forwarded, though not what's in it. The file stays until the last message using it is deleted. Forwarded to another server, a message only says it's forwarded, and its files are uploaded there again. The "forwarded from" label is the forwarder's claim, as in other messengers.

## Data on your device

Sensitive local data is encrypted with a device key held in your OS keychain (DPAPI, Keychain or Secret Service). The search index stores keyed hashes of words instead of readable text, and the index of each message's photos, files and links, and of which ones mention you or reply to you, names their kinds the same way, though how many a message has is in the clear. If Linux has no keychain available, the app warns you in Settings, because this protection is weaker there.

The web app has no keychain to use, so its device key is in the browser's own storage, next to the data it protects. Anyone who can copy the browser's profile can read that data, and Settings says so.

On the iPhone and iPad, the share extension uses the same data and device key as the app, from the same Keychain group, and asks for Face ID or the passcode first when App lock is on. What it hands the app while the app is awake is sealed with a key from the device key. Files being shared wait in the App Group until they're sent, as readable as they were in the app they came from.

## The web app's host

- **The web app's host is never a chat server.** It runs as its own program, `zuna-web`, on an address of its own. A chat server, or someone who breaks into one, can't change the code, and its pages can't reach the web app's storage.
- **It loads nothing from anyone else.** Every file comes from its host, under the desktop's content security policy: no inline scripts, and images only from memory. The host also sends `frame-ancestors 'none'`, `X-Frame-Options`, `Cross-Origin-Opener-Policy` and `nosniff`, and pages it fetches for previews are marked so they can never run as pages there.
- **A copy can be checked.** Each release lists the SHA-256 of every file the web app serves, and `scripts/check-web.mjs` compares a running copy with it. This shows what the host serves when you check, not what it serves to everyone at every moment.

[WEB.md](WEB.md) says how to run it.

## Electron hardening

The renderer runs sandboxed with context isolation and no Node access. A strict content security policy applies, the main process only accepts requests from the app's own origin, and links only open in your browser for `http(s)` addresses. Nothing in a message can load remote content: images only ever come from memory, so a link or an attachment can't be used to track whether you've seen it. Packaged builds can't be started as a plain Node process or with an inspector, and their code is checked for changes when they start. Anything a message says is checked before it's shown, and one that can't be displayed can't take the rest of the app with it.
