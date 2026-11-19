// Bundles dev-bots.ts into one file, with the cryptography beside it, for a machine that has only
// Node 22.22 or later, such as the server App Review signs in to ("On the App Store" in docs/IOS.md):
//
//   npm run build:crypto && node packages/core/test/dev-bots-bundle.mjs
//
// They go in dist/review laid out as in the repository, where helpers.ts looks for the cryptography.

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = join(root, "dist", "review");
const wasm = join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm");

if (!existsSync(wasm)) {
  console.error("The cryptography isn't built. Run npm run build:crypto first.");
  process.exit(1);
}
mkdirSync(join(out, "packages", "crypto", "pkg"), { recursive: true });
await build({
  entryPoints: [join(here, "dev-bots.ts")],
  outfile: join(out, "packages", "core", "test", "dev-bots.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
  // The bundle is an ES module, and what it bundles still asks for Node's own with require.
  banner: { js: "import { createRequire as __zunaRequire } from 'node:module';\nconst require = __zunaRequire(import.meta.url);" },
});
copyFileSync(wasm, join(out, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm"));
console.log(`> wrote dev-bots to ${out}`);
