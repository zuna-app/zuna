// Writes the desktop's emoji set (packages/ui/src/lib/emoji-data.ts) as Rust for the
// Windows app's picker, so both offer the same emoji under the same names. Run it after
// that list changes:
//
//   node apps/windows/scripts/emoji.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "..", "packages", "ui", "src", "lib", "emoji-data.ts"), "utf8");

const categories = [...source.matchAll(/id: "([^"]+)",\s*label: "([^"]+)",\s*emoji: parse\(`([^`]*)`\)/g)].map(([, id, label, list]) => ({
  id,
  label,
  emoji: list
    .trim()
    .split(/\s*,\s*/)
    .map((entry) => {
      const space = entry.indexOf(" ");
      return [entry.slice(0, space), entry.slice(space + 1)];
    }),
}));
if (categories.length === 0) throw new Error("No categories found in emoji-data.ts");

const quote = (text) => JSON.stringify(text);
const lines = [
  "// Written by apps/windows/scripts/emoji.mjs from packages/ui/src/lib/emoji-data.ts. Don't edit it by hand.",
  "",
  "pub struct EmojiCategory {",
  "    pub label: &'static str,",
  "    pub emoji: &'static [(&'static str, &'static str)],",
  "}",
  "",
  "pub static EMOJI_CATEGORIES: &[EmojiCategory] = &[",
  ...categories.map(
    (category) => `    EmojiCategory { label: ${quote(category.label)}, emoji: &[${category.emoji.map(([value, name]) => `(${quote(value)}, ${quote(name)})`).join(", ")}] },`,
  ),
  "];",
  "",
];
const out = join(here, "..", "src", "emoji_data.rs");
writeFileSync(out, lines.join("\n"));
console.log(`> wrote ${categories.length} categories to ${out}`);
