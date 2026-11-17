# Security model

**Zuna is a small, non-profit, open source project, with no company behind it.** Independent audits by security experts cost far more than we could ever pay, so nobody independent has reviewed Zuna's own code. The encryption library at its core, [OpenMLS](https://github.com/openmls/openmls), has been audited, but how Zuna uses it hasn't. Zuna doesn't compete with Signal or Matrix on security: if your safety depends on your messages staying private, choose a messenger that has been independently audited.

What we do instead is run periodic security audits with Claude Mythos 5.2 and fix what they find. They catch a lot, but they're no substitute for experienced people reviewing the code.

## Reporting a vulnerability

Please report it privately, with "Report a vulnerability" on the repository's Security tab, rather than in a public issue.

## What Zuna protects

Zuna is built so that a server you don't fully trust still can't read your messages.

- **What you write is encrypted on your device.** Messages, files, reactions, calls and group names can only be opened by the people in the conversation. Names, pictures and channel names can only be opened by the people invited to the server.
- **Nobody can write as you.** Every message is signed by the device that sent it, and your app checks every device in a chat, so a server can't slip in a fake one.
- **Comparing emoji proves who you're talking to.** If the 16 emoji you and someone else see match, nobody can pretend to be either of you.
- **It's built with quantum computers in mind.** Keys use post-quantum algorithms alongside the usual ones, so messages someone records today can't be opened by a quantum computer later.

## What the server can still see

Encryption hides what you say, not who you talk to. The server sees:

- who is in each conversation, and when messages are sent there and roughly how big they are
- your username, your devices, and when you're online
- your IP address, unless you use a proxy
- who is in a call or voice channel, and when

It isn't told who sent each message, but it can often work that out from addresses and timing. [The full list](docs/SECURITY_DETAILS.md#what-the-server-can-and-cant-see) goes through it item by item.

## What you can do

- **Use a long password you don't use anywhere else.** Whoever controls the server can try to guess it.
- **Keep your recovery key safe.** It opens your account just as your password does.
- **Compare emoji** with the people who matter to you.
- **To hide your IP address from servers,** set a SOCKS5 proxy in Settings, Privacy, in the desktop app or the iPhone app.
- **If your password or recovery key may have been stolen,** change them, and remove any device you don't recognize in Settings.
- **Paste invite links into the app** rather than opening them in a browser.

## Limits

- **Your password or recovery key opens your history.** Anyone who has either can read everything you can. That's the price of seeing your old messages on a new device.
- **Until you compare emoji, you're trusting the server a little.** In a first chat, a malicious server could hand you a fake key for someone. Zuna makes that hard to hide, but only comparing emoji proves it didn't happen.
- **Deleting is best effort.** "Delete for everyone" and disappearing messages remove a message from the server and from everyone's app, but a screenshot or a modified app can keep it.
- **Bots read the chats they're in,** and so can whoever runs them. A bot always shows a badge.
- **Plugins read what you let them.** A plugin you allow to read your messages can read them. Plugins Zuna hasn't checked sit behind a warning.
- **Channels are only as private as the server.** Everyone on it can join them, and one for admins only is kept from the others by the server alone.
- **Linked Telegram chats aren't end-to-end encrypted.** Telegram keeps them, as it does in its own apps. No Zuna server sees them. On an iPhone or iPad, Telegram's code runs inside the Zuna app, so a flaw in it could reach your Zuna keys and chats; on a computer it's boxed in apart from them.
- **A Telegram call is Telegram's, not Zuna's.** Its key is agreed by the two Telegram apps, and its four emoji are the only check, as in Telegram's own apps. It always goes through Telegram's relays, so the other person doesn't learn your address, and Telegram learns who called whom and when. What the other person's app sends in a call is read by the app itself, on the desktop and the iPhone alike, so a flaw in WebRTC could be reached by whoever you're in a call with. On an iPhone, Telegram rings a call through Apple's VoIP pushes, encrypted, so Apple doesn't learn who's calling.

[The full list of limits](docs/SECURITY_DETAILS.md#limits) also covers what a malicious server could try.

## The web app

The web app's code comes from its host every time you open it, so whoever controls the host could quietly send code that steals your keys. The installed apps don't have this problem and are the safer choice. Use the web app only if you host it yourself, or trust whoever does as you'd trust your own computer. Its host is never a chat server, so someone who breaks into a chat server can't change it.

## Installing

Install Zuna only from the [official releases](https://github.com/zuna-app/zuna/releases). On Windows the app updates itself, and only to releases signed with keys it already carries. The Windows installer isn't signed with a certificate yet, so Windows warns about it the first time. The macOS app is signed and notarized by Apple.

[How each protection works](docs/SECURITY_DETAILS.md) explains all of this in full technical detail.
