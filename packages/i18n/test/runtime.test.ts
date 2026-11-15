import { describe, expect, it } from "vitest";
import { KNOWN_RULES, ordered, slug } from "../src/extract.ts";
import { compileRule, countOf, fill, matchLanguage, parseCatalog, placeholders, pluralCategory, Translator, type Catalog } from "../src/index.ts";
import { withServerMessages } from "../scripts/i18n.ts";
import vectors from "./vectors.json";

type Vars = Record<string, string | number>;
type Lookup = { call: string; key?: string; text?: string; vars?: Vars; out: string };

const rulesOf = (sources: Record<string, string | undefined>): Catalog["rules"] =>
  Object.fromEntries(Object.entries(sources).flatMap(([category, source]) => (source === undefined ? [] : [[category, compileRule(source)]])));

const run = (translator: Translator, lookup: Lookup) => (lookup.call === "t" ? translator.t(lookup.key!, lookup.vars) : translator.translate(lookup.text!));

describe("plural rules", () => {
  it("follow CLDR as Intl does, in the shared vectors", () => {
    for (const { tag, rules, cases } of vectors.plural) {
      const compiled = rulesOf(rules);
      for (const [count, category] of Object.entries(cases)) {
        expect(new Intl.PluralRules(tag).select(Number(count)), `${tag} ${count} in Intl`).toBe(category);
        expect(pluralCategory(compiled, Number(count)), `${tag} ${count}`).toBe(category);
      }
    }
  });

  it("refuse what they can't read", () => {
    for (const source of vectors.badRules) expect(() => compileRule(source), source).toThrow();
  });

  it("leave out samples and take negative counts as positive", () => {
    const rules = rulesOf({ one: "i = 1 and v = 0 @integer 1" });
    expect(pluralCategory(rules, 1)).toBe("one");
    expect(pluralCategory(rules, -1)).toBe("one");
    expect(pluralCategory(rules, 2)).toBe("other");
  });

  it("that a new catalog starts with agree with Intl for every whole number up to 1,100 and at millions", () => {
    const counts = [...Array.from({ length: 1101 }, (_, i) => i), 1_000_000, 2_000_000, 1_000_001, 10_000_000];
    for (const [tag, sources] of Object.entries(KNOWN_RULES)) {
      const intl = new Intl.PluralRules(tag);
      const rules = rulesOf(sources);
      for (const count of counts) expect(pluralCategory(rules, count), `${tag} ${count}`).toBe(intl.select(count));
    }
  });
});

describe("filling in", () => {
  it("replaces each name it's given and leaves the rest", () => {
    for (const { text, vars, out } of vectors.fill) expect(fill(text, vars as Vars)).toBe(out);
  });

  it("lists a text's names", () => {
    expect(placeholders("{a} then {b}, {a} and { c }")).toEqual(["a", "b", "a"]);
  });

  it("picks a count's form by the number, written with separators or not", () => {
    for (const { vars, out } of vectors.counts) expect(countOf(vars as unknown as Vars), JSON.stringify(vars)).toBe(out);
  });
});

describe("matching languages", () => {
  it("takes the first preferred language there is, or another region of it", () => {
    for (const { preferred, available, out } of vectors.match) expect(matchLanguage(preferred, available), preferred.join(",")).toBe(out);
  });
});

describe("catalogs", () => {
  const english = parseCatalog("en", vectors.english);
  const catalog = parseCatalog(vectors.catalog.tag, vectors.catalog.data);

  it("look text up, with English where nothing's translated, and the key where nothing is", () => {
    const translator = new Translator(english, catalog);
    for (const lookup of vectors.lookups as Lookup[]) expect(run(translator, lookup), JSON.stringify(lookup)).toBe(lookup.out);
    expect(translator.tag).toBe("pl");
  });

  it("are English alone without another", () => {
    const translator = new Translator(english);
    for (const lookup of vectors.englishLookups as Lookup[]) expect(run(translator, lookup), JSON.stringify(lookup)).toBe(lookup.out);
    expect(translator.tag).toBe("en");
  });

  it("say their name", () => {
    expect(catalog.name).toBe("Polski");
  });

  it("refuse anything malformed", () => {
    const bad: [string, unknown][] = [
      ["pl", []],
      ["pl", null],
      ["pl", {}],
      ["pl", { $language: " " }],
      ["Polish", { $language: "Polski" }],
      ["pl", { $language: "Polski", $plural: { other: "n = 1" } }],
      ["pl", { $language: "Polski", $plural: { one: "nonsense" } }],
      ["pl", { $language: "Polski", $comment: "x" }],
      ["pl", { $language: "Polski", "common.cancel": 1 }],
      ["pl", { $language: "Polski", "common.cancel": ["Anuluj"] }],
      ["pl", { $language: "Polski", "group.days": { lots: "x", other: "y" } }],
      ["pl", { $language: "Polski", "group.days": { other: 2 } }],
    ];
    for (const [tag, data] of bad) expect(() => parseCatalog(tag, data), JSON.stringify(data)).toThrow();
  });

  it("drop a count's forms with no other form, which would leave nothing to fall back on", () => {
    const parsed = parseCatalog("pl", { $language: "Polski", "group.days": { one: "{count} dzień", other: null } });
    expect(parsed.entries.has("group.days")).toBe(false);
  });
});

describe("the tools", () => {
  it("make a key's last part from a text's first words", () => {
    expect(slug("That username is already taken.")).toBe("thatUsernameIsAlreadyTaken");
    expect(slug("You've reached the limit of reactions on this message.", 3)).toBe("youveReachedThe");
    expect(slug("7TV has no emote set with that ID.")).toBe("7tvHasNoEmoteSet");
    expect(slug("…")).toBe("text");
  });

  it("keep the server's messages under the keys they had, and give new ones keys of their own", () => {
    const english = { $language: "English", "chat.send": "Send", "server.old": "Kept.", "server.gone": "Gone." };
    const next = withServerMessages(english, ["Kept.", "That username is already taken.", "That username is already taken by a bot."]);
    expect(next).toEqual({
      $language: "English",
      "chat.send": "Send",
      "server.old": "Kept.",
      "server.thatUsernameIsAlreadyTaken": "That username is already taken.",
      "server.thatUsernameIsAlreadyTakenBy": "That username is already taken by a bot.",
    });
  });

  it("write catalogs in order", () => {
    expect(Object.keys(ordered({ b: 1, $plural: 2, a: 3, $language: 4, "a.b": 5 }))).toEqual(["$language", "$plural", "a", "a.b", "b"]);
  });
});
