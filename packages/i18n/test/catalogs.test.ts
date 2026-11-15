// Holds locales/ to the code: en.json has every key the code looks up and the server's messages,
// nothing else, in order, and every other catalog reads as the apps read it, with the right plural
// rules and nothing filled in that English doesn't fill in.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { find, ordered, SERVER_PREFIX } from "../src/extract.ts";
import { CATEGORIES, KEY, parseCatalog, placeholders, pluralCategory, type PluralForms } from "../src/index.ts";
import { withServerMessages } from "../scripts/i18n.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const locales = join(import.meta.dirname, "..", "locales");
const read = (name: string) => JSON.parse(readFileSync(join(locales, name), "utf8")) as Record<string, unknown>;

describe("English", () => {
  const found = find(root);
  const english = read("en.json");
  const keys = Object.keys(english).filter((key) => !key.startsWith("$"));

  it("is a catalog, with keys that look like keys and every count's English forms", () => {
    parseCatalog("en", english);
    for (const key of keys) {
      expect(KEY.test(key), `"${key}" isn't a key`).toBe(true);
      const value = english[key];
      if (typeof value !== "string") expect(Object.keys(value as object).sort(), `"${key}" has a one and an other form`).toEqual(["one", "other"]);
    }
  });

  it("has every key the code looks up", () => {
    expect(found.problems).toEqual([]);
    expect([...found.keys].filter(([key]) => !(key in english)).map(([key, at]) => `${at}: ${key}`)).toEqual([]);
  });

  it("has nothing nobody looks up", () => {
    expect(keys.filter((key) => !key.startsWith(SERVER_PREFIX) && !found.keys.has(key))).toEqual([]);
  });

  it("is in order, with the server's messages as its code has them, so run npm run i18n after changing them", () => {
    expect(JSON.stringify(english, null, 2)).toBe(JSON.stringify(ordered(withServerMessages(english, found.messages.keys())), null, 2));
  });
});

describe("each other language", () => {
  const english = read("en.json");
  const names = readdirSync(locales).filter((name) => name.endsWith(".json") && name !== "en.json");

  // With English alone there are none to check, which is fine.
  it("reads as the apps read it", () => {
    for (const name of names) check(name);
  });

  function check(name: string): void {
    const tag = name.slice(0, -".json".length);
    const data = read(name);
    const catalog = parseCatalog(tag, data);
    const intl = new Intl.PluralRules(tag);
    for (let count = 0; count <= 1100; count++) expect(pluralCategory(catalog.rules, count), `${tag}'s $plural for ${count}`).toBe(intl.select(count));
    const used = new Set<string>(intl.resolvedOptions().pluralCategories);
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("$") || value === null || value === "") continue;
      const source = english[key];
      expect(source, `${tag}: "${key}" isn't in English any more, so run npm run i18n`).toBeDefined();
      expect(typeof value === "string", `${tag}: "${key}" is ${typeof source === "string" ? "a text" : "a count's forms"} in English`).toBe(typeof source === "string");
      const allowed = new Set(placeholders(typeof source === "string" ? source : Object.values(source as PluralForms).join(" ")));
      const forms = typeof value === "string" ? [value] : Object.values(value as PluralForms).filter((form): form is string => typeof form === "string");
      for (const form of forms) for (const name of placeholders(form)) expect(allowed.has(name), `${tag}: "${key}" fills in {${name}}, which English doesn't`).toBe(true);
      if (typeof value !== "string") {
        for (const category of Object.keys(value as object)) expect(CATEGORIES.includes(category as never) && used.has(category), `${tag}: "${key}" has a "${category}" form, which ${tag} doesn't use`).toBe(true);
      }
    }
  }
});
