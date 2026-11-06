// Builds or runs the native Windows app (apps/windows), drawn with GPUI. It bundles
// the client core for QuickJS first, then builds with a Rust MSVC toolchain, which
// GPUI's DirectX renderer and the C in QuickJS and SQLite need, as does Visual
// Studio's C++ build tools.
//
//   node scripts/windows-app.mjs run [--release] [-- app args]   build and start it
//   node scripts/windows-app.mjs build                            a release build in dist/windows
//
// Its data is in %APPDATA%\Zuna Native, or ZUNA_DATA_DIR, so it never touches the
// Electron app's.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env, root } from "./lib.mjs";

if (process.platform !== "win32") {
  console.log("The native app is for Windows. Build it there.");
  process.exit(0);
}

const [command = "run", ...rest] = process.argv.slice(2);
const split = rest.indexOf("--");
const flags = split < 0 ? rest : rest.slice(0, split);
const appArgs = split < 0 ? [] : rest.slice(split + 1);
const release = command === "build" || flags.includes("--release");

const crate = join(root, "apps", "windows");
// cl.exe can't open paths over 260 characters, which a target folder deep in a checkout reaches.
const target = join(process.env.LOCALAPPDATA ?? root, "zuna-windows-target");

function toolchain() {
  const list = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8", env }).stdout ?? "";
  const found = list.split("\n").map((line) => line.split(" ")[0]).find((name) => name.endsWith("-pc-windows-msvc"));
  if (!found) {
    console.error("The native app needs a Rust MSVC toolchain: rustup toolchain install stable-x86_64-pc-windows-msvc");
    process.exit(1);
  }
  return found;
}

const bundle = spawnSync(process.execPath, [join(crate, "core-bundle", "build.mjs")], { stdio: "inherit", env, cwd: root });
if (bundle.status !== 0) process.exit(bundle.status ?? 1);

const cargo = [`+${toolchain()}`, command === "build" ? "build" : "run", ...(release ? ["--release"] : []), ...(appArgs.length ? ["--", ...appArgs] : [])];
const result = spawnSync("cargo", cargo, { stdio: "inherit", cwd: crate, env: { ...env, CARGO_TARGET_DIR: target } });
if (result.status !== 0) process.exit(result.status ?? 1);

if (command === "build") {
  const dist = join(root, "dist", "windows");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(target, "release", "zuna.exe"), join(dist, "Zuna.exe"));
  console.log(`> wrote ${join(dist, "Zuna.exe")}`);
}
