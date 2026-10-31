// Golden files that the iOS app's Swift code is checked against, made from the
// desktop's own code. If the desktop changes, this fails until the golden file
// is regenerated, and then the Swift tests show what the iOS app must follow.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { golden as highlightGolden } from "../golden/highlight";
import { golden as markupGolden } from "../golden/markup";
import { root } from "../src/paths";

const fixtures = join(root, "apps", "ios", "ZunaKit", "Tests", "ZunaHostTests", "Fixtures");

function check(name: string, value: unknown) {
  const file = join(fixtures, name);
  const fresh = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, fresh);
  expect(readFileSync(file, "utf8")).toBe(fresh);
}

it("markup golden file matches the desktop", () => {
  check("markup-golden.json", markupGolden());
});

it("highlighting golden file matches the desktop", async () => {
  check("highlight-golden.json", await highlightGolden());
});
