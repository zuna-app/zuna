// `npm run i18n`: puts locales/en.json in order, with the server's messages under server.* as
// its code has them, says which keys the code looks up that it lacks and which nobody looks up,
// and brings every other catalog in line with it: keys gone from English are dropped, and new
// ones added as null, which shows English until someone translates them.
// `npm run i18n -- add <tag> <name>` starts a language's catalog. docs/TRANSLATING.md says how
// it all fits.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGLISH_PLURAL, find, KNOWN_RULES, ordered, SERVER_PREFIX, slug } from "../src/extract.ts";
import { CATEGORIES, LANGUAGE_KEY, parseCatalog, PLURAL_KEY } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const locales = join(here, "..", "locales");

const write = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

/** English with the server's messages as its code has them now, keeping the keys they had. */
export function withServerMessages(english: Record<string, unknown>, messages: Iterable<string>): Record<string, unknown> {
  const next = { ...english };
  const kept = new Map<string, string>();
  for (const [key, value] of Object.entries(english)) {
    if (!key.startsWith(SERVER_PREFIX)) continue;
    if (typeof value === "string" && !kept.has(value)) kept.set(value, key);
    delete next[key];
  }
  const taken = new Set(Object.keys(next));
  // Those keeping their keys first, then the shortest, so that a longer one takes the longer key.
  const words = (text: string) => text.split(/\s+/).length;
  const order = [...messages].sort((a, b) => Number(!kept.has(a)) - Number(!kept.has(b)) || words(a) - words(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const message of order) {
    let key = kept.get(message);
    if (key === undefined || taken.has(key)) {
      key = undefined;
      // A new message's key is its first words, as many as it takes to tell it from the others.
      for (let words = 5; words <= 40 && key === undefined; words++) {
        const candidate = `${SERVER_PREFIX}${slug(message, words)}`;
        if (!taken.has(candidate)) key = candidate;
      }
      if (key === undefined) {
        const base = `${SERVER_PREFIX}${slug(message, 40)}`;
        let n = 2;
        while (taken.has(`${base}${n}`)) n++;
        key = `${base}${n}`;
      }
    }
    taken.add(key);
    next[key] = message;
  }
  return next;
}

function update(): void {
  const found = find(root);
  const path = join(locales, "en.json");
  const english = ordered(withServerMessages(existsSync(path) ? read(path) : { [LANGUAGE_KEY]: "English", [PLURAL_KEY]: ENGLISH_PLURAL }, found.messages.keys()));
  parseCatalog("en", english);
  write(path, english);
  const keys = Object.keys(english).filter((key) => !key.startsWith("$"));
  const problems = [...found.problems];
  for (const [key, at] of found.keys) if (!(key in english)) problems.push(`${at}: "${key}" isn't in en.json.`);
  for (const key of keys) if (!key.startsWith(SERVER_PREFIX) && !found.keys.has(key)) problems.push(`en.json: nothing looks up "${key}".`);
  console.log(`en: ${keys.length} texts`);
  for (const name of readdirSync(locales).sort()) {
    if (!name.endsWith(".json") || name === "en.json") continue;
    const file = join(locales, name);
    const tag = name.slice(0, -".json".length);
    const old = read(file);
    const plural = (old[PLURAL_KEY] ?? {}) as Record<string, string>;
    const categories = [...CATEGORIES.filter((category) => category !== "other" && category in plural), "other"];
    const next: Record<string, unknown> = { [LANGUAGE_KEY]: old[LANGUAGE_KEY], [PLURAL_KEY]: plural };
    let done = 0;
    for (const key of keys) {
      const have = old[key];
      if (typeof english[key] === "string") {
        next[key] = typeof have === "string" && have ? have : null;
        if (next[key] !== null) done++;
      } else {
        const forms = typeof have === "object" && have !== null ? (have as Record<string, string | null>) : {};
        next[key] = Object.fromEntries(categories.map((category) => [category, forms[category] || null]));
        if (Object.values(next[key] as object).every(Boolean)) done++;
      }
    }
    const dropped = Object.keys(old).filter((key) => !key.startsWith("$") && !(key in english)).length;
    write(file, ordered(next));
    parseCatalog(tag, next);
    console.log(`${tag}: ${done} of ${keys.length} translated${dropped ? `, ${dropped} no longer used dropped` : ""}`);
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}

function add(tag: string | undefined, name: string | undefined): void {
  if (!tag || !name) {
    console.error('Usage: npm run i18n -- add <tag> "<the language\'s own name>", such as: npm run i18n -- add pl Polski');
    process.exit(1);
  }
  const path = join(locales, `${tag}.json`);
  if (existsSync(path)) {
    console.error(`${tag}.json is there already.`);
    process.exit(1);
  }
  const rules = KNOWN_RULES[tag] ?? KNOWN_RULES[tag.split("-")[0]!];
  if (!rules) {
    console.error(`There are no plural rules here for ${tag}. Write them under "${PLURAL_KEY}" in ${tag}.json from CLDR's table (https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html), then run npm run i18n.`);
  }
  write(path, { [LANGUAGE_KEY]: name, [PLURAL_KEY]: rules ?? {} });
  update();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "update") update();
  else if (command === "add") add(rest[0], rest[1]);
  else {
    console.error(`Unknown command "${command}". Use no command to update the catalogs, or add <tag> <name>.`);
    process.exit(1);
  }
}
