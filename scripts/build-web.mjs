// Builds the web app, then zuna-web with the app inside it, for every supported
// platform, into dist/web. zuna-web-files.sha256 lists every file the app serves, so a
// running copy can be checked against a release (scripts/check-web.mjs).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ensureBuilt, env, root, run } from "./lib.mjs";

const targets = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["windows", "amd64"],
];

const version = process.env.ZUNA_VERSION ?? "dev";

ensureBuilt();
run("npm", ["run", "build", "-w", "@zuna/web"], { shell: process.platform === "win32" });

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
  .sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
writeFileSync(join(out, "zuna-web-files.sha256"), `${sums.join("\n")}\n`);

for (const [goos, goarch] of targets) {
  const name = `zuna-web-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
  run("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", join(out, name), "./cmd/zuna-web"], {
    cwd: join(root, "server"),
    env: { ...env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
  });
}
console.log(`\nBuilt into ${out}`);
