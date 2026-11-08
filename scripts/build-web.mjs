// Builds the web app, then zuna-web with the app inside it, for every supported
// platform, into dist/web. zuna-web-files.sha256 lists every file the app serves, so a
// running copy can be checked against a release (scripts/check-web.mjs).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ensureBuilt, goBuildAll, root, run } from "./lib.mjs";

ensureBuilt();
// Vite itself, as `npm run build -w @zuna/web` runs it, without a shell between.
run(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build"], { cwd: join(root, "apps", "web") });

const built = join(root, "apps", "web", "dist");
const site = join(root, "server", "cmd", "zuna-web", "site");
for (const entry of readdirSync(site)) {
  if (entry !== ".gitkeep") rmSync(join(site, entry), { recursive: true, force: true });
}
cpSync(built, site, { recursive: true });

function filesIn(folder) {
  return readdirSync(folder).flatMap((entry) => {
    const path = join(folder, entry);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

const out = join(root, "dist", "web");
mkdirSync(out, { recursive: true });
const sums = filesIn(built)
  .map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${relative(built, path).split(sep).join("/")}`)
  // By the path's bytes, not the locale's order, so the list is the same wherever it's made.
  .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0));
writeFileSync(join(out, "zuna-web-files.sha256"), `${sums.join("\n")}\n`);

goBuildAll("./cmd/zuna-web", out, "zuna-web");
console.log(`\nBuilt into ${out}`);
