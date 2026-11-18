# Telegram in Zuna

The desktop app on Windows, Linux and macOS, and the iPhone and iPad app, can link your own Telegram account, with its people and groups under an icon of their own beside your servers. Zuna signs in as another of your devices, using Telegram's API. Zuna isn't made by Telegram, and no Zuna server hears that an account is linked. The web app never will: a page can't keep Telegram's code apart from the rest of it. The iPhone's TestFlight builds don't have it yet. [TELEGRAM_PLAN.md](TELEGRAM_PLAN.md) has the design.

## Before you link one

- **These chats aren't end-to-end encrypted.** Telegram keeps them on its servers, as it does for its own apps. Each chat says "Telegram" in its header and that it isn't encrypted, so it's never taken for one of Zuna's.
- **Telegram learns** that you use Zuna, this device's address, or your proxy's if you set one, whether it runs Windows, Linux, macOS or iOS, and when you're online. Not the device's model or the system's version.
- **Telegram watches accounts that use other apps,** and sometimes limits one by mistake. Link an account you've had for a while.
- **Channels, video chats in groups and secret chats stay in Telegram's own app.** Zuna doesn't list them. Calls with one person are in Zuna.

## Linking

From the plus at the foot of the rail, Connect Telegram, or Settings, Connections. On an iPhone or iPad, the plus in the list of servers, or Settings, Connections; once it's linked, a phone has a Telegram tab in the bar at the bottom.

1. **Scan the QR code** with Telegram on your phone: Settings, Devices, Link Desktop Device. No phone number or code is typed into Zuna. On an iPhone or iPad, which can't scan its own screen, a phone number comes first, and the QR code is the other way, with Confirm in Telegram, which asks Telegram on the same phone instead.
2. **Or use a phone number.** The code arrives in Telegram on another of your devices, or by email, and an account with two-step verification asks for its password.

Zuna makes no account: a number Telegram doesn't know is sent to sign up in Telegram's app first. Telegram shows "New login" on your other devices and lists Zuna under Devices, where you can end it.

## What's there

- **People and groups,** with Telegram's pins, mutes, unread marks and its archive, which is the app's hidden chats: what you hide in Zuna is archived in Telegram, and back.
- **Messages:** text with formatting, replies, edits, reactions, pins, deleting, read marks, typing, forwarding between Telegram's chats, a bot's buttons, and notifications when Telegram's own apps would give one, while the app is open. On an iPhone they come with Zuna closed too, from Telegram through Apple, with names and text Apple can read, as Telegram doesn't encrypt them for apps like Zuna; with Telegram's own app on the same phone, each comes twice, until one is turned off in iOS Settings.
- **Pictures, videos, GIFs, files, audio, voice and video messages,** both ways, and albums of up to ten pictures and videos. The Privacy switch that removes metadata from files does so on Telegram too.
- **Stickers:** still ones show as they are, and animated ones as their still picture or their emoji. The picker's Stickers tab has your own sets.
- **Drafts** are kept on Telegram, so what you start writing in Zuna is there on your phone, and back.
- **Groups:** making one, adding and removing people, its name and picture, a link to invite people, joining by one, and leaving.
- **Calls with one person,** by voice and with the camera, both ways, from the phone and camera buttons in a chat's header in the desktop app, or in a chat's details on the iPhone and iPad, ringing as Zuna's own calls do with "(Telegram)" after the name. On the iPhone a call rings with Zuna closed too, as a phone call, through Telegram's own pushes for calls, which Apple can't read, and called "Telegram" until Zuna has caught up and knows who it is. With Telegram's own app on the same phone, both ring, and whichever answers, the other stops. On Windows and Linux you can share a screen or a window into one, in place of your camera, as Telegram's own apps share one, and the computer's sound with it, which goes mixed into your voice, at a call's sound quality. Each chat shows Telegram's line for a call: which way, by voice or video, how long, or missed, declined or cancelled.
  - **The four emoji** on the call's screen are Telegram's check of the call's key, as in its own apps: if the other person sees the same four, nobody in between can listen. Telegram's apps agreed that key between them, and nothing of Zuna's encryption stands behind it.
  - **Always through Telegram's relays,** never device to device, whatever your account's own setting for that is, so the other person never learns this device's address. Telegram learns it, or your proxy's, as it does in its own apps. With a proxy set, the call goes through it, which has to carry UDP: one that doesn't gets no Telegram call.
  - **"Take Telegram calls on this device"** in Settings, Connections, is Telegram's own Accept calls for this device, which its apps show under Devices. Off, no Telegram call rings here, and you can still call from here. Turn it off on a phone where you'd rather Telegram's own app took them.
  - When Telegram asks, a card asks how the call was: stars, and under five which of Telegram's problems it had. Nothing else goes with it, and no log of the call is ever sent.

## What isn't

- Channels, video chats in groups and secret chats, which stay in Telegram's app. A call the other person moves into a group call ends here, saying to open it in Telegram. Sharing your screen into a call isn't there on macOS, the iPhone and the iPad, though the other person's shared screen shows.
- Nothing passes between Telegram and Zuna's own chats: nothing is forwarded either way, and no plugin reaches anything of Telegram's.
- Changing your account: its name, password, sessions, contacts and payments are Telegram's app's.

## What the iPhone and iPad leave out

The App Store's rules don't let an app show what Telegram restricts on iOS. Telegram's code says which, and on an iPhone or iPad Zuna withholds it, with no way to lift it:

- **Chats** with a person, a bot or a group Telegram restricts: they aren't in the list, and can't be opened or joined from Zuna.
- **Messages** Telegram restricts, and any from, forwarded from or sent by way of someone or a group it restricts: each says "This message can't be shown on this device", with none of its text, pictures, files or link, and isn't found by searching, passed on or notified about. Their pictures and files are never downloaded.
- **Calls** from someone Telegram restricts don't ring in Zuna.
- **18+ media** Telegram marks as sensitive is withheld the same way, unless your account allows it: it shows on the iPhone only once you've turned it on in Telegram on another device, as Telegram's own iPhone app has it. Zuna has no switch for it, and what's restricted on iOS for other reasons stays withheld.
- **Notifications with Zuna closed** are worded from Telegram's push alone, so one from a restricted chat may still name it and show its words. That hasn't been seen yet.

The desktop app isn't in any app store, and shows everything Telegram gives it.

## Unlinking

The menu under Telegram's name at the top of its list, or Settings, Connections, Unlink. Zuna signs out, which ends its session at Telegram, then erases everything it kept of the account on this computer. Ending Zuna's session from another device, under Devices, does the same here.

## How it's kept apart

Telegram's own code, TDLib, runs in a program of its own, `zuna-telegram`, which the system keeps in a box, an AppContainer on Windows, on Linux a network of its own with Landlock and seccomp, and on macOS the system's sandbox with a profile of Zuna's: it can't reach your files, other programs or the network, only the app, through one pipe. On an iPhone or iPad there's no box: Telegram's code runs inside the Zuna app, as iOS gives a program of its own too little memory to run it. So a flaw in it could reach your Zuna keys and chats, and nothing but its own settings keeps it to Telegram's addresses and your proxy. That was chosen knowingly, and a device that never links Telegram never runs its code. The app passes on only the requests Zuna makes, at a limited rate, and opens connections for it only to Telegram's own addresses, through your proxy if you set one. Its database is encrypted with a key sealed with this device's key, so a copy of the disk holds no session. [SECURITY.md](../SECURITY.md) says what that covers, and [SECURITY_DETAILS.md](SECURITY_DETAILS.md) how.
