// Bundles the client core, with its polyfills and native shims, for a host that runs it in a
// JavaScript engine of its own: JavaScriptCore on iOS, QuickJS in the native desktop app, whose
// Rust host installs the same __zunaHost, __zunaCrypto and __zunaDb that the Swift host does.
// Three scripts, each in a context of its own: the core, code highlighting and the password
// meter's word lists, the last two kept apart as they're large and not always wanted.

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "src");

/** Writes zuna-core.js, zuna-highlight.js and zuna-password.js into `outDir`, for the engine `target` names. */
export async function bundleCore({ target, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const common = {
    bundle: true,
    format: "iife",
    platform: "neutral",
    mainFields: ["module", "main"],
    target,
    legalComments: "none",
    logLevel: "warning",
  };
  await build({ ...common, entryPoints: [join(src, "entry.ts")], outfile: join(outDir, "zuna-core.js"), alias: { "@zuna/crypto": join(src, "crypto.ts") } });
  await build({ ...common, entryPoints: [join(src, "highlight.ts")], outfile: join(outDir, "zuna-highlight.js"), minify: true });
  await build({ ...common, entryPoints: [join(src, "password.ts")], outfile: join(outDir, "zuna-password.js"), minify: true });
  return ["zuna-core.js", "zuna-highlight.js", "zuna-password.js"].map((name) => join(outDir, name));
}
