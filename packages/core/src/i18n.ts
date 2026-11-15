// The core's own words in the person's language: its errors, what a notification says, what's
// shown of a message, and the server's messages as they come (`translate`). The app gives it the
// catalog it shows itself (`ZunaClient.setLanguage`), and without one it's English, as in tests
// and zuna-bot. docs/TRANSLATING.md says how text is looked up.

import { parseCatalog, Translator } from "@zuna/i18n";
import english from "@zuna/i18n/locales/en.json";

/** Every key English has. */
export type MessageKey = Exclude<keyof typeof english, "$language" | "$plural">;

type Vars = Readonly<Record<string, string | number>>;

const ENGLISH = parseCatalog("en", english);

let translator = new Translator(ENGLISH);

/** A key's text in the person's language, with its {name}s filled in, and a count's form by `vars.count`. */
export const t = (key: MessageKey, vars?: Vars): string => translator.t(key, vars);

/** A message from elsewhere, the server's, in the person's language if English has it. */
export const translate = (text: string): string => translator.translate(text);

/** Marks a key kept in a table, to look up with `t` where it's shown. */
export const mark = (key: MessageKey): MessageKey => key;

/** The language the core words things in. */
export const languageTag = (): string => translator.tag;

/**
 * Words everything from now on in a catalog's language, or in English without one. The catalog may
 * be its file's JSON text. Throws on a catalog that's malformed.
 */
export function useCatalog(tag: string, catalog: unknown): void {
  if (typeof catalog === "string") catalog = JSON.parse(catalog);
  translator = tag === "en" || catalog === null || catalog === undefined ? new Translator(ENGLISH) : new Translator(ENGLISH, parseCatalog(tag, catalog));
}
