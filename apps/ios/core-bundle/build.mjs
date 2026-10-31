// Bundles the client core, with its polyfills and native shims, into the one
// script the iOS host loads into JavaScriptCore.

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "..", "ZunaKit", "Sources", "ZunaHost", "Resources", "zuna-core.js");

await build({
  entryPoints: [join(here, "src", "entry.ts")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  // The JavaScriptCore in iOS 18 matches Safari 18.
  target: "safari18",
  alias: { "@zuna/crypto": join(here, "src", "crypto.ts") },
  define: { __ZUNA_TEST__: JSON.stringify(process.env.ZUNA_TEST !== "0") },
  legalComments: "none",
  logLevel: "warning",
});

console.log(`> wrote ${outfile}`);
