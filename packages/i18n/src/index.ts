// Interface text in the person's language (docs/TRANSLATING.md). Code names each text by a key,
// such as t("settings.privacy.readReceipts"), with {name} for what's filled in, and each
// language's catalog in locales/, named by its BCP 47 tag, gives the words. locales/en.json is
// English, the source every other catalog translates and the words shown where one has none. A
// count's text is a key whose entry has a form for each plural category, picked by {count}, by the
// rules each catalog states as CLDR writes them, so that adding a language needs no code. The
// native app (src/i18n.rs) and the iPhone app (ZunaI18n) read the same files the same way, held to
// the same vectors (test/vectors.json). This file has no imports, as the core runs it in QuickJS,
// which has no Intl.

/** CLDR's plural categories, in the order a catalog's rules are tried. */
export const CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

/** A count's forms, by category. `other` is always there. */
export type PluralForms = Partial<Record<Category, string>> & { other: string };

export interface Catalog {
  /** Its BCP 47 tag, from its file's name. */
  tag: string;
  /** The language's own name for itself, as the picker shows it. */
  name: string;
  /** The rule for each category but `other`, which is everything else. */
  rules: Partial<Record<Category, Rule>>;
  /** The words for each key. */
  entries: Map<string, string | PluralForms>;
}

/** Whether a whole number belongs to a category. */
export type Rule = (count: number) => boolean;

/** What a catalog says of itself, in keys no text's key starts with. */
export const LANGUAGE_KEY = "$language";
export const PLURAL_KEY = "$plural";

/** What a key looks like: dotted names, the first starting with a letter, such as `chat.composer.send`. */
export const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Vars = Readonly<Record<string, string | number>>;

/** The names a text fills in, in order. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/** A text with its {name}s filled in. A name it isn't given stays as written. */
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
}

/**
 * The number a count's form is picked by: `count`, given as a number or written with separators,
 * such as "12,345". Without one it's the `other` form.
 */
export function countOf(vars?: Vars): number | null {
  const count = vars?.count;
  if (typeof count === "number") return Number.isFinite(count) ? count : null;
  if (typeof count !== "string") return null;
  const digits = count.replace(/[^0-9-]/g, "");
  return /^-?\d+$/.test(digits) ? Number(digits) : null;
}

// --- Plural rules ---

/**
 * A CLDR plural rule (https://unicode.org/reports/tr35/tr35-numbers.html#Language_Plural_Rules),
 * for whole numbers, which are all the apps count: n and i are the number, and v, w, f, t, c and
 * e are 0. Samples after an @ are left out. Throws on anything it can't read.
 */
export function compileRule(source: string): Rule {
  const text = source.split("@")[0]!.trim();
  if (!text) throw new Error("A plural rule is empty.");
  // Spaces are made single and then taken out of each relation, as the native app and iOS read a
  // rule, so that no expression here has two ways to match the same spaces: one that did took time
  // growing with the square of a rule's length.
  const words = text.split(/\s/).filter(Boolean).join(" ");
  const ors = words.split(" or ").map((part) =>
    part.split(" and ").map((relation) => {
      const match = /^([niwvftce])(?:%(\d+))?(!=|=)([\d.,]+)$/.exec(relation.replace(/ /g, ""));
      if (!match) throw new Error(`A plural rule can't be read: ${source}`);
      const [, operand, modulo, operator, list] = match;
      const ranges = list!.split(",").map((item) => {
        const bounds = item.trim().split("..");
        if (bounds.length > 2 || bounds.some((bound) => !/^\d+$/.test(bound))) throw new Error(`A plural rule can't be read: ${source}`);
        return [Number(bounds[0]), Number(bounds[bounds.length - 1])] as const;
      });
      const whole = operand === "n" || operand === "i";
      const divisor = modulo === undefined ? 0 : Number(modulo);
      if (modulo !== undefined && divisor === 0) throw new Error(`A plural rule can't be read: ${source}`);
      return (count: number) => {
        const value = whole ? (divisor ? count % divisor : count) : 0;
        const within = ranges.some(([low, high]) => value >= low && value <= high);
        return operator === "=" ? within : !within;
      };
    }),
  );
  return (count) => ors.some((ands) => ands.every((relation) => relation(count)));
}

/** Which form a count takes under some rules. */
export function pluralCategory(rules: Catalog["rules"], count: number): Category {
  const whole = Math.abs(Math.trunc(count));
  for (const category of CATEGORIES) if (category !== "other" && rules[category]?.(whole)) return category;
  return "other";
}

// --- Catalogs ---

/** A catalog from its file, checked as the apps check it. Throws on anything malformed. */
export function parseCatalog(tag: string, data: unknown): Catalog {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) throw new Error(`"${tag}" isn't a language tag.`);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${tag}: a catalog is a JSON object.`);
  const record = data as Record<string, unknown>;
  const name = record[LANGUAGE_KEY];
  if (typeof name !== "string" || !name.trim()) throw new Error(`${tag}: ${LANGUAGE_KEY} is the language's own name.`);
  const plural = record[PLURAL_KEY] ?? {};
  if (typeof plural !== "object" || plural === null || Array.isArray(plural)) throw new Error(`${tag}: ${PLURAL_KEY} is an object of rules.`);
  const rules: Catalog["rules"] = {};
  for (const [category, source] of Object.entries(plural)) {
    if (!CATEGORIES.includes(category as Category) || category === "other") throw new Error(`${tag}: "${category}" isn't a plural category with a rule.`);
    if (typeof source !== "string") throw new Error(`${tag}: the rule for "${category}" is text.`);
    rules[category as Category] = compileRule(source);
  }
  const entries = new Map<string, string | PluralForms>();
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("$")) {
      if (key !== LANGUAGE_KEY && key !== PLURAL_KEY) throw new Error(`${tag}: "${key}" isn't something a catalog says.`);
      continue;
    }
    // Not translated yet, which leaves it to English.
    if (value === null || value === "") continue;
    if (typeof value === "string") {
      entries.set(key, value);
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${tag}: "${key}" is text, null or plural forms.`);
    const forms: Partial<Record<Category, string>> = {};
    for (const [category, form] of Object.entries(value as Record<string, unknown>)) {
      if (!CATEGORIES.includes(category as Category)) throw new Error(`${tag}: "${key}" has a form for "${category}", which isn't a plural category.`);
      if (form === null || form === "") continue;
      if (typeof form !== "string") throw new Error(`${tag}: "${key}"'s "${category}" form is text.`);
      forms[category as Category] = form;
    }
    if (forms.other !== undefined) entries.set(key, forms as PluralForms);
  }
  return { tag, name: name.trim(), rules, entries };
}

/**
 * Which of the languages there are best suits someone who prefers some, in order: the same tag,
 * or the same language in another region. `null` when none does. Tags may be written as systems
 * write them, `pt_BR.UTF-8` included.
 */
export function matchLanguage(preferred: readonly string[], available: readonly string[]): string | null {
  const normal = (tag: string) => tag.split(/[.@]/)[0]!.replace(/_/g, "-").toLowerCase();
  const base = (tag: string) => normal(tag).split("-")[0]!;
  for (const wanted of preferred) {
    const tag = normal(wanted);
    if (!tag || tag === "c" || tag === "posix") continue;
    const exact = available.find((have) => normal(have) === tag);
    if (exact) return exact;
    const language = base(wanted);
    const close = available.find((have) => normal(have) === language) ?? available.find((have) => base(have) === language);
    if (close) return close;
  }
  return null;
}

// --- Looking text up ---

/**
 * Marks a key the code holds in a table, to look up with `t` where it's shown, so that the check
 * knows it's used.
 */
export const mark = <K extends string>(key: K): K => key;

/** Text in one language, with English where it has none. */
export class Translator {
  readonly catalog: Catalog | null;
  readonly english: Catalog;
  private byEnglish: Map<string, string> | null = null;

  constructor(english: Catalog, catalog: Catalog | null = null) {
    this.english = english;
    this.catalog = catalog;
  }

  /** The language's tag. */
  get tag(): string {
    return this.catalog?.tag ?? this.english.tag;
  }

  /**
   * A key's text, with its {name}s filled in, and for a count's, the form `vars.count` takes. A key
   * no catalog has is shown as it is, so that it's noticed.
   */
  t(key: string, vars?: Vars): string {
    for (const catalog of [this.catalog, this.english]) {
      const entry = catalog?.entries.get(key);
      if (entry === undefined) continue;
      if (typeof entry === "string") return fill(entry, vars);
      const count = countOf(vars);
      return fill((count === null ? undefined : entry[pluralCategory(catalog!.rules, count)]) ?? entry.other, vars);
    }
    return key;
  }

  /**
   * English text from elsewhere, such as a server's message, in this language when English has it
   * under some key, or as it came.
   */
  translate(text: string): string {
    if (!this.catalog) return text;
    if (!this.byEnglish) {
      this.byEnglish = new Map();
      for (const [key, entry] of this.english.entries) if (typeof entry === "string" && !this.byEnglish.has(entry)) this.byEnglish.set(entry, key);
    }
    const key = this.byEnglish.get(text);
    const entry = key === undefined ? undefined : this.catalog.entries.get(key);
    return typeof entry === "string" ? entry : text;
  }
}
