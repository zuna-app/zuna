// Builds zuna-bot into one file and the cryptography beside it, in dist/bot, which Node
// 22.22 or later runs with nothing else installed:
//
//   node apps/bot/build.mjs && node dist/bot/zuna-bot.mjs help
//
// The cryptography has to be built first: npm run build:crypto.

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = join(root, "dist", "bot");
const wasm = join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm");

if (!existsSync(wasm)) {
  console.error("The cryptography isn't built. Run npm run build:crypto first.");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(out, "zuna-bot.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  // The bundle is an ES module, and what it bundles still asks for Node's own with require.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __zunaRequire } from 'node:module';\nconst require = __zunaRequire(import.meta.url);" },
});
copyFileSync(wasm, join(out, "zuna_crypto_bg.wasm"));
console.log(`> wrote zuna-bot to ${out}`);
