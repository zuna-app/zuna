// F0 spike: does the desktop's Shiki setup run inside JavaScriptCore and color
// code exactly as it does on the desktop? Builds the highlighting bundle,
// produces golden tokens with Shiki in Node, then runs the Swift test that
// compares JavaScriptCore's tokens with them.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(tmpdir(), "zuna-highlight-spike");
mkdirSync(work, { recursive: true });

const bundle = join(work, "highlight.js");
await build({
  entryPoints: [join(here, "..", "core-bundle", "src", "highlight.ts")],
  outfile: bundle,
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "safari18",
  logLevel: "warning",
});

const samples = [
  ["typescript", "const greet = async (name: string): Promise<void> => {\n  console.log(`hi ${name}`); // say hi\n};"],
  ["python", "def fib(n: int) -> int:\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n"],
  ["rust", "fn main() {\n    let v: Vec<u8> = (0..10).map(|x| x * 2).collect();\n    println!(\"{:?}\", v);\n}"],
  ["swift", "struct Point: Hashable {\n    var x = 0.0, y = 0.0\n    func moved(by d: Double) -> Point { .init(x: x + d, y: y) }\n}"],
  ["json", '{ "name": "zuna", "version": 1, "tags": ["chat", true, null] }'],
  ["bash", 'for f in *.log; do echo "$f" | grep -E "^err" && rm -f "$f"; done'],
];

const highlighter = await createHighlighterCore({
  themes: [(await import("shiki/themes/github-dark-default.mjs")).default],
  langs: await Promise.all(["bash", "json", "python", "rust", "swift", "typescript"].map(async (name) => (await import(`shiki/langs/${name}.mjs`)).default)),
  engine: createJavaScriptRegexEngine(),
});
const golden = samples.map(([language, code]) => ({
  language,
  code,
  tokens: JSON.stringify(
    highlighter.codeToTokens(code, { lang: language, theme: "github-dark-default" }).tokens.map((line) => line.map((token) => [token.content, token.color ?? null])),
  ),
}));
const goldenPath = join(work, "golden.json");
writeFileSync(goldenPath, JSON.stringify(golden));

execFileSync("swift", ["test", "--package-path", join(here, "..", "ZunaKit"), "--filter", "HighlightSpikeTests"], {
  stdio: "inherit",
  env: { ...process.env, ZUNA_HIGHLIGHT_BUNDLE: bundle, ZUNA_HIGHLIGHT_GOLDEN: goldenPath },
});
