# Plugins for the native app: plan

A plugin is a package someone installs into the native app to change it: how it looks, what its menus and settings hold, what happens to a message on its way out, or a whole screen of its own. Plugins run on the device alone, and no server knows of them. This page is the design, what it assumes, and the order to build it in. It was drafted on 2026-11-12, and nothing of it is built.

```
  plugin.json + main.js + assets, signed            the marketplace: a signed index and
  (one package for Windows, Linux and macOS)        packages, on GitHub beside the releases
        │                                                        │
        ▼                                                        ▼
  the app checks it: signature, hashes, permissions ◀── Settings → Plugins: browse, install, update
        │
        ▼
  the plugin host: a process of its own, with QuickJS and nothing else.
  No keys, no database, no files, no network.
        │   JSON over a pipe
        ▼
  the broker, in the app (apps/desktop/src/plugins): checks every request against
  what the person granted, and is the only way to anything
        │                         │                          │
        ▼                         ▼                          ▼
  the core, through the      the interface: slots,       the network: only the hosts
  same RPC the UI uses       drawn by the app from       the manifest names, with nothing
  (never its keys)           trees the plugin sends      of the account
```

## Summary

- **A plugin is JavaScript,** run in QuickJS, the engine the client core already runs in (`rquickjs`), in a context that holds nothing but the plugin API. One package runs on Windows, Linux and macOS. No plugin brings native code.
- **Plugins run in a process of their own,** the app's own executable started as `--plugin-host`. A plugin that crashes, hangs or breaks out of QuickJS is in a process with no keys and no messages but those it was sent.
- **Everything goes through a broker in the app,** which checks each request against the permissions the manifest names and the person granted.
- **The reach is wide but drawn on purpose:** themes, settings tabs, commands, menus, buttons, panels, dialogs and whole pages; reading and sending messages; changing or stopping what the app sends; changing how messages look. Each is a named extension point, not a patch to the app's insides.
- **Some things no plugin gets, whatever it asks for:** keys, passwords, sessions, devices, verification, the question a new device raises, voice and video themselves, updates, and other plugins.
- **The marketplace is a signed index** in a repository of its own, `zuna-app/plugins`, with the source of every plugin in it. A plugin there was read by the team, built on CI from that source and signed with keys the app carries: that's what "verified" means.
- **Anything else is installed from a file,** behind a switch that's off, through a dialog that can't be mistaken for anything ordinary, and wears a mark wherever it shows.

## Decisions

What was asked for, on 2026-11-12:

- **The native app only.** The web app and the iPhone app get no plugins.
- **On the device only.** No plugin runs on a server, and no server takes part.
- **Plugins may change almost any part of the app:** its mechanisms, its settings, its interface.
- **A manifest, and a marketplace** the team puts verified plugins on.
- **Third-party plugins and one's own can be loaded,** behind a very obvious warning.

What this plan assumes, each to be confirmed before the stage that depends on it ("Questions" at the end):

- "Almost any part" means a wide set of extension points with permissions, not code that runs inside the core or patches the interface. "Alternatives considered" says why.
- "Upload third-party plugins" means loading one into the app from a file or a folder. Listing unreviewed plugins on the marketplace is left out of the first version.
- The marketplace is on GitHub, as releases are, so opening it tells nobody new that this address runs Zuna.
- A plugin is installed for the whole app, and sees every server the device is on.

## What a plugin can do to someone's privacy

End-to-end encryption protects messages from the server and the network. It can't protect them from code the person installs in the app that decrypts them. A plugin allowed to read messages reads them in the clear, and one that may also reach the internet can send them anywhere. That's true of any modified build of an open client too, so it changes nothing for the others in a chat, but it changes what "install" means for the person, and the design follows from it:

1. **A plugin starts with nothing.** It reads no message, name or server until a permission says so, and a permission is granted by the person, at install, in plain words.
2. **What matters most is out of reach altogether.** The list is under "Never".
3. **Reading and reaching the internet together is the dangerous pair.** The app names it as that, in every dialog, and a verified plugin that asks for both gets the closest review.
4. **Who wrote a message can't be changed.** A plugin can change how a message looks on this device, never who it's shown as from, whether they're verified, or what's stored.
5. **Nothing a plugin draws can pass for the app's own questions.** What it draws sits inside a frame the app draws, with the plugin's name.
6. **A plugin must never be able to keep the app from starting or updating.**

## The package

A plugin is one file, `<id>-<version>.zunaplugin`: a zip with a fixed layout.

```
plugin.json        the manifest
main.js            one bundled script, ES2022, as the core bundle is built for
assets/            icons, images, sounds, theme files
signature          a verified plugin's signature, absent otherwise
```

The app refuses a package over 8 MB, with a path outside this layout, with a name that climbs out of its folder, or whose manifest doesn't parse exactly. Unpacking is a new dependency (`zip`), and reads only what the layout names.

### The manifest

```json
{
  "manifest": 1,
  "id": "translate",
  "name": "Translate",
  "version": "1.2.0",
  "description": "Shows a translation under a message.",
  "author": { "name": "Someone", "url": "https://example.com" },
  "license": "MIT",
  "source": "https://github.com/zuna-app/plugins/tree/main/plugins/translate",
  "icon": "assets/icon.svg",
  "main": "main.js",
  "api": 1,
  "minBuild": 1300,
  "permissions": ["messages.read", "messages.decorate", "network"],
  "hosts": ["api.example.com"],
  "contributes": {
    "settings": [{ "key": "language", "type": "select", "label": "Translate into", "choices": ["en", "pl", "de"], "default": "en" }],
    "commands": [{ "id": "translate.last", "title": "Translate the last message", "keys": "ctrl-shift-t" }],
    "themes": []
  }
}
```

- **`id`** is lower-case letters, digits and hyphens, 3 to 40 of them. On the marketplace the index decides who holds an id. A plugin from a file is kept apart from the verified ones, so one that borrows a verified plugin's id installs beside it, never over it, and never gets its data.
- **`api`** is the plugin API's version, a whole number. An app runs only plugins made for its own. Until the first stable release it may change with any nightly, as everything else may.
- **`minBuild`** is the app's build number, as updates compare them.
- **`permissions` and `hosts`** are everything the plugin can ever ask the broker for. Nothing is requested later while it runs: a version that needs more is a new version, which the person agrees to again.
- **`contributes`** is what the app can know without running anything: settings the app draws itself, commands and their keys, themes. A theme is a plugin with nothing else, and no script.

## Where plugins run

**QuickJS, in a context of the plugin's own.** `apps/desktop/src/host/runtime.rs` already runs the core this way. A plugin's context gets timers, `console`, text encoding and the API object, and none of what the core's has: no `__zunaHost`, `__zunaCrypto` or `__zunaDb`. Each plugin has a runtime to itself with a memory limit (`set_memory_limit`, 64 MB to start), a stack limit, and an interrupt handler (`set_interrupt_handler`) that ends a script which runs too long without yielding.

**In a process apart.** The app starts itself again as `zuna --plugin-host` once the window is up and the core has booted, so plugins never slow the start. That process loads no account, opens no database and never holds the device key. It talks to the app in length-prefixed JSON over its standard input and output, one thread and one runtime for each plugin. It needs nothing of the system: no files, no network, no child processes, as the broker does those for it. So the system can hold it to that later: a job object and a restricted token on Windows, seccomp and Landlock on Linux, a sandbox profile on macOS. Using the app's own executable means nothing new to install, sign or notarize.

QuickJS is C, and plugins bring it code written to break it, which the core never did. The separate process is what makes a break in the engine less than a break of the account: it lands where there are no keys.

**The broker** (`apps/desktop/src/plugins/broker.rs`) is the other end of the pipe, in the app. Every message from a plugin is a request it checks: is this plugin running, does its grant cover this, are the arguments the shape and size they should be. It trusts nothing the host process says about which plugin is asking beyond the channel it arrived on. What comes back from a plugin is untrusted, as what arrives decrypted is, and is checked before anything shows it.

**Deadlines.** The app never waits on a plugin without one. A filter (below) that doesn't answer in time, or throws, is skipped: the app goes on as if the plugin weren't there and says so in a toast that names it, and three in a row turn the plugin off. Drawing never waits at all: what a plugin adds to a message appears when it arrives.

## What a plugin can reach

### The core

The interface reaches the core through one door: `Core::call(server, method, args)` in `apps/desktop/src/host/mod.rs`, which carries the RPC of `packages/core/src/rpc.ts`, and `CoreEvent`s come back the other way. The broker stands at the same door, so the first versions need no change to `packages/core` at all:

- **Calls.** A plugin calls a method of `ZunaClient` or `ServerSession` through the broker, which looks it up in a table that names, for every method `rpc.ts` allows, the permission it needs or `never`. The table is TypeScript, in the SDK (`packages/plugin-sdk/src/surface.ts`), typed as `rpc.ts`'s own lists are, so a method added to the core doesn't type-check until someone has classified it. The app's build turns it into JSON the broker reads.
- **Events.** The broker hands on each `CoreEvent` to the plugins whose permissions cover its kind: `message` needs `messages.read`, `presence` needs `users.read`, and so on.
- **Filters on what the app sends.** With `messages.intercept`, a plugin is asked before `sendMessage`, `sendWithAttachments` and `editMessage` reach the core, and may change the text or stop the send. With `activity.intercept`, the same for `sendTyping`, `markRead` and `markChatRead`, which is how "don't show that I'm typing" is a plugin. What a filter returns goes through the same checks as what the person typed.
- **Filters on what the app shows of events.** A plugin may hold back or reword a notification (`notify`), and hide `typing`. It can't rewrite a `message` event: see "How messages look".

Later, and only where a need shows that the door can't meet, the core gets hooks of its own (`packages/core/src/hooks.ts`): named points a host can listen at, which do nothing on the web, on iOS and in `zuna-bot`. None may run inside `withLock` or MLS work, as a plugin that's slow there would hold up `commitWithRetry` for everyone in the group, and none sees a key.

### How messages look

A plugin with `messages.decorate` gives the app, for a message, any of: text to show in place of its text, a view to draw under it, a small mark beside it, or that it's hidden. The message as stored, as signed and as searched stays as it was. Where the text was replaced or the message hidden, the app says which plugin did it, in a line the plugin doesn't draw, and one click shows the original. The sender's name, picture, badge and verification are the app's own and outside any decoration, so that who wrote something still comes only from the signature inside it.

### The interface

GPUI is compiled into the app, so a plugin can't hand it elements. It gets two things instead.

**Slots:** places the app offers, each drawn by the app.

| Slot | Where it's drawn | What the plugin gives |
|---|---|---|
| A section in Settings | `ui/settings/mod.rs` (`SECTIONS`), under a "Plugins" heading | A schema in the manifest, or a view |
| Message menu entry | `ui/menu.rs` (`MenuEntry`), `ui/message` | Label, icon, handler |
| Message hover action | `ui/message/actions.rs` | Icon, handler |
| Under a message | `ui/message/mod.rs` | A view (a decoration) |
| Composer button | `ui/chat/composer.rs` | Icon, and a handler or a popover's view |
| Composer suggestions | The list `composer.rs` draws over the message box | A trigger and the items for what's typed |
| Slash command | The composer | Name, arguments, handler |
| Chat header button | `ui/chat/header.rs` | Icon, handler |
| Side panel | `state::Panel`, `ui/side_panel` | A view |
| Dialog | `state::Overlay`, `ui/overlays` | A view, in a frame the app draws |
| Rail item with a page of its own | `ui/rail.rs`, `ui/main_area.rs` | Icon and a view that fills the main area |
| Conversation list menu | `ui/conversations` | Entries |
| A person's or group's details | `ui/side_panel` | A view |
| Voice stage tile menu | `ui/voice_stage` | Entries |
| Toast | `state::Toast` | Text |
| Command and its keys | `ui/mod.rs` (`bind_keys`) | A command, bound only if the keys are free |
| Theme | `theme.rs` (`Theme`) | Values for its tokens |

**Views:** a tree the plugin sends and the app draws with its own components (`ui/components`), so a plugin's screen looks like Zuna and follows the theme. The nodes are rows, columns and stacks, text, headings, buttons, icon buttons, switches, sliders, select boxes, text inputs, fields, notices, images, avatars, icons, dividers, spinners, lists that only draw what's in view, Zuna's own markup, and later a canvas that takes a list of shapes to draw freely. A node's handlers are numbers the app calls back with. The plugin keeps its own state and sends a new tree when it changes, and the app compares by key and redraws. A tree has a size limit, colors are the theme's tokens or the plugin's own inside its own view, and images come from the package, from a permitted host, or from the core by a handle.

The SDK gives this a small JSX factory, so a view reads like a component without React:

```tsx
import { definePlugin, h } from "@zuna/plugin";

export default definePlugin((zuna) => {
  zuna.commands.on("shrug", ({ composer }) => composer.insert("¯\\_(ツ)_/¯"));

  zuna.messages.onOutgoing(async (draft) => ({ ...draft, text: draft.text.replaceAll("teh", "the") }));

  zuna.ui.panel("stats", {
    title: "Stats",
    render: (state) => (
      <column gap="m">
        <heading>Messages today</heading>
        <text size="xl">{state.count}</text>
        <button onClick={() => zuna.storage.set("count", 0)}>Reset</button>
      </column>
    ),
  });
});
```

**What keeps a plugin's drawing honest.** A view only fills its slot. A dialog's frame, with the plugin's name, icon and its mark if it isn't verified, is the app's. No plugin view shows while one of the app's own security questions is up: a new device, the install dialogs, verification. No slot exists inside onboarding, sign-in, the Security section or verification. This narrows what a plugin can imitate, and doesn't end it: a plugin can still draw a box that asks for a password inside its own frame, which is one reason unverified ones are behind a warning.

### Settings, storage, files and the network

- **Settings.** What `contributes.settings` lists is drawn by the app as a section of its own in Settings, kept for the plugin, and read with `zuna.settings`. A plugin whose settings need more gives a view instead.
- **Storage.** Each plugin has a key-value store of its own, in a database of the plugins' (`plugins.db` in the data folder), with a quota. A plugin that reads messages will keep some, so values are sealed with a key made from the device key and the plugin's id, as the app's own sensitive data is. Removing a plugin removes its data.
- **Files.** No plugin sees the disk. It can ask the app to show its own file dialog, and gets the one file the person picked, or saves the one it was asked to. Its package's assets are read-only.
- **The network.** With `network`, a plugin's `fetch` reaches only the hosts its manifest names, over HTTPS, through the app's own TLS rules, with no cookie and nothing of the account. The broker makes the request, not the plugin's process. Private addresses and this machine are refused as link previews refuse them (`host/web.rs`), except for a plugin loaded from a folder by its developer.

### Permissions

| Permission | What it allows | What the person is told |
|---|---|---|
| (none) | Its own settings, storage, themes, commands, toasts, and views that show nothing of the account | Nothing to agree to |
| `servers.read` | The servers this device is on and the person's own profile | Sees which servers you're on |
| `conversations.read` | Chats, channels and groups: names, members, unread counts | Sees your chats and who's in them |
| `users.read` | People and whether they're online | Sees the people on your servers |
| `messages.read` | Messages as they arrive, history, search | **Reads your messages** |
| `files.read` | The bytes of attachments | Reads files and photos sent to you |
| `messages.send` | Sending, editing, deleting and reacting as the person | **Writes and deletes messages as you** |
| `messages.intercept` | Changing or stopping what the person sends | Changes what you send before it's encrypted |
| `messages.decorate` | Changing how messages look here | Changes how messages are shown to you |
| `activity.intercept` | Typing, read marks | Changes what others learn of your activity |
| `notifications` | Showing notifications, holding back the app's | Shows and hides notifications |
| `voice.read`, `voice.control` | Who's in voice; joining, leaving, muting | Sees who's in voice; joins and mutes for you |
| `clipboard.read`, `clipboard.write` | The clipboard | Reads, or writes, your clipboard |
| `network` and `hosts` | The named hosts | **Contacts** each host by name: it learns your address and whatever the plugin sends |

`messages.read` or `files.read` together with `network` is shown as one line above the rest: "Can send your messages to" and the hosts.

### Never

No permission reaches these, and no table entry may:

- Keys of any kind: the device key, identity and signing keys, MLS state, epoch, send, item and voice keys (`voiceKey`), the vault, sessions and tokens, LiveKit access (`voiceAccess`, `voiceScreenAccess`).
- Passwords and recovery keys, and the account's life: `login`, `register`, `recover`, `changePassword`, `regenerateRecoveryKey`, `rotate`, `deleteAccount`, `signOut`, `leaveServer`.
- Devices and trust: `revokeDevice`, `answerNewDevice`, `prepareNewDevice`, `markVerified`, `clearVerification`, the log of keys.
- Bots' setup and a server's administration, in the first version.
- Sound, video and screens themselves: a plugin can know who's talking, never hear it.
- The database, the cache folder, the disk, other programs.
- Updates, the plugin manager, another plugin's data, the install dialogs.

## Trust: verified plugins

**A verified plugin's source is in `zuna-app/plugins`.** Someone outside the team offers theirs as a pull request there. The team reads it, and CI builds the package from that source with a lockfile, so what's signed is what was read, and nothing arrives as a built file. The review's rules are written in that repository: no script fetched and run at runtime, no host the plugin doesn't need, permissions no wider than what it does, and every third party it contacts named in its description.

**It's signed with a key of the plugins' own,** hybrid, Ed25519 and ML-DSA-65 from one seed, as every signature an app checks is (`crypto/src/hybrid.rs`, a lasting key). The app carries the public key and a spare whose private half was never on GitHub (`PLUGIN_KEYS` in `apps/desktop/src/plugins/trust.rs`), as it carries its updates' keys. The private key is a secret of an environment in the plugins' repository that only its publishing job reads, with a copy kept offline. What's signed starts with a label of its own, so no signature made for an update or anything else can pass for a plugin's. These keys sign nothing else, and the update keys never sign a plugin: a leak of one doesn't become the other.

**The package's `signature`** covers the manifest's bytes and the hash of every file. A package that carries a good one is verified wherever the file came from, so a verified plugin can be installed offline.

**The index** is what the marketplace is: `index.json` and `index.json.sig`, published as a release of that repository with the packages beside it.

```json
{
  "serial": 42,
  "made": "2026-12-01T12:00:00Z",
  "plugins": [{
    "id": "translate", "name": "Translate", "summary": "…", "author": "…", "source": "…", "icon": "…",
    "versions": [{ "version": "1.2.0", "api": 1, "minBuild": 1300, "file": "translate-1.2.0.zunaplugin",
                   "size": 48211, "sha256": "…", "permissions": ["…"], "hosts": ["…"] }]
  }],
  "revoked": [{ "id": "…", "versions": "*", "reason": "…" }, { "sha256": "…", "reason": "…" }]
}
```

The app checks, in order, as it does for an update: the signature, before anything in the index is read; that `serial` isn't lower than the highest it has seen, so an old index can't bring back a withdrawn plugin; then for a package, its size and SHA-256, its own signature, and that the manifest inside says what the index said of it: id, version, permissions, hosts. GitHub and the connection are trusted for nothing but being there. What that leaves: someone who controls the connection can keep showing the last index the app saw, which hides a new revocation for as long as they can.

**Revoking.** A plugin or version in `revoked` is turned off on every device that has it the next time the index is read, with the reason shown. The list can also name a package by hash, which is how a plugin that was never on the marketplace is stopped once it's known to be harmful.

**When the app contacts the marketplace.** When the person opens the plugins' page, and beside the app's own check for updates when a verified plugin is installed, at the same host. A device with no plugins never asks.

**Updates.** A verified plugin updates itself when the new version asks for nothing more. One that adds a permission or a host waits for the person, showing what's new. The index says which version fits which build, so a plugin made for an older API isn't offered to a newer app, and an app update that changes the API turns off what doesn't fit and updates what does.

## Trust: everything else

A plugin that isn't verified comes from a file, or from a folder for whoever is writing it.

- **A switch first.** Settings → Plugins → "Allow plugins Zuna hasn't checked", off until the person turns it on, which explains once what it opens up.
- **Only from Settings.** "Install from a file…" there, or a file dropped on that page. No link installs a plugin, no `zuna://` address, and a `.zunaplugin` someone sent in a chat is a file like any other: nothing in the chat offers to install it.
- **The dialog.** It covers the whole window, in the danger colors, over everything, as the question about a new device does, and nothing a plugin draws is on screen while it's up.

  > **Zuna hasn't checked this plugin**
  >
  > Nobody on Zuna's team has read its code. It calls itself "Name", by "Author", which nothing confirms. Once installed it can:
  >
  > - **Read your messages and send them to** api.example.com
  > - Write and delete messages as you
  > - …
  >
  > If someone told you to install this to fix a problem, to win something, or to see something hidden, it's a scam.
  >
  > ☐ I understand, and I trust where this came from
  >
  > **Cancel** · Install anyway

  Cancel holds the focus, and Enter and Escape both cancel. "Install anyway" stays off until the box is ticked and five seconds have passed. The permissions are listed worst first, in the same words as everywhere else.
- **A mark that stays.** An unverified plugin has an "Unverified" mark in the danger color beside its name everywhere: in the list, on its settings section, on the frame of every dialog and panel it draws, and beside what it adds to a message. Settings → Plugins lists them apart, first.
- **A new version is the same dialog again,** with what changed since the installed one.
- **A folder, for developers.** "Load a folder…" runs a plugin as it's being written and reloads it when its files change, with a log of what it printed and what the broker refused. It gets the same dialog once for each folder and the same mark.

No plugin can install, turn on, update or remove a plugin, or answer any of these dialogs.

## Keeping the app safe from its plugins

- **What's installed is sealed.** `plugins/installed.json` holds each plugin's id, version, hash, where it came from, what it was granted and whether it's on, sealed with the device key as what decides whom to trust is. A package is hashed again each time it's loaded, so one swapped on disk doesn't run.
- **Safe mode.** `zuna --no-plugins` starts without them. So does the app by itself when it failed to finish starting twice in a row with plugins on, and it says so.
- **Updates don't pass through plugins.** Nothing in `platform/updates.rs` has a slot, a filter or an event, so an installed build can always update, whatever is installed in it.
- **Misbehaving is turned off, not endured.** Over its memory, over its deadlines three times, or crashing its runtime: off, with a toast and a line in Settings saying why.
- **Turning a plugin off takes effect at once,** with no restart: its runtime ends and its slots empty.

## The Plugins page

Settings gets a "Plugins" section: what's installed, each with its switch, its permissions in words, its version and where it came from; "Browse", which reads the index and lists the marketplace with search; a plugin's page with its description, permissions, hosts, source link and versions; and under "Advanced", the switch for unverified plugins, "Install from a file…" and "Load a folder…". Each plugin's own settings are a section under the "Plugins" heading in the same list.

## How the code is split

| Piece | Where |
|---|---|
| Manifest, package, unpacking, limits | `apps/desktop/src/plugins/{manifest,package}.rs` |
| Keys, signatures, the index, revoking | `apps/desktop/src/plugins/trust.rs`, `market.rs` |
| What's installed and granted | `apps/desktop/src/plugins/store.rs` |
| The broker, with one file for each area of the API | `apps/desktop/src/plugins/broker.rs`, `api/` |
| The host process: runtimes, limits, the pipe | `apps/desktop/src/plugins/host/` (started by `--plugin-host` in `main.rs`) |
| Slots and drawing views | `apps/desktop/src/ui/plugins/`, and each slot's own file |
| The Plugins page and the dialogs | `apps/desktop/src/ui/settings/plugins.rs`, `ui/overlays/plugin_install.rs` |
| The SDK: types, the JSX factory, the table of methods, and `zuna-plugin` (`init`, `build`, `pack`, `check`) | `packages/plugin-sdk` |
| Example plugins, which the checks install | `examples/plugins/` |
| Verified plugins, the index and its signing | The `zuna-app/plugins` repository |

## Phases

Each ends with something that runs and is checked.

0. **Decisions and two trials.** The questions below answered. A second QuickJS in a child process with its limits, measured: start time, memory, the cost of a call across the pipe. One view tree drawn in GPUI as a settings section.
1. **The frame.** Manifest, package, loading from a folder behind a build feature, the host process and broker, storage, settings from a schema, themes, commands, toasts, the Plugins page with what's installed, safe mode. No plugin sees anything of an account yet.
2. **Reading and acting.** Permissions, the table of methods, events, the message, composer and header slots, decorations, notifications. Installing from a file with the switch, the dialog and the mark. The security docs.
3. **Filters.** Changing and stopping what's sent, typing and read marks, notifications, with deadlines.
4. **Screens of its own.** Panels, dialogs, rail pages, the rest of the nodes, the canvas, the network.
5. **The marketplace.** The plugins' repository, its CI and keys, the index, Browse, updates, revoking, and the review's rules. The first verified plugins, written by the team, which is how the API is tried on something real.
6. **Later.** Hooks inside the core, the system's own sandbox around the host process, WebSockets, fonts in themes, an author's own signing key so an update to an unverified plugin must come from the same author.

## Checks

- **Unit tests in the app:** the manifest's parsing and every refusal; packages with paths that climb, too large, with a hash or a signature that's wrong; the index's order of checks, an older `serial`, a revoked plugin; every method of the table refused without its permission, and every `never` refused with all of them.
- **A hostile plugin,** in `examples/plugins/hostile`, which the tests expect to fail at each of: a loop that never ends, memory without end, a tree too large, a host it didn't name, this machine's address, a global that shouldn't be there, a method on the Never list, a view while a security question is up.
- **The interface, on GPUI's test platform** (`Core::fake`): each slot, a view drawn and clicked, the dialog (Enter doesn't install, nothing installs before the box and the five seconds), the mark on everything an unverified plugin draws.
- **A marketplace check,** as `windows-update-check.mjs` is for updates: an index and packages served from this machine, signed with keys made for the run, in a build made with a `plugin-check` feature; a plugin found, installed, updated and revoked, then everything an index must pass refused when it doesn't.
- **On each system,** an example plugin installed and used in the real app: by window messages on Windows, in `linux-check.mjs`, and through the test control on macOS.
- **The type check** covers the SDK and the examples, and fails when the core has a method the table doesn't classify.

## What changes with it

- `SECURITY.md` gets a "Plugins" section in plain words and a line under "Limits": a plugin someone installs can read what they can read. `docs/SECURITY_DETAILS.md` gets the details under "The desktop app": the process, the broker, the Never list, the keys and the index.
- `docs/RELEASES.md` and the offline copies gain the plugins' keys. "What has to change together" in `CLAUDE.md` gains rows: a core method and the table; `types.ts` and what plugins are sent; a plugin signing key and `PLUGIN_KEYS`; a slot and the SDK's types.
- A new `docs/PLUGINS.md` for people writing plugins, as `docs/BOTS.md` is for bots, once phase 2 is in.
- `scripts/release.mjs`: `packages/plugin-sdk` in `APP_PATHS`, as the app is built from its table, and its `package.json` in `versionFiles`. `npm run typecheck` gains the SDK and the examples.
- `.agents/FEATURE_PARITY.md`: plugins under "One platform, by design" and in "The native desktop app". On iOS they're under "Not possible or pointless there", as the App Store allows no downloaded code that changes what an app does.
- The installer and the packages need nothing new, as the host is the app's own executable.
- `apps/site`: a page for plugins once there's a marketplace, and the privacy page says when the app contacts it.
- "Decisions to keep" in `CLAUDE.md` gains what's decided here.

## Risks

- **People talked into installing something.** It's how Discord's users lose accounts to modified clients. The switch, the dialog, no installing from a link or a chat, the mark, and revoking by hash are all for this, and none of them stops someone determined to click through.
- **The team becomes a target.** The plugins' key signs code for everyone who installed that plugin. It's kept as the update keys are, apart from them, and a plugin can do less than an update can.
- **Review is work that doesn't end.** Every verified plugin and every update to one is read by someone. The marketplace should start small, with the team's own.
- **QuickJS.** A break in the engine is contained by the process, not prevented. `rquickjs` has to be kept current, and the system's sandbox in phase 6 is the real second wall.
- **The API as a promise.** Each slot and method is something a refactor can no longer move freely. Until 1.0.0 it may break with any nightly, and verified plugins are fixed in step, in their own repository. After 1.0.0 the API's version is what protects plugins from the app and the app from having to stand still.
- **Speed.** Filters sit on sending, and decorations on every message drawn. Deadlines, caching by message and edit, and asking in batches bound it, and phase 0 measures it.
- **What people expect of "almost any part".** Some popular plugins elsewhere work by patching the client's insides. Those that need a slot or a filter that doesn't exist will wait for one to be added, which is slower than patching, and is the price of the rest of this page.

## Alternatives considered

- **Plugins inside the core's own context,** patching it as Vencord patches Discord. It reaches everything, which is the problem: such a plugin holds every key the core holds, no permission can be told apart from any other, and each refactor of the core breaks them.
- **Native libraries.** They could draw real GPUI elements. Rust has no stable ABI, each would be built for three systems, nothing could confine them, and one crash is the app's.
- **WebAssembly,** as Zed's extensions are. As good a wall as a process, in any language, at the cost of a large runtime in the app and a toolchain for every author, with the interface still drawn from trees. It can come later as a second kind of plugin behind the same broker.
- **A web view for a plugin's interface.** Three engines to behave alike, drawn over GPUI rather than in it, impossible inside the window under Wayland, as watching together found, and it wouldn't look like Zuna.
- **Plugins on a thread of the app's process.** Simpler and a little faster. A break in QuickJS would then be next to the device key and every open group's state.

## Left out of the first version

- Plugins on the server, on the web, on the iPhone.
- Unreviewed plugins listed on the marketplace.
- Choosing which servers a plugin sees.
- Sound, video and screen frames, and effects on them.
- A plugin's settings or data following the person to another device.
- Plugins that depend on other plugins.
- Paid plugins.

## Questions

For the owner, each with what this plan assumes:

1. **Does "upload third-party plugins" also mean a place on the marketplace for plugins nobody reviewed?** Assumed: no, files and folders only. A second, marked list could come later, and would need its own answer to who may publish there and how one is taken down.
2. **Is there to be a kind of plugin with no limits at all,** for those who accept the warning? Assumed: no. Every plugin runs behind the broker, and "almost any part" grows by adding slots and filters.
3. **May a verified plugin contact a third party,** such as a translation or a GIF service? Zuna itself has no GIF search because such a service learns each person's address and what they look for. Assumed: yes, as the person chose it, with every host named on its page and in its install dialog, and never in a plugin that comes with the app.
4. **Does any plugin come with the app,** installed from the start? Assumed: no.
5. **Where does the marketplace live:** a `zuna-app/plugins` repository and its releases, or zuna.chat? Assumed: GitHub, where the app already goes for updates.
6. **Must a plugin's source be open, and under which licenses,** to be verified? The app is AGPL-3.0, and whether a plugin written against its API must be too is worth deciding and writing down before the first outside author asks. Assumed: open source is required for review, and the license question is the owner's.
7. **Who may sign.** Updates take one maintainer. Assumed: the same for plugins, with the same caveat as in `docs/RELEASES.md`.
8. **A filter that fails:** send the message unchanged, as assumed here, or hold it and ask? A plugin whose whole point is to change what's sent would rather hold.
