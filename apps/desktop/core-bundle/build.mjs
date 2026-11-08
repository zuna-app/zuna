// Bundles the client core for the native desktop app, which runs it in QuickJS. The core
// is the same one the iOS app loads into JavaScriptCore, with the same polyfills and
// native shims (apps/ios/core-bundle/src): the Rust host installs the same
// __zunaHost, __zunaCrypto and __zunaDb that the Swift host does.
//
//   node apps/desktop/core-bundle/build.mjs

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shims = join(here, "..", "..", "ios", "core-bundle", "src");
const out = join(here, "..", "assets", "core");
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  // QuickJS-ng has ES2023, but lowering a little further costs nothing and keeps clear of its gaps.
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [join(shims, "entry.ts")],
  outfile: join(out, "zuna-core.js"),
  alias: { "@zuna/crypto": join(shims, "crypto.ts") },
});

// The password meter's word lists, in a context of their own: they're large.
await build({ ...common, entryPoints: [join(shims, "password.ts")], outfile: join(out, "zuna-password.js"), minify: true });

// Code highlighting, in a context of its own. Nothing in the app loads it yet: it draws
// code blocks in one color.
await build({ ...common, entryPoints: [join(shims, "highlight.ts")], outfile: join(out, "zuna-highlight.js"), minify: true });

console.log(`> wrote the core bundles to ${out}`);
