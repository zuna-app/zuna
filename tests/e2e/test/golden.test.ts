// Golden files that the iOS app's Swift code is checked against, made from the
// desktop's own code. If the desktop changes, this fails until the golden file
// is regenerated, and then the Swift tests show what the iOS app must follow.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { golden } from "../golden/markup";
import { root } from "../src/paths";

const markupFile = join(root, "apps", "ios", "ZunaKit", "Tests", "ZunaHostTests", "Fixtures", "markup-golden.json");

it("markup golden file matches the desktop", () => {
  const fresh = `${JSON.stringify(golden(), null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(markupFile)) writeFileSync(markupFile, fresh);
  expect(readFileSync(markupFile, "utf8")).toBe(fresh);
});
