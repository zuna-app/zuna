// Builds or runs the native app (apps/desktop) on Linux, where it runs under Wayland. It
// bundles the client core for QuickJS first, as scripts/windows-app.mjs does, then builds
// with whichever Rust is installed.
//
//   node scripts/linux-app.mjs run [--release] [-- app args]   build and start it
//   node scripts/linux-app.mjs build                            a release build in dist/linux
//
// Its data is in ~/.local/share/zuna-native, or ZUNA_DATA_DIR, so it never touches the
// Electron app's.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env, root } from "./lib.mjs";

if (process.platform !== "linux") {
  console.log("This builds the native app on Linux. On Windows, it's npm run dev:windows.");
  process.exit(0);
}

const [command = "run", ...rest] = process.argv.slice(2);
const split = rest.indexOf("--");
const flags = split < 0 ? rest : rest.slice(0, split);
const appArgs = split < 0 ? [] : rest.slice(split + 1);
const release = command === "build" || flags.includes("--release");

const crate = join(root, "apps", "desktop");
// Outside the checkout, as the Windows build's is, and kept between checkouts.
const target = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");
// The same version as the desktop app, which is released with it.
const version = JSON.parse(readFileSync(join(root, "apps", "desktop-electron-legacy", "package.json"), "utf8")).version;

const bundle = spawnSync(process.execPath, [join(crate, "core-bundle", "build.mjs")], { stdio: "inherit", env, cwd: root });
if (bundle.status !== 0) process.exit(bundle.status ?? 1);

const cargo = [command === "run" ? "run" : "build", ...(release ? ["--release"] : []), ...(appArgs.length ? ["--", ...appArgs] : [])];
const result = spawnSync("cargo", cargo, { stdio: "inherit", cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ZUNA_VERSION: version } });
if (result.status !== 0) process.exit(result.status ?? 1);

if (command === "build") {
  const dist = join(root, "dist", "linux");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(target, "release", "zuna"), join(dist, "zuna-native"));
  console.log(`> wrote ${join(dist, "zuna-native")}`);
}
