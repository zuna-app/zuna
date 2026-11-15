// Holds locales/en.json to the code. Every key the apps and the core look up must be in it, and
// every key in it looked up somewhere. Keys are found where the code names them: t("…") and, in
// the web app, tx("…") for text with elements in it; tr!("…", name = value) in the native app;
// and mark("…") for a key kept in a table and looked up later. Each is a literal in double quotes
// so that this can find it. The server's messages are what it gives writeError, which the core
// translates as they come, by their English (`translate`): they're kept in en.json under
// server.*, which npm run i18n writes.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { KEY } from "./index.ts";

type Kind = "ts" | "rust" | "swift" | "go";

/** Where text is looked up, from the repository's root. Tests are left out. */
export const SOURCES: { dir: string; kind: Kind }[] = [
  { dir: "packages/core/src", kind: "ts" },
  { dir: "packages/ui/src", kind: "ts" },
  { dir: "apps/web/src", kind: "ts" },
  { dir: "apps/desktop/src", kind: "rust" },
  { dir: "apps/ios/Zuna", kind: "swift" },
  { dir: "apps/ios/ZunaKit/Sources", kind: "swift" },
  { dir: "apps/ios/ZunaNotifications", kind: "swift" },
  { dir: "apps/ios/ZunaShare", kind: "swift" },
  { dir: "apps/ios/ZunaBroadcast", kind: "swift" },
  { dir: "server/internal/api", kind: "go" },
];

/** Where the server's messages are kept in en.json. */
export const SERVER_PREFIX = "server.";

const EXTENSIONS: Record<Kind, RegExp> = { ts: /\.tsx?$/, rust: /\.rs$/, swift: /\.swift$/, go: /\.go$/ };

/** What isn't built into an app: tests, fixtures and checks. */
const LEFT_OUT = /(^|\/)(test|tests|testing|fixtures)(\/|$)|(^|\/)tests?\.rs$|_test\.go$|\.test\.tsx?$|\.d\.ts$/;

/** How each language names a key: not after a dot or a word, so not a method or another name. */
const CALLS: Record<Exclude<Kind, "go">, RegExp> = {
  ts: /(?<![\w$.])(t|tx|mark)\(/g,
  rust: /(?<![\w])(t|tr!|mark)\(/g,
  swift: /(?<![\w.])(t|mark)\(/g,
};

const MESSAGE = /(?<![\w.])writeError\(\s*w\s*,[^,]+,\s*"[a-z_]+"\s*,\s*(?=")/g;

function* files(dir: string, kind: Kind, root: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const from = relative(root, path).replace(/\\/g, "/");
    if (LEFT_OUT.test(from)) continue;
    if (entry.isDirectory()) yield* files(path, kind, root);
    else if (EXTENSIONS[kind].test(entry.name)) yield path;
  }
}

/** A literal in double quotes from `at`, past any space before it: its text and where it ends. */
function literal(source: string, at: number, kind: Kind): { text: string; end: number } | { problem: string } | null {
  let i = at;
  while (/\s/.test(source[i] ?? "")) i++;
  if (source[i] !== '"') return null;
  if (source.startsWith('"""', i)) return { problem: "a literal is one line in double quotes" };
  let text = "";
  for (i++; i < source.length; i++) {
    const char = source[i]!;
    if (char === '"') return { text, end: i + 1 };
    if (char === "\n" && kind !== "rust") return { problem: "a literal is one line" };
    if (char !== "\\") {
      text += char;
      continue;
    }
    const next = source[++i]!;
    if (next === "\n" && kind === "rust") {
      // Rust's line continuation, which drops the next line's leading space.
      while (/\s/.test(source[i + 1] ?? "")) i++;
      continue;
    }
    if (next === "(" && kind === "swift") return { problem: "a key can't interpolate" };
    if (next === "u") {
      const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(source.slice(i + 1));
      const bare = /^[0-9a-fA-F]{4}/.exec(source.slice(i + 1));
      if (braced) {
        text += String.fromCodePoint(parseInt(braced[1]!, 16));
        i += braced[0].length;
      } else if (bare && (kind === "ts" || kind === "go")) {
        text += String.fromCharCode(parseInt(bare[0], 16));
        i += 4;
      } else return { problem: "a \\u escape can't be read" };
      continue;
    }
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "'": "'", "\\": "\\" };
    if (!(next in escapes)) return { problem: `\\${next} can't be read` };
    text += escapes[next];
  }
  return { problem: "a literal isn't closed" };
}

const lineOf = (source: string, at: number) => source.slice(0, at).split("\n").length;

/** Whether a match is in a comment, or where a lookup is itself defined. */
function skipped(source: string, at: number): boolean {
  const before = source.slice(source.lastIndexOf("\n", at) + 1, at);
  // A comment's // starts a line or follows a space, unlike one in an address or a pattern.
  return /(^|\s)\/\//.test(before) || /^\s*\*/.test(before) || /\b(fn|func|function)\s+$/.test(before);
}

export interface Found {
  /** Each key the code looks up, with where it's first looked up, as "path:line". */
  keys: Map<string, string>;
  /** The server's messages, with where each is. */
  messages: Map<string, string>;
  /** What can't be read as a key, with where it is. */
  problems: string[];
}

/** Every key the code looks up, and every message the server sends. */
export function find(root: string): Found {
  const keys = new Map<string, string>();
  const messages = new Map<string, string>();
  const problems: string[] = [];
  for (const { dir, kind } of SOURCES) {
    for (const path of files(join(root, dir), kind, root)) {
      const source = readFileSync(path, "utf8");
      const file = relative(root, path).replace(/\\/g, "/");
      if (kind === "go") {
        for (const match of source.matchAll(MESSAGE)) {
          const found = literal(source, match.index! + match[0].length, kind);
          if (found && !("problem" in found) && !messages.has(found.text)) messages.set(found.text, `${file}:${lineOf(source, match.index!)}`);
        }
        continue;
      }
      for (const match of source.matchAll(CALLS[kind])) {
        if (skipped(source, match.index!)) continue;
        const at = `${file}:${lineOf(source, match.index!)}`;
        const found = literal(source, match.index! + match[0].length, kind);
        // A key held in a variable, which mark() names where it's kept.
        if (found === null) continue;
        if ("problem" in found) {
          problems.push(`${at}: ${found.problem}.`);
          continue;
        }
        if (!KEY.test(found.text)) {
          problems.push(`${at}: "${found.text}" isn't a key. Keys are dotted names, such as chat.composer.send.`);
          continue;
        }
        if (!keys.has(found.text)) keys.set(found.text, at);
      }
    }
  }
  return { keys, messages, problems };
}

/**
 * A key's last part from some words: the first few of its first sentence, leaving out what's
 * filled in, in camel case, such as "thatUsernameIsAlreadyTaken" for "That username is already
 * taken.".
 */
export function slug(text: string, words = 5): string {
  const wordsOf = (part: string) =>
    part
      .replace(/['’]/g, "")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
  const plain = text.replace(/\{[^}]*\}/g, " ");
  const sentence = wordsOf(plain.split(/[.?!:;](?:\s|$)/)[0]!);
  const first = sentence.length ? sentence : wordsOf(plain);
  // Past the first sentence only when it takes more than five words to tell texts apart.
  const parts = (words <= 5 || first.length >= words ? first : wordsOf(plain)).slice(0, words);
  if (!parts.length) return "text";
  return parts.map((part, i) => (i === 0 ? part.toLowerCase() : part[0]!.toUpperCase() + part.slice(1).toLowerCase())).join("");
}

/** A catalog's entries in the order they're written: what it says of itself, then by key. */
export function ordered(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data).filter((key) => key.startsWith("$")).sort()) out[key] = data[key];
  for (const key of Object.keys(data).filter((key) => !key.startsWith("$")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[key] = data[key];
  return out;
}

/** English's rule. */
export const ENGLISH_PLURAL = { one: "i = 1 and v = 0" };

/**
 * CLDR 49's rules for whole numbers in common languages (unicode.org/cldr/charts/latest/supplemental/
 * language_plural_rules.html), which `npm run i18n -- add` starts a catalog with. What's left out
 * only matters for fractions. The check holds each to Intl.PluralRules (`intlPlurals`).
 */
export const KNOWN_RULES: Record<string, Record<string, string>> = {
  af: { one: "n = 1" },
  ar: { zero: "n = 0", one: "n = 1", two: "n = 2", few: "n % 100 = 3..10", many: "n % 100 = 11..99" },
  az: { one: "n = 1" },
  be: { one: "n % 10 = 1 and n % 100 != 11", few: "n % 10 = 2..4 and n % 100 != 12..14", many: "n % 10 = 0 or n % 10 = 5..9 or n % 100 = 11..14" },
  bg: { one: "n = 1" },
  bn: { one: "i = 0 or n = 1" },
  bs: { one: "v = 0 and i % 10 = 1 and i % 100 != 11", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14" },
  ca: { one: "i = 1 and v = 0", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  cs: { one: "i = 1 and v = 0", few: "i = 2..4 and v = 0" },
  da: { one: "n = 1" },
  de: { one: "i = 1 and v = 0" },
  el: { one: "n = 1" },
  en: ENGLISH_PLURAL,
  es: { one: "n = 1", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  et: { one: "i = 1 and v = 0" },
  eu: { one: "n = 1" },
  fa: { one: "i = 0 or n = 1" },
  fi: { one: "i = 1 and v = 0" },
  fil: { one: "v = 0 and i = 1,2,3 or v = 0 and i % 10 != 4,6,9" },
  fr: { one: "i = 0,1", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  gl: { one: "i = 1 and v = 0", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  he: { one: "i = 1 and v = 0", two: "i = 2 and v = 0" },
  hi: { one: "i = 0 or n = 1" },
  hr: { one: "v = 0 and i % 10 = 1 and i % 100 != 11", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14" },
  hu: { one: "n = 1" },
  hy: { one: "i = 0,1" },
  id: {},
  is: { one: "i % 10 = 1 and i % 100 != 11" },
  it: { one: "i = 1 and v = 0", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  ja: {},
  ka: { one: "n = 1" },
  kk: { one: "n = 1" },
  ko: {},
  lt: { one: "n % 10 = 1 and n % 100 != 11..19", few: "n % 10 = 2..9 and n % 100 != 11..19" },
  lv: { zero: "n % 10 = 0 or n % 100 = 11..19", one: "n % 10 = 1 and n % 100 != 11" },
  mk: { one: "v = 0 and i % 10 = 1 and i % 100 != 11" },
  ms: {},
  nb: { one: "n = 1" },
  nl: { one: "i = 1 and v = 0" },
  nn: { one: "n = 1" },
  pl: { one: "i = 1 and v = 0", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14", many: "v = 0 and i != 1 and i % 10 = 0..1 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 12..14" },
  pt: { one: "i = 0..1", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  "pt-PT": { one: "i = 1 and v = 0", many: "e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5" },
  ro: { one: "i = 1 and v = 0", few: "v != 0 or n = 0 or n != 1 and n % 100 = 1..19" },
  ru: { one: "v = 0 and i % 10 = 1 and i % 100 != 11", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14", many: "v = 0 and i % 10 = 0 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 11..14" },
  sk: { one: "i = 1 and v = 0", few: "i = 2..4 and v = 0" },
  sl: { one: "v = 0 and i % 100 = 1", two: "v = 0 and i % 100 = 2", few: "v = 0 and i % 100 = 3..4" },
  sq: { one: "n = 1" },
  sr: { one: "v = 0 and i % 10 = 1 and i % 100 != 11", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14" },
  sv: { one: "i = 1 and v = 0" },
  sw: { one: "i = 1 and v = 0" },
  ta: { one: "n = 1" },
  th: {},
  tr: { one: "n = 1" },
  uk: { one: "v = 0 and i % 10 = 1 and i % 100 != 11", few: "v = 0 and i % 10 = 2..4 and i % 100 != 12..14", many: "v = 0 and i % 10 = 0 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 11..14" },
  ur: { one: "i = 1 and v = 0" },
  uz: { one: "n = 1" },
  vi: { one: "i = 0 or n = 1" },
  zh: {},
};

/**
 * The languages whose rules changed in a CLDR newer than 48, by the release that changed them.
 * Node's own builds carry CLDR 48, and Homebrew's whatever ICU the system has, so Intl only knows
 * these rules where its CLDR is as new.
 */
export const CHANGED_IN_CLDR: Record<string, number> = { gl: 49, vi: 49 };

/** Intl's plural rules for a language, or null where this runtime's CLDR is older than the rules here. */
export function intlPlurals(tag: string): Intl.PluralRules | null {
  const changed = CHANGED_IN_CLDR[tag] ?? CHANGED_IN_CLDR[tag.split("-")[0]!] ?? 0;
  return Number(process.versions.cldr ?? 0) >= changed ? new Intl.PluralRules(tag) : null;
}
