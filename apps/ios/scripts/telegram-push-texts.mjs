// Writes the sentence for each kind of push Telegram sends a linked account's phone
// (docs/TELEGRAM_PLAN.md, Notifications) into the app's Localizable.strings, from the list Telegram
// publishes at https://core.telegram.org/api/config.json ("push"), which its page on pushes points
// to. iOS words a push by itself from these where the notification extension doesn't run, and the
// extension words one from them for every kind but text (Zuna/Shared/TelegramPush.swift). Run it
// again when Telegram adds kinds:
//
//   node apps/ios/scripts/telegram-push-texts.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "Zuna", "Resources", "en.lproj", "Localizable.strings");

const response = await fetch("https://core.telegram.org/api/config.json");
if (!response.ok) throw new Error(`Telegram's list couldn't be fetched: HTTP ${response.status}`);
const { push } = await response.json();
if (!push || typeof push !== "object") throw new Error("Telegram's list has no push templates.");

/** `{1} sent you {2} photos` as iOS's format, `%1$@ sent you %2$@ photos`, with `%` and quotes escaped. */
const format = (template) =>
  template
    .replaceAll("%", "%%")
    .replace(/\{(\d)\}/g, (_, n) => `%${n}$@`)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');

const keys = Object.keys(push).filter((key) => /^[A-Z0-9_]+$/.test(key) && typeof push[key] === "string").sort();
const lines = [
  "/* Telegram's sentences for the pushes it sends a linked account (docs/TELEGRAM_PLAN.md), from",
  "   https://core.telegram.org/api/config.json. Written by apps/ios/scripts/telegram-push-texts.mjs:",
  "   change that, not this. */",
  "",
  ...keys.map((key) => `"${key}" = "${format(push[key])}";`),
  "",
];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"));
console.log(`> wrote ${keys.length} sentences to ${out}`);
