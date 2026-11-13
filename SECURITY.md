# Security model

Zuna's goal is that a server you don't fully trust still can't read your messages. This page says what that means, and what it doesn't protect against. How each part works is in [docs/SECURITY_DETAILS.md](docs/SECURITY_DETAILS.md).

**Zuna hasn't had an independent audit.** OpenMLS, the library at its core, has been audited, but Zuna's own code, including how it uses that library, hasn't been reviewed by anyone independent. Keep this in mind for high-risk uses.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" feature on the repository's Security tab, rather than in a public issue.

## In short

- **The server can't read what you write.** Messages, files, reactions, group names, calls and voice are encrypted on your device so that only the people in a conversation can open them, and profiles and channel names so that only the people invited to the server can.
- **It does see who talks to whom, and when.** Zuna hides content, and who in a conversation wrote each message, but not who's in it. The table below lists what the server sees.
- **Your password opens your history.** It never leaves your device, but anyone who learns it can read everything you can.
- **The emoji check proves who you're talking to.** Until you compare emoji with someone, a malicious server could have given you a fake key for them from the start, though it would have to show that key to their own devices too, or keep two stories, which the first message between you gives away.
- **A bot reads the chats it's in.** It's a member like any other, run by a program on a machine its owner chose, and it shows a badge wherever its name does.
- **The installed apps are safer than the web app,** whose code comes from its host on every visit.

## What the server can and can't see

| | Server can see | Server can't see |
|---|---|---|
| **Accounts** | Username, role, sign-up date, which devices exist, when an account was deleted | Password, display name, avatar, bio |
| **Conversations** | Who is in each conversation | Group names, pictures and descriptions |
| **Messages** | When one was sent, to which conversation, and roughly how big it is | Who sent it (though it can often work that out, as "Limits" says), text, replies, mentions, formatting, emotes used (with the exception under "Limits"), links and their previews, shared locations, whether and from whom it was forwarded |
| **Reactions** | Which message was reacted to | Which reaction it was (with the exception under "Limits"), and whose |
| **Files** | Who uploads a file, and its size, until a message carries it, and which messages share a file, as a forwarded one does | Name, type, content, and once a message carries it, who uploaded it |
| **Pins and deletes** | Which message was pinned or deleted, and which admin deleted someone else's message in a group | The message's content, who pinned it, and who deleted their own |
| **Sending** | How much each person asked to be able to send in each six hours, and how much each person uploads in thirty days | What they sent with it |
| **Disappearing messages** | When each message is due to go, and so how long a chat's messages last | The setting itself |
| **Read state** | That someone's read position changed | The position itself |
| **Typing** | That someone in a conversation is typing | Who |
| **Channels** | That each exists, who made it, whether it's for text or voice, its place in the list, and its rules, such as how many fit and its slow mode | Its name, topic, heading and audio quality, and everything said in it |
| **Soundboard** | How many sounds there are, who added each and how big its file is, and when someone played one | What each is called and sounds like, and which was played |
| **Watching together** | That a device in a voice channel or call sent something about the video it watches, when, how big, and to whom when it answers someone coming in | Which video, whether it was a pause or a seek, and who's watching |
| **Presence** | Online status, last seen, and which of your devices you're using and when you last used each | Hidden from other members if you choose, but not from the server. As on Telegram, whoever sees you write, type or read their messages sees you online for 30 seconds after, in their own app |
| **Phone notifications** | Which devices get pushes, through which relay, which chats a phone muted and until when, which chats each phone was notified about since they were last read, and that a chat was read | What a push is about, and who sent the message it's for |
| **Calls** | Who's in a call in which conversation and when, whom it rings and who declined, and whether they say they're muted, deafened, on camera or sharing | What's said and shown in it |
| **Network** | IP addresses of connecting devices, or with a SOCKS5 proxy set on one, the proxy's | |
| **Search** | Nothing: it runs on your device | Your queries |
| **Reports** | Whom someone reported and why, and who sends a report as it arrives, which it doesn't keep | What was said |
| **Bots** | That an account is a bot, whose it is, whether it's listed or private, who may add it, whether it may send files, the channels it was given, which chats it's in and when it's active, and that a message is one nobody is shown, as a button's press is | Its name, picture, description and commands, what it reads and what it sends, and which button was pressed |

## What you can do

- **Use a long password you don't use anywhere else.** A malicious server can test guesses at it offline.
- **Keep your recovery key safe.** It's shown once, when you sign up, and opens your account as your password does.
- **Compare emoji** with the people who matter to you.
- **To keep your address from your servers,** set a SOCKS5 proxy in the desktop app's Settings, Privacy, or give `zuna-bot` `--proxy`. Everything that device sends then goes through it, for every server, and nothing at all while it can't be reached: your servers see the proxy's address. The proxy sees which servers you reach, when and how much, never what you send. Calls go through it too, over TCP where the proxy carries no UDP, and on a Mac so does watching YouTube together, which is off while one is set on Windows and Linux. The iPhone app and the web app have no such setting: a browser follows its own proxy.
- **If you think your password or recovery key was stolen,** change them, and remove any device you don't recognize in Settings.
- **See what your server keeps about you** in Settings, Your data, and save it as a file. It's what the server says it keeps, so a server someone changed could keep more.
- **Paste invite links into the app** rather than opening them in a browser.
- **Install Zuna only from the [official releases](https://github.com/zuna-app/zuna/releases).**

## How it works

### Encryption

Every conversation, direct messages too, is encrypted with [MLS](https://www.rfc-editor.org/rfc/rfc9420.html), an open standard for group encryption, through the audited [OpenMLS](https://github.com/openmls/openmls). Each of your devices holds its own keys, and they change whenever someone joins or leaves, and at least weekly in active chats. Every message, reaction and read position is also signed by the device that sent it, so a server can't put one person's words under another's name, even with a member's help.

Who signed something is inside its encryption, with the signature, so the server can't try each member's key on it to find out whose it is.

Zuna keeps one key for each stretch of a conversation, rather than a new one for every message. That's what lets a device you add later read your past messages, and lets a group's admin share its history with people who join. The cost is that whoever gets your password or recovery key can read all of it.

### Against a quantum computer

A large enough quantum computer would break the public-key cryptography most of the internet uses, and someone can keep what they record today until one exists. So Zuna agrees on keys with ML-KEM-768, NIST's post-quantum standard, and X25519 together, in every conversation's encryption and wherever your account's keys are sealed to a password, a recovery key or a device: recording what crosses the network, or copying the server's data, gives nothing a quantum computer could open later. Every key that signs, your account's, each device's, and the server's log of keys, signs with ML-DSA and Ed25519 together, and everything checks both, so forging a signature takes breaking both. Each pair is there because ML-KEM and ML-DSA are young: if either turns out weak, what's there today still holds. Updates are signed with both too. What wasn't changed, and why, is under Limits. **No independent cryptographer has reviewed this yet.**

### Who sent it

Nothing a member adds to a conversation tells the server who sent it: messages, edits, reactions, pins, a person's deletion of their own message, and typing. They go without the account's session, on a connection of their own where the app can make one, signed with a key that everyone holding the conversation's current keys can make, so any member's signature looks the same, and someone removed can't make it. When someone leaves, is banned or signs a device out, the server stops taking that key until the conversation's keys have changed, which the apps of those who stay see to before they send. What each costs is a token, which the server gave the person's device earlier, counted against them, but can't tie back to them when it's spent, which keeps anyone from flooding a conversation without a name. Who wrote what is signed inside, where only members see it, and the server keeps no sender of anything, nor who uploaded a file once a message carries it.

Changing or deleting something takes a key that only its author's devices can make, which names nobody. A group's admin deleting someone else's message, changes to who's in a conversation, calls, voice, presence and read positions still name who they're from, as each is about someone being somewhere, or something the server has to check. A phone isn't told of its own person's message: each notification waits a moment, and the device that sent it reads it at once, as anyone reading it as it arrives would.

### Your password and recovery key

Your account's keys are stored on the server, encrypted with a key that only your password or your recovery key can open. Your password never leaves your device, and what your device uses to sign in is tied to that server and your username, so it's no use anywhere else, even if you use the same password on other servers.

When a device is removed or signs out, your password or recovery key changes, or someone signs in with your recovery key, your app replaces your account's keys in the background, and your contacts' apps follow the change. **No independent cryptographer has reviewed how this works yet.**

### Knowing who you're talking to

Each account has one identity key, and every one of its devices has to be signed by it. Your app checks every device in a conversation before it encrypts anything, so the server can't slip in a device as you or as anyone else: it's removed, and everyone is warned. Your app remembers the first key the server's log of keys (below) names for each person, and your devices share what they've seen and verified. A key only changes through a signed handover from the old one, and anything else gives a loud warning.

The server also keeps a log of every account's keys and devices, which it signs and can't change afterwards, and every app reads all of it. A key or a device only counts if the log names it, so whatever the server says about you to anyone, your own devices see too: when a device signs in to your account, each of your devices from before it asks whether that was you, over everything, until you answer, and someone signed up under your username gives you a warning. If it wasn't you, your answer removes that device, replaces your account's keys, and asks you to change the password or recovery key it signed in with, which is what keeps them out. Your app tells the people you write to which version of the log it holds, inside your messages, your other devices through your encrypted vault, and whoever joins through an invite link you made, in the link. If the server showed different people different logs, the first message between them proves it, and both are warned. This finds out rather than prevents: someone could be shown a false key until the real owner's device reads the log, and someone the server keeps apart from everyone, from their first moment, has nobody honest to compare with until they compare emoji with anyone.

The server can create accounts of its own, as it can sign anyone up, but it can't put one in a conversation: who a group's admins have let in is part of the group's encrypted state, so anyone else who comes in is removed before anything more is sent to them, and everyone is warned. Nobody but its two people can be in a direct message.

**The emoji check** covers what the rest can't: a first conversation, where a malicious server could hand out a fake key from the start. You and the other person compare 16 emoji. If they match, your apps hold each other's real keys, and nobody can be in the chat as either of you. If someone's keys are replaced later, the match only carries over when one of their devices that your app has known for at least a week made the change. Otherwise they're unverified again, and the chat says so.

### Groups

Who a group's admins are, and who they've let in, is kept in the group's encrypted state, signed by the admin who changed it, and only an admin's device can change it. The server keeps its own list for what it does itself, but your app goes by the group's, and by who really holds the keys. Someone who comes in without an admin letting them in is removed, and a device that isn't what it claims too, with a warning in the conversation. When a group's last admin leaves, the server picks its longest-standing member, as it always has, and that person's app makes it so for everyone. Someone leaving is only announced once their keys are gone, and the member list shows it when the server's list and the keys disagree. Only an admin's device can change a group's name and picture.

The server can't make your app erase anything. If it says you're out of a conversation or signed out, your messages stay until you clear them, sign in again, or 30 days pass. A message is only erased when its author's device, or in a group an admin's, signed the deletion: otherwise it's hidden and kept for 30 days. A device you remove keeps what it already holds. Nor can the server pin a message on its own.

### The community key

Display names, avatars, channel names and the soundboard's sounds are encrypted with a community key, which everyone on a server shares and the server doesn't have. It travels in the part of an invite link after `#`, which browsers never send to servers. Being in a channel also takes proving you hold it, so a server can't get an account of its own making into one.

If an admin turns on open sign-ups, there's no invite link to carry the key, so the app gives it to the server, and Settings says so. The server can then read profiles and channel names, and put accounts of its own in channels, which anyone who signs up can join anyway. Direct messages and groups are unaffected. Old invite links carry the key too: whoever has one can read those with a copy of the server's data, and can sign up while the invite still works.

### A server without a domain

A server can go by its IP address instead of a domain. No certificate authority vouches for an address, so the server makes its own certificate, and its links carry a fingerprint of its key after the `#`, where the community key goes. The desktop and iPhone apps trust that key for that address and nothing else, so nobody in between can pose as the server. A link can't change the key for a server you're on, and only an address can have one, never a name. A browser can't check a certificate this way, so the web app can't reach such a server.

### Channels

Everyone on a server can see and join its channels, so a channel is only as private as the server's membership. What's said in them is encrypted as in any group. A newcomer gets a channel's history from a member's device, and a member with bad intentions could give them a wrong key for old messages, which then wouldn't open. Nothing sent from then on is at risk.

### Bots

A bot is an account with keys of its own, which a program runs on a machine its owner chose. It's a member of the chats it's in as a person is, so it reads everything said there from when it was added, on that machine. It gets nothing from before, even in a group that shares its history. A bot shows a badge wherever its name does, the app asks each time before one is added to a group, and the line in the chat says a bot was added. Nobody is in a chat with a bot without seeing it there.

Its owner sets it up with a link that works once, for an hour. The bot's keys are made on its own machine, so not even its owner holds them, and the link carries a key the server never sees, which the bot signs its own with. The owner's app checks that, so it knows it's talking to the bot it set up, with nothing to compare. To everyone else a bot is like anyone they haven't compared emoji with: the first key they see for it is the one they keep, and they're warned if it changes.

A private bot is hidden from everyone but its owner and the people in a chat with it, the server's other admins included. That's the server's doing, so it hides a bot from people, not from the server. Everyone's app gets the log of keys' records about it, which say nothing by themselves, but a modified app could tell from them that private bots exist and when their keys change, and test guesses at one's username. Who may add a bot to a group is the owner's choice, which the server keeps and the bot keeps too: added by someone its owner didn't allow, it leaves. A bot can't start a chat, write to someone first, join voice or be one of the server's admins. [BOTS.md](docs/BOTS.md) says how to make and run one.

### Plugins

The desktop app takes plugins: packages you install to change how it looks and what it does. End-to-end encryption can't protect a message from code you install in the app that decrypts it, so a plugin starts with nothing. It reads no message, name or server until a permission says so, and you grant each one when you install it, in plain words. Reading your messages and reaching the internet together is named as that, above the rest: such a plugin could send them anywhere.

Some things no plugin gets, whatever it asks for: your keys of any kind, your password and recovery key, your devices and who you've verified, the question a new device raises, sound and video themselves, the app's updates, the disk, and other plugins. Each plugin runs in a process of its own that holds none of that, behind a part of the app that checks every request it makes. Who wrote a message is the app's to show, from its signature: a plugin can change how a message looks on your device, under a line saying which plugin did it, but never who it's from.

A verified plugin was read by Zuna's team, built from its source in the open, and signed with a key the app carries, apart from the keys that sign updates. Anything else is installed from a file, only after you turn on a switch in Settings, through a warning that covers the window, and it carries an "Unverified" mark wherever it shows. No link or chat can install a plugin. A device with no plugins never contacts the marketplace. [PLUGINS.md](docs/PLUGINS.md) says how to write one.

### Voice, video and calls

Voice, video and shared screens are encrypted in the app, frame by frame, with a key from the conversation's or channel's group, before they reach LiveKit, the media server. Neither it nor the Zuna server can hear or see them. That key is never stored, so a stolen account, or someone who joins later, can't open a recording.

- **What the servers see.** Who's in a call or voice channel and when, as the table says. LiveKit, which knows people only by ID, also sees how much each sends and how loud they are, which is how it tells who's speaking, and that alone can hint at what's being said. It sees each device's addresses too, and an iPhone's or a browser's system and model, which the desktop app doesn't send. The LiveKit Zuna's setup builds keeps none of that in its log, nor who was in which call. One run from LiveKit's own release keeps it all.
- **Who can hear.** Whoever is in the conversation or channel. Someone removed can still open what's sent for about 1.5 seconds, while everyone moves to a new key.
- **Who said it.** A member could send audio or video as another member. Nobody outside the group can.
- **Your microphone** is processed entirely on your device.
- **Who can share a screen** is up to each server's admins, and LiveKit enforces it.
- **Ringing is the server's word.** It can say someone is calling who isn't, or not ring you. A call nobody made is an empty room.
- **A phone woken for a call** tells the push relay and Apple that it's being rung, and when, but not by whom or in which conversation.

### Watching YouTube together

People in a voice channel or a call can watch a YouTube video at the same moment. Which video, whether it plays, where and how fast is sealed under the room's key and signed by the device that changed it, as a played sound is, so the server only learns that something was sent in the room. Each device that watches plays the video from YouTube itself, in YouTube's own privacy-enhanced player, which no script of Zuna's page can reach and which reaches nothing of Zuna's.

- **A device contacts YouTube only after its person presses Watch**, and the first time it asks, saying what Google learns: the device's IP address, which video and when, and in the web app the app's address. Until then the tile shows the title and picture that came inside the room's state.
- **The device that puts a video on fetches its title and picture**, as it would a link's preview, so YouTube sees that device's address, or in the web app its host's.
- **Everyone in the room controls it.** A member could put on any video, or pause it for everyone; nobody outside the room can.
- **A server that lies about the time** can only put people out of step, as each device sets its clock by the server's.
- **On a Mac and on Linux, the app hears the video's own sound** to keep it out of your microphone, so that the room doesn't hear it twice. It takes nothing but what WebKit plays for it, sends none of it and keeps none. macOS calls that recording the computer's sound and asks once.

### Files and photos

Each file is encrypted with its own key, which travels inside the message. Before a photo, video or drawing is sent, your device takes out what it says about where, when and on what it was made: the place, the camera or phone and its serial number, dates, the program, editing history and comments. Nothing is compressed again, so the picture stays exactly as it was. This is on unless you turn it off in Privacy settings. Documents, sound files and RAW photos are sent as they are, and nothing can take out what a picture shows, or the faint pattern a camera's sensor leaves, which can tie photos to the camera that took them.

### Link previews

Your device makes a link's preview while you write, and sends it inside the message, so the people you write to never contact the site, and the server never sees the link. The site sees your IP address from when you type the link, even if you never send the message. You can turn previews off. In the web app, its host fetches them instead, so the host sees which links are previewed, and sites see its address instead of yours.

A preview says whatever the sender's app made it say, but the app always shows which site the link really goes to, and a preview can't make your device load anything.

### Locations and forwarding

The app only asks where you are when you choose to share your location, and shows you what it found before sending. Nothing in a message loads a map: only opening the coordinates tells a map service.

A forwarded message is a new message from whoever forwarded it. On the same server it names the original author, and its files aren't uploaded again, so the server can tell a file was forwarded, though not what's in it. The "forwarded from" label is the forwarder's claim, as in other messengers.

### Disappearing messages

How long a chat's messages last is set by an admin in a group, or by either person in a direct message, and each message carries it under its sender's signature. Every device erases its copy once it's due, and neither the server nor the sender's clock can make it last longer. The server removes its own copy and the message's files within a minute.

### Data on your device

Sensitive data the app keeps is encrypted with a key held in your system's keychain. Files you open are decrypted into a folder that the desktop and iPhone apps empty each time they start. Search runs on your device, and its index keeps no readable text. If Linux has no keychain, Settings warns you, and the key is sealed once there is one. The web app has no keychain, so anyone who can copy your browser's profile can read its data, and Settings says so.

### Deleting your account

You can delete your account on a server in Settings, with your password. The server erases what it kept to sign you in and to give your devices your keys, your profile and picture, your devices' sessions and anything waiting for them, and frees your username. It keeps your account's ID, its public keys and its devices' certificates, so that whoever you wrote to can still check what you sent. What you sent stays with them, from "Deleted account", as the server couldn't take it off their devices anyway. The device you delete it from erases its copy. Your other devices are signed out and keep theirs, as with any sign-out, until you remove it or 30 days pass. A server's owner can't delete their account there.

### Reporting someone

You can report someone to a server's admins at the bottom of their profile, for one of a few reasons. The admins see whom you reported, why and when, in Server settings, and can dismiss it or ban them. Nobody sees what was said, as it's encrypted, and the server doesn't keep who reported whom: it only knows who's sending a report while it arrives, and remembers in memory, for a day, not to take the same report twice. Your account remembers whom you've reported, encrypted as your other settings are.

## Limits

These are real limitations, stated plainly.

### If the server is malicious

These need the server against you: its operator, someone who broke into it, or someone with a copy of its data.

- **It can try to guess weak passwords.** It holds what's needed to test guesses offline. Each guess is slow, and the app refuses a new password that lists of common passwords, words and names would guess within about a billion tries, but a long, unique password is your real protection.
- **It can show a brand-new device an older list of who you've verified.** A new device only knows how recent that list was when your account was made or your keys were last replaced, so it can be shown any copy since then, without whoever you verified or came to trust later. If it's shown none at all, it warns.
- **With your old keys, it can fool a brand-new device of yours.** Someone who has your keys from before they were last replaced can, with the server's help, give a new device an account key of their choosing, and read what it saves from then on, if the server also keeps a second log of keys for that device, which the first message from anyone else gives away. They can't read your real history, and your contacts and other devices warn about that device. A server alone can't hand a new device an older generation of your keys, as the log shows they were replaced.
- **With your old keys, it can fool a contact.** Someone with your old identity key and the server's help can show a contact a false change of your keys, if the contact hasn't seen the real one. It has to be in the log, where your own devices see a change they didn't make and warn you, or in a second log, which the first message between you and that contact gives away. The first a contact sees stays, a second gives a warning, and comparing emoji shows which is real.
- **It can show someone it keeps apart from everyone a log of keys of its own.** Apps compare the log through each other's messages, so a person the server keeps from every honest contact, from their first moment, has nobody to compare with, until they compare emoji with anyone at all, or joined through an invite link made after the people they talk to were there.
- **It can start the log of keys again,** as after restoring a backup. Everyone's app says so once, and nothing an app already holds changes: a key that changed meanwhile still gives the warning.
- **Someone removed from the server keeps the community key.** With a copy of the server's data, they could still read profiles and channel names. A server could also put someone banned back into its channels, where they'd get what's said from then on.
- **It can see some emotes being fetched.** The apps fetch a server's whole emote set ahead, so showing one usually asks for nothing. An emote from outside the set, or any emote when nothing was fetched ahead, as when you've asked to save data or after an iPhone or iPad cleared space, is fetched when a message shows it. That tells the server which one, from which address, and roughly when.
- **It can put a listed bot in any channel.** Which channels a bot was given is the server's to say. The bot would read what's said there, as everyone on the server may, and show among its members. A private bot stays out of channels whatever the server says, and no bot stays in a group it was added to by someone its owner didn't allow.
- **It can take people out of a group,** as it decides who's listed in it, though everyone sees them go. Once it has taken out every one of a group's admins, whoever it makes the group's admin next is believed.
- **The time shown comes from the server.** The sender's device signs its own time too, and the app flags a message when the two are far apart.
- **A server you've left can still wake your iPhone for a while.** It keeps the push relay's handle for your phone, which works for up to 60 days after the app last renewed it. Its notifications say only that a message arrived, without a sound, and a call it rings ends at once, but the app can't hide them until Apple lets it filter notifications.
- **It can often work out who sent a message.** It isn't told, and keeps nothing that says, but it sees the address a sealed request comes from, which is also that device's socket's, and in the web app the browser may send it down the same connection as the account's requests. It sees when devices come online, typing just before a message, a file uploaded just before a message carries it, a change to a group's keys just before a message, a read position just after, and which phones it didn't have to wake. In a direct message, who wrote is one of two. Asking for tokens just before sending, when a device had none left, says something too. And it keeps how much each person uploaded each day, for thirty days, so on a day only one person uploaded, the files in that day's messages were theirs.
- **Invite pages run on your server.** If you open an invite link in a browser, the page comes from that server, and altered page code could read the community key from the link. Pasting the link into the app avoids this.
- **With a quantum computer, a copy of its data and an account, it could forge the keys sealed sending uses.** The key that signs what's sent to a conversation without a name, and the key that lets only an author's devices change or delete their message, are Ed25519 alone, as making them post-quantum would add more than two kilobytes to every message, reaction and typing signal. Forging one would only let that person post what nobody's app shows, or have the server drop its own copy of a message, which the server can always do anyway. And it could forge the tokens that limit how much one sender floods a conversation, which there's no post-quantum standard for yet. Who spent a token stays hidden whatever the attacker can compute.

### Even with an honest server

- **Your password or recovery key opens your history.** Anyone who has either can read everything you had access to, by signing in or from a copy of the server's data. That's the cost of history on new devices.
- **New keys only help once a stolen secret is changed.** Until you change a stolen password or recovery key, whoever has it can open your new keys too. What they already read, they keep.
- **Whoever runs a bot reads what it reads.** A bot's chats are open on the machine that runs it: to its code, to whoever controls that machine, and to anyone who can read its data folder, where its keys are files. A bot running on the chat server's own machine puts its chats within that machine's reach, though nothing else. Its badge is there so you can decide what to say in front of it.
- **A plugin you install can read what you can read.** With the permission to read your messages, it reads them in the clear, as any modified copy of the app could, and with the network as well, it can send them to the hosts it names. Verified plugins are read for that by Zuna's team; unverified ones by nobody. A plugin can also draw a box asking for a password inside its own frame, which is one reason unverified ones sit behind a warning. Zuna's plugins' key signs code for everyone who installed that plugin, so a stolen key, or one maintainer's stolen account, could ship one; the index withdraws it from every device that has it once that's known.
- **A button's press goes to everyone in the chat.** It's a message like any other, which the apps show nowhere. Someone with a modified app could see who pressed which button under a bot's message.
- **A member can post what nobody can open.** Nothing says who sends something to a conversation, so a member, or a modified app, can post bytes that no app shows as anyone's: they're kept out of sight, and tokens bound how many there can be. Slow mode, and the most reactions one person puts on a message, are held by each app the same way: an honest app keeps to them, and the others hide what a modified one sends past them.
- **A member can hold up a group for a while.** The server can't check a change to a group's keys, so a member can send one nobody can apply. The apps undo it on their own, and make whoever sent it wait longer each time, but the same undoing lets a member make others wait. An admin can remove someone doing either, and a plain member can't undo an admin's change.
- **A server's limits on a shared screen's size, frame rate and bitrate are kept by the apps.** The picture is encrypted, so nobody can check it, and a modified app could send more. Who may share, with sound, and how many at once are enforced, though a modified app could reuse an earlier share's permission for the few minutes it lasts.
- **A server without a domain is only as trusted as the first link to it.** The app trusts the key that link names. Someone who sends you a link to that address with a key of their own, and can get between you and it, could pose as the server, seeing what the server sees, though nothing it can't read. Once you're on the server, a link can't change its key.
- **iOS learns who you write to on an iPhone or iPad.** As in Messages and Telegram, the app tells iOS which chats you send to and which messages its notifications are about, with names and pictures, so the share sheet can suggest them. What you write stays out, but a notification's text goes in as the notification shows it. Setting notifications to show nothing stops both.
- **What was recorded before post-quantum encryption stays open to a quantum computer.** That's what Zuna's test servers and its developers' own carried before November 2026. Nothing reaches back to it.
- **Not everything around a conversation is post-quantum.** Voice and video are encrypted with the room's key, which is, but the cipher over each frame takes a 128-bit key, which LiveKit's apps for the desktop and iPhone don't take larger yet: still out of a quantum computer's reach, as far as anyone knows, but less margin than the rest. The connection to the server is post-quantum where the server's proxy supports it, Caddy from 2.10, or nginx and Apache on OpenSSL 3.5, and on iPhones from iOS 26. What it protects is what the server sees anyway, who's where and when. A web app's code is only as safe as the certificate of the site serving it, which isn't post-quantum anywhere yet.
- **Deleting is best effort.** "Delete for everyone" removes the message from the server and from members' apps, but a modified app or a screenshot can keep it. So it is with disappearing messages, and with a notification already shown, except on Windows, where the app takes back its own notifications and keeps message text out of the system's history.

## The web app

The web app's code comes from its host on every visit, so a malicious or hacked host could quietly send code that steals your keys, which defeats the purpose of end-to-end encryption. The installed apps don't have this problem, and remain the safer choice. The web app is for people who host it themselves, or trust whoever does as they'd trust their own computer.

Its host is never a chat server, so a chat server, or someone who breaks into one, can't change its code. It loads nothing from anyone else, but YouTube's player once you press Watch on a video your room watches together. A build of it lists a checksum of every file it serves, so anyone who has that list can check what a host serves, though only at the moment they check. Releases don't carry the web app or its list yet. `docs/WEB.md` says how to run it.

## Installing

Installed apps only hold their advantage if the app you installed is genuine, so install Zuna only from the [official releases](https://github.com/zuna-app/zuna/releases). Each release lists SHA-256 checksums for its files, and carries the desktop app for Windows and Linux. On Windows the app updates itself, and only ever to a release signed with keys the app already carries, of a newer build than its own, and whose file is the one that release names. Each release is signed twice, with Ed25519 and with ML-DSA-65, and the app takes it only if both hold, by keys of one channel: an app that follows stable releases takes nothing the keys for nightly builds signed. Nothing in the environment or on disk can change which keys an app trusts. The Windows installer isn't signed with a certificate yet, so Windows warns about it the first time it's downloaded. Linux builds update with the system's packages or a new AppImage, and there's no macOS build yet.
