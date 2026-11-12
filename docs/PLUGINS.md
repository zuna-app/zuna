# Writing a plugin

A plugin is a package someone installs into Zuna's desktop app to change it: how it looks, what
its menus and settings hold, what happens to a message on its way out, or a screen of its own.
It's JavaScript, run in QuickJS in a process of its own, and everything it does goes through the
app's broker, which checks it against the permissions its manifest names and the person granted.
It runs on the device alone: no server knows of it. The web app and the iPhone app take none.

`docs/PLUGINS_PLAN.md` says why it's built this way, and "Plugins" in `SECURITY_DETAILS.md` what
keeps a plugin from what it shouldn't reach. Until Zuna's first stable release, the plugin API may
change with any nightly.

## Starting

The SDK is `packages/plugin-sdk`: the API's types, a JSX factory for views, and `zuna-plugin`.

```bash
node packages/plugin-sdk/cli/zuna-plugin.mjs init my-plugin
```

```bash
node packages/plugin-sdk/cli/zuna-plugin.mjs pack my-plugin
```

`init` makes a folder with `plugin.json`, `src/main.tsx` and `tsconfig.json`. `pack` bundles the
script with esbuild into `dist/main.js`, checks the package as the app would, and writes
`dist/<id>-<version>.zunaplugin`. `check <folder or file>` says what's wrong and what it asks for.

To run one as it's written: Settings → Plugins → Advanced, turn on "Allow plugins Zuna hasn't
checked", then "Load a folder…". The app loads it again whenever its files change, and its log
shows what it printed and what the broker refused. Its own section in Settings appears once it
has settings. A folder's plugin wears the "Unverified" mark, as a file's does, and may reach a
server on this machine, which nothing else may.

## The manifest

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
    "commands": [{ "id": "translate.last", "title": "Translate the last message", "keys": "ctrl-shift-t", "slash": "translate" }],
    "themes": []
  }
}
```

- **`id`** is 3 to 40 lower-case letters, digits and hyphens. On the marketplace the index decides
  who holds one; a plugin from a file is kept apart, so one borrowing a verified plugin's id
  installs beside it and never gets its data.
- **`api`** is 1, the plugin API this app runs. **`minBuild`** is the oldest build that runs it.
- **`permissions` and `hosts`** are everything the plugin can ever ask for. A version that needs
  more is a new version, which the person agrees to again.
- **`contributes`** is what the app knows without running anything: settings it draws itself
  (`switch`, `select`, `text`, `slider`), commands, each run by one keystroke if nothing else has
  it and as `/slash` in the message box, and themes. A plugin of themes alone has no `main`.
- A theme sets any of the app's color tokens, each `#rrggbb` or `#rrggbbaa`: `bg0` to `bg5`,
  `bgChat`, `line`, `lineStrong`, `hover`, `hoverStrong`, `text1` to `text3`, `accent`,
  `accentHover`, `onAccent`, `accentSoft`, `accentText`, `bubbleOwn`, `bubbleOwnText`,
  `bubbleOther`, `bubbleMeta`, `link`, `green`, `red`, `amber`. The person picks it in
  Appearance.

The package is a zip of `plugin.json`, `main.js`, `assets/` and, for a verified plugin,
`signature`, at most 8 MB, 200 files, and nothing else.

## Permissions

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
| `messages.decorate` | Changing how messages look here; needs `messages.read` | Changes how messages are shown to you |
| `activity.intercept` | Typing, read marks, and someone typing shown | Changes what others learn of your activity |
| `notifications` | Showing notifications, and with `messages.read` holding back or rewording the app's | Shows and hides notifications |
| `voice.read`, `voice.control` | Who's in voice; joining, leaving, muting | Sees who's in voice; joins and mutes for you |
| `clipboard.read`, `clipboard.write` | The clipboard | Reads, or writes, your clipboard |
| `network` and `hosts` | The named hosts | **Contacts** each host by name |

`messages.read` or `files.read` together with `network` is shown above the rest: "Can send your
messages to" and the hosts. Some things no plugin gets, whatever it asks for: keys, passwords,
sessions, devices, verification, the question a new device raises, sound and video themselves,
updates, the disk, and other plugins. The core's methods a plugin may call, and what each needs,
are in `packages/plugin-sdk/src/surface.ts`.

## The API

```tsx
import { definePlugin, h } from "@zuna/plugin";

export default definePlugin((zuna) => {
  zuna.commands.on("shrug", ({ composer, args }) => composer.insert(`${args} ¯\\_(ツ)_/¯`));

  zuna.messages.onOutgoing((draft) => draft.text.replaceAll("teh", "the"));

  zuna.ui.panel("stats", {
    title: "Stats",
    render: (state) => (
      <column gap="m">
        <heading>Messages today</heading>
        <text size="xl">{String(state.count ?? 0)}</text>
        <button onClick={() => zuna.storage.set("count", 0)}>Reset</button>
      </column>
    ),
  });
  zuna.ui.headerButton("stats", { icon: "sparkles", title: "Stats", onClick: () => zuna.ui.openPanel("stats") });
});
```

`zuna` (`packages/plugin-sdk/src/api.ts` has every type):

- **`settings`**: `get`, `all`, `set`, `onChange`, for what the manifest names.
- **`storage`**: `get` and `keys` at once, from what was loaded, and `set` and `delete`, kept
  sealed by the app, 4 MB in all. A view is drawn from storage, so changing it draws them again.
- **`commands.on(id, run)`**: what a command does, given `{ composer, conversation, args }`. The
  chat is there with `conversations.read`.
- **`ui`**: `toast`; `settings(render)`, a view in place of the manifest's settings; `panel`,
  `page` (an item in the rail with a page of its own), `dialog`; `openPanel`, `openPage`,
  `closePanel`, `closeDialog`; `headerButton`, `composerButton`, `messageAction` (with `hover`, an
  action under the pointer too), `conversationAction`; `remove`; `refresh`. A plugin opens what it
  draws, puts text in the message box, or uses the clipboard or a file dialog only for ten seconds
  after the person used one of its commands, buttons or views.
- **`messages`**: `on` (each message as it arrives), `decorate`, `onOutgoing`, `history`,
  `search`, `send`, `edit`, `delete`, `react`.
- **`activity`**: `onTyping` and `onRead`, which return `false` to keep it from going, and
  `onTypingShown`.
- **`notifications`**: `show`, and `onNotify`, which returns `false` or `{ title, body }`.
- **`core`**: `call(server, method, ...args)` and `on(type, listener)`, as the table allows.
- **`voice`**: `members`, `join`, `leave`, `setMuted`, `setDeafened`.
- **`net.fetch(url, init)`**: HTTPS to the manifest's hosts, answered with `status`, `headers`,
  `text()`, `json()` and `bytes()`.
- **`files`**: `open` and `save` through the app's dialogs, `attachment` with `files.read`, and
  `asset(path)` from the package.
- **`clipboard`**: `read`, `write`.

A filter answers nothing to let what it was asked about go as it was, a string or `{ text }` to
change it, or `false` to stop it. One that throws or takes longer than 1.5 seconds is left out,
and the app says so in a toast; registered with `{ required: true }`, it holds the message
instead, back in the message box. Three failures in a row turn a plugin off.

A decoration is any of `{ text, hidden, mark: { icon, label }, view }`, for this device alone:
the app says which plugin replaced or hid a message, with one click to the original.

## Views

A view is a tree the app draws with its own components. The nodes: `column`, `row`, `stack`,
`scroll`, `list`, `text`, `heading`, `markup`, `button`, `iconButton`, `switch`, `slider`,
`select`, `input`, `field`, `notice`, `image` (from `assets/`, or a `data:` URL of 1 MB at most),
`avatar`, `icon`, `divider`, `spacer`, `spinner` and `canvas`, which draws `rect`, `circle`,
`line` and `text` shapes. Colors are the theme's tokens (`text1`, `text2`, `text3`, `accent`,
`accentText`, `green`, `red`, `amber`, `bg1`, `bg2`, `bg3`) or `#rrggbb`. Icons are the Lucide ones
the app carries (`apps/desktop/assets/icons`). A tree is at most 2,000 nodes, 24 levels and
200,000 characters. Handlers are `onClick`, `onChange` and `onSubmit`.

## Verified plugins

A plugin on the marketplace is in `zuna-app/plugins`, offered as a pull request there, read by
Zuna's team against that repository's `REVIEW.md`, and built and signed by its CI from the source.
Its source is open, under any license the OSI approves. A plugin that uses only the plugin API
isn't bound by the app's AGPL, which is why the SDK, which a plugin bundles, is under the MIT
license; how to word that so it holds is still to be settled before an outside author's plugin is
verified.

## Examples

`examples/plugins`: `hello` (a command, settings, a panel, a page, a header button, a message
action, decorations), `dusk` (a theme alone), and `hostile`, which the app's tests run and expect
to fail at everything it tries.
