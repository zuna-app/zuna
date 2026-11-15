# Languages

Every word Zuna shows comes from a catalog, one per language, in `packages/i18n/locales`. The native desktop app, the web app, the iPhone app and the core read the same files, so a language added there reaches them all. English is the only one so far.

```
packages/i18n/locales/en.json     English: every key, and the words every other language translates
packages/i18n/locales/pl.json     another language, by its BCP 47 tag: the same keys, its own words
        │
        ├─ the native app      built into the program (build.rs), looked up by src/i18n.rs
        ├─ the web app         English in the bundle, another language loaded when it's chosen (lib/i18n.ts)
        ├─ the iPhone app      copied into ZunaModels by the core bundle's build, read by I18n.swift
        └─ the core            given the app's catalog (ZunaClient.setLanguage), for its own words
```

## How text is looked up

Code never writes interface text itself. It names each text by a key, and `en.json` holds the English:

```json
{
  "$language": "English",
  "$plural": { "one": "i = 1 and v = 0" },
  "settings.privacy.readReceipts": "Send read receipts",
  "notify.startedCall": "{name} started a call",
  "details.members": { "one": "{count} member", "other": "{count} members" }
}
```

| | Text as it is | With something filled in, or a count |
|---|---|---|
| TypeScript (core, web) | `t("settings.privacy.readReceipts")` | `t("notify.startedCall", { name })`, `t("details.members", { count })` |
| React, with elements inside | | `tx("onboarding.terms", { link: <a …>…</a> })` |
| Rust (native app) | `t("settings.privacy.readReceipts")`, a `&'static str` | `tr!("notify.startedCall", name = who)`, `tr!("details.members", count = n)` |
| Swift (iPhone) | `t("settings.privacy.readReceipts")` | `t("notify.startedCall", ["name": who])`, `t("details.members", ["count": n])` |

- A key is dotted names in lower camel case, by what the text is for: `settings.privacy.readReceiptsHint`, not its words. The first name is the part of the app it's in, the same in every app: `common`, `onboarding`, `chat`, `composer`, `message`, `details`, `voice`, `settings`, and so on. `server.*` is the chat server's messages.
- What's filled in is named, `{name}`, never by position, so a translation can put it anywhere. A sentence is one key, never pieces joined by the code, as word order differs between languages.
- A count's text has a form for each plural category its language has. `count` picks the form, by the language's rules; it may be written with separators, such as "12,345".
- A key kept in a table, before any language is chosen, is marked with `mark("…")` where it's kept and looked up with `t` where it's shown.
- Where a catalog has no words for a key, English shows. Where English has none either, the key itself shows, so that it's noticed.

The core words its own errors, notifications, message previews and security warnings the same way, in the catalog the app gives it. The server's messages are English: the core puts them in the person's language by finding their English in `en.json`, under `server.*`, which `npm run i18n` writes from the server's code.

## Changing text

Add or change the key in `en.json` along with the code. Then:

```bash
npm run i18n
```

It puts `en.json` in order, writes the server's messages under `server.*`, says which keys the code looks up that `en.json` lacks and which nobody looks up, and brings every other catalog in line: keys gone from English are dropped, and new ones added as `null`, which shows English until someone translates them. `npm run test:i18n`, part of `npm test`, fails until it's been run. The type checks catch a misspelled key in TypeScript; for Rust and Swift, the check does.

Changing a text's English without changing its meaning keeps its key. When the meaning changes, give it a new key, so that no translation of the old meaning is shown for it.

## Adding a language

```bash
npm run i18n -- add pl Polski
```

This makes `locales/pl.json` with the language's own name, its plural rules from CLDR, and every key set to `null`. Translate the values, leaving each `{name}` as it is and keeping every key; a count's text has a form for each category the language's rules name, and `other`. Run `npm run i18n` and `npm run test:i18n` again: the test holds the plural rules to the ones Node's ICU has, unless its CLDR is older than the one the command's table follows and the language changed since (`CHANGED_IN_CLDR` in `src/extract.ts`), and fails on a placeholder the English doesn't have.

A language not in the command's table needs its rules written under `$plural` from [CLDR's table](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html), for whole numbers, as `one`, `few` and so on, with `other` left out: it's everything else.

Each app finds the new file by itself: the native app and the iPhone app the next time they're built, and the web app in its next build. Nothing else needs changing, though the native app's release paths already include `packages/i18n/locales`, so a new language goes out with the next nightly.

## Choosing one

Each app follows the device's language, or its browser's, when there's a catalog for it, and English when there isn't. Settings, under Appearance, shows the language in use by its own name, and the person can pick another there. Picking the device's own language again goes back to following it, so there's no separate choice for that. It's kept on the device: in the native app's settings file, the web app's local storage, and the iPhone's App Group, where the notification and share extensions read it too. Dates and times follow the device's region while the language follows the device, and the chosen language's when one is picked.

## Limits

- Right-to-left languages, Arabic and Hebrew among them, would show their words left to right: none of the apps mirrors its layout yet.
- Plural rules are for whole numbers, which is all the apps count.
- A key has one meaning. Where one English word means two things, such as "Open" for a button and for a state, there are two keys.
- What's made once and kept, or sent to other people, stays in the language it was made in: a device's name ("Windows PC", "Firefox on macOS"), which its account's other devices show, and the names a recording is sent with ("Voice message.m4a").
- Emoji keep their English names, which are what the picker searches, from the list the web and the native app share.
- What iOS words itself for Telegram's pushes is in `apps/ios/Zuna/Resources/en.lproj/Localizable.strings`, apart from this, as iOS reads it without the app. On the iPhone, ZunaHost's own words, such as the proxy check's reasons, and the screen-broadcast extension's two messages are English too: ZunaHost is what the catalogs' reader depends on, and the extension doesn't carry it.
