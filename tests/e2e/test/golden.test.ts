// Golden files that the iOS app's Swift code is checked against, made from the
// desktop's own code. If the desktop changes, this fails until the golden file
// is regenerated, and then the Swift tests show what the iOS app must follow.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EMOJI_CATEGORIES } from "@/lib/emoji-data";
import { golden as highlightGolden } from "../golden/highlight";
import { golden as markupGolden, renderCase } from "../golden/markup";
import { root } from "../src/paths";

const fixtures = join(root, "apps", "ios", "ZunaKit", "Tests", "ZunaHostTests", "Fixtures");

function check(name: string, value: unknown, folder = fixtures) {
  const file = join(folder, name);
  const fresh = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, fresh);
  expect(readFileSync(file, "utf8")).toBe(fresh);
}

it("markup golden file matches the desktop", () => {
  check("markup-golden.json", markupGolden());
});

it("renders a message of repeated formatting without running out of stack, quickly", () => {
  const started = Date.now();
  // The largest message anyone may send, all of it spans.
  const html = renderCase({ text: "**a** ".repeat(16_000) });
  expect(html.match(/<strong>/g)).toHaveLength(16_000);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(renderCase({ text: "|| **x ".repeat(16_000) }).length).toBeGreaterThan(0);
});

it("highlighting golden file matches the desktop", async () => {
  check("highlight-golden.json", await highlightGolden());
});

// Not a golden file but a copy: the iOS picker offers exactly the desktop's emoji, with the same names for search.
it("the iOS app's emoji match the desktop's", () => {
  check("emoji.json", EMOJI_CATEGORIES, join(root, "apps", "ios", "Zuna", "Resources"));
});
