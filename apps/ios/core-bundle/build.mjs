// Bundles the client core, with its polyfills and native shims, into the one
// script the iOS host loads into JavaScriptCore.

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "..", "ZunaKit", "Sources", "ZunaHost", "Resources");
const outfile = join(resources, "zuna-core.js");
const highlightFile = join(resources, "zuna-highlight.js");
const passwordFile = join(resources, "zuna-password.js");

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
  legalComments: "none",
  logLevel: "warning",
});

// Code highlighting, in a context of its own, loaded when the first code block shows.
await build({
  entryPoints: [join(here, "src", "highlight.ts")],
  outfile: highlightFile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "safari18",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

// The password meter's word lists, in a context of their own too: they're large, and
// the core also runs in the notification extension, which has little memory.
await build({
  entryPoints: [join(here, "src", "password.ts")],
  outfile: passwordFile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  target: "safari18",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

console.log(`> wrote ${outfile}, ${highlightFile} and ${passwordFile}`);
