// The web app's words in the person's language (docs/TRANSLATING.md). Code names each text by its
// key in packages/i18n/locales/en.json: t("settings.privacy.readReceipts"), with what's filled in
// as t("chat.typing.one", { name }) and a count's form by t("chat.members", { count }). Text with
// elements in it, such as a link in a sentence, is tx("…", { link: <a>…</a> }). English is always
// here; another language's catalog is loaded when it's chosen, and the core is given it too, so
// that its errors and the server's messages read the same.

import { createElement, Fragment, type ReactNode } from "react";
import { matchLanguage, parseCatalog, Translator } from "@zuna/i18n";
import english from "@zuna/i18n/locales/en.json";

/** Every key English has. */
export type MessageKey = Exclude<keyof typeof english, "$language" | "$plural">;

type Vars = Readonly<Record<string, string | number>>;

const ENGLISH = parseCatalog("en", english);

// Each other language's own name, for the picker, and its catalog, loaded when it's chosen.
const names = import.meta.glob<string>(["../../../i18n/locales/*.json", "!../../../i18n/locales/en.json"], { import: "$language", eager: true });
const catalogs = import.meta.glob<Record<string, unknown>>(["../../../i18n/locales/*.json", "!../../../i18n/locales/en.json"], { import: "default" });
const tagOf = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".json".length);

/** The languages there are, English first, each by its own name. */
export const LANGUAGES: readonly { tag: string; name: string }[] = [
  { tag: "en", name: "English" },
  ...Object.entries(names)
    .map(([path, name]) => ({ tag: tagOf(path), name }))
    .sort((a, b) => a.name.localeCompare(b.name)),
];

let translator = new Translator(ENGLISH);
let chosen = "system";

/** A key's text in the person's language, with its {name}s filled in, and a count's form by `vars.count`. */
export const t = (key: MessageKey, vars?: Vars): string => translator.t(key, vars);

/**
 * A key's text with elements in place of some of its {name}s, such as a link in a sentence.
 * Strings and numbers are filled in as `t` fills them, `count` included.
 */
export function tx(key: MessageKey, vars: Readonly<Record<string, ReactNode>>): ReactNode {
  const plain: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) if (typeof value === "string" || typeof value === "number") plain[name] = value;
  const text = translator.t(key, plain);
  const parts = text.split(/\{([A-Za-z_][A-Za-z0-9_]*)\}/);
  return createElement(
    Fragment,
    null,
    ...parts.map((part, i) => (i % 2 === 0 ? part : Object.prototype.hasOwnProperty.call(vars, part) ? createElement(Fragment, { key: i }, vars[part]) : `{${part}}`)),
  );
}

/** English text from elsewhere, in the person's language when English has it under some key. */
export const translate = (text: string): string => translator.translate(text);

/** Marks a key kept in a table, to look up with `t` where it's shown. */
export const mark = (key: MessageKey): MessageKey => key;

/** The language shown, by its tag. */
export const languageTag = (): string => translator.tag;

/**
 * The locale dates and numbers are written for: the browser's own while the language follows it,
 * as it knows the person's region, or the chosen language's.
 */
export const dateLocale = (): string | undefined => (chosen === "system" ? undefined : translator.tag);

/** The language a choice in Settings comes to: one of LANGUAGES, or the browser's, or English. */
export function resolveLanguage(choice: string): string {
  const tags = LANGUAGES.map((language) => language.tag);
  if (choice !== "system" && tags.includes(choice)) return choice;
  return matchLanguage(navigator.languages ?? [navigator.language], tags) ?? "en";
}

/**
 * Shows the app in a language from now on: a tag from LANGUAGES, or "system" for the browser's.
 * Gives the catalog it loaded, or null for English, for the core.
 */
export async function applyLanguage(choice: string): Promise<{ tag: string; catalog: Record<string, unknown> | null }> {
  const tag = resolveLanguage(choice);
  const load = Object.entries(catalogs).find(([path]) => tagOf(path) === tag)?.[1];
  let catalog: Record<string, unknown> | null = null;
  try {
    catalog = load ? await load() : null;
    translator = new Translator(ENGLISH, catalog ? parseCatalog(tag, catalog) : null);
  } catch {
    // A catalog that won't load or read leaves English.
    catalog = null;
    translator = new Translator(ENGLISH);
  }
  chosen = choice;
  document.documentElement.lang = translator.tag;
  return { tag: translator.tag, catalog };
}
