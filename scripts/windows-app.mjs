// Builds or runs the native Windows app (apps/desktop), drawn with GPUI. It bundles
// the client core for QuickJS first, then builds with a Rust MSVC toolchain, which
// GPUI's DirectX renderer and the C in QuickJS and SQLite need, as does Visual
// Studio's C++ build tools.
//
//   node scripts/windows-app.mjs run [--release] [-- app args]   build and start it
//   node scripts/windows-app.mjs build                            a release build in dist/windows
//   node scripts/windows-app.mjs dist                             and its installer beside it
//   node scripts/windows-app.mjs install                          and installs it, or updates the installed app
//
// The installed app keeps its data in %APPDATA%\Zuna Native. A copy run from anywhere else
// keeps its own in %APPDATA%\Zuna Native Dev, and one started here in .dev-data, so that
// `npm run dev:clean` starts it over with the test server. ZUNA_DATA_DIR puts any of them elsewhere.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { devNativeAppData, env, ensureNativeScreenCurrent, root } from "./lib.mjs";

if (process.platform !== "win32") {
  console.log("The native app is for Windows. Build it there.");
  process.exit(0);
}

const [command = "run", ...rest] = process.argv.slice(2);
const split = rest.indexOf("--");
const flags = split < 0 ? rest : rest.slice(0, split);
const appArgs = split < 0 ? [] : rest.slice(split + 1);
const packaging = command === "dist" || command === "install";
const release = command === "build" || packaging || flags.includes("--release");

const crate = join(root, "apps", "desktop");
// cl.exe can't open paths over 260 characters, which a target folder deep in a checkout reaches.
const target = join(process.env.LOCALAPPDATA ?? root, "zuna-windows-target");
// The same version as the desktop app, which is released with it.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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

const cargo = [`+${toolchain()}`, command === "run" ? "run" : "build", ...(release ? ["--release"] : []), ...(appArgs.length ? ["--", ...appArgs] : [])];
const appData = command === "run" ? { ZUNA_DATA_DIR: process.env.ZUNA_DATA_DIR ?? devNativeAppData } : {};
const result = spawnSync("cargo", cargo, { stdio: "inherit", cwd: crate, env: { ...env, ...appData, CARGO_TARGET_DIR: target, ZUNA_VERSION: version } });
if (result.status !== 0) process.exit(result.status ?? 1);

if (command === "build" || packaging) {
  const dist = join(root, "dist", "windows");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(target, "release", "zuna.exe"), join(dist, "Zuna.exe"));
  console.log(`> wrote ${join(dist, "Zuna.exe")}`);
}

if (packaging) {
  ensureNativeScreenCurrent();
  const dist = join(root, "dist", "windows");
  // What's installed: the app, and the desktop's native screen capture beside it, where it's been built.
  const staged = join(dist, "Zuna");
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  copyFileSync(join(target, "release", "zuna.exe"), join(staged, "Zuna.exe"));
  const screenshare = join(root, "apps", "screenshare", "dist");
  if (existsSync(join(screenshare, "zuna-screenshare.exe"))) {
    cpSync(screenshare, join(staged, "screenshare"), { recursive: true });
  } else {
    console.warn("> no native screen capture to put in: npm run build:screenshare first, or this installer can't share a screen");
  }
  // Signed with the release's certificate where it's given: only a signed build updates itself,
  // and only from an update signed the same.
  const require = createRequire(join(root, "package.json"));
  const signer = await signing(require);
  if (signer) {
    signer(join(staged, "Zuna.exe"));
    if (existsSync(join(staged, "screenshare", "zuna-screenshare.exe"))) signer(join(staged, "screenshare", "zuna-screenshare.exe"));
  }
  const icon = join(dist, "zuna.ico");
  writeFileSync(icon, ico(join(root, "apps", "desktop", "resources", "icons")));
  // electron-builder's own NSIS, through app-builder-lib, fetched once if it isn't here.
  const { getMakeNsisPath } = require("app-builder-lib/out/toolsets/windows");
  const makensis = await getMakeNsisPath(undefined, undefined);
  const out = join(dist, `Zuna-Native-Setup-${version}.exe`);
  const nsis = (defines) => {
    const made = spawnSync(makensis.path, ["-V2", `-DSOURCE=${staged}`, `-DVERSION=${version}`, `-DICON=${icon}`, ...defines, join(crate, "installer", "zuna.nsi")], {
      stdio: "inherit",
      env: { ...process.env, ...(makensis.env ?? {}) },
    });
    if (made.status !== 0) process.exit(made.status ?? 1);
  };
  // Built twice, as electron-builder builds installers: first a program that only writes the
  // uninstaller, which is run and the uninstaller signed, then the installer that carries it.
  const uninstaller = join(dist, "Uninstall Zuna.exe");
  const writer = join(dist, "write-uninstaller.exe");
  rmSync(uninstaller, { force: true });
  nsis(["-DBUILD_UNINSTALLER", `-DOUTFILE=${writer}`, `-DUNINSTALLER=${uninstaller}`]);
  spawnSync(writer, [], { stdio: "inherit" });
  rmSync(writer, { force: true });
  if (!existsSync(uninstaller)) {
    console.error("Writing the uninstaller failed.");
    process.exit(1);
  }
  if (signer) signer(uninstaller);
  nsis([`-DOUTFILE=${out}`, `-DUNINSTALLER=${uninstaller}`]);
  rmSync(uninstaller, { force: true });
  if (signer) signer(out);
  console.log(`> wrote ${out}${signer ? ", signed" : ""}`);
  if (command === "install") install(out);
}

/**
 * Installs the app as anyone would, with the installer just made, quietly, as an update is
 * installed: over the copy running, which is asked to quit first and started again afterwards.
 * The installer, the --quit and the app are started through Windows, never as this script's
 * children. Started from inside a packaged app, as Claude's desktop app is, they'd write the app
 * and its data under that package's own folder, which nothing else in Windows sees: not the
 * shortcuts, nor zuna:// links, nor the app when it's started from them.
 */
function install(installer) {
  const exe = join(process.env.LOCALAPPDATA, "Programs", "Zuna Native", "Zuna.exe");
  const running = runningCopy(exe);
  if (running) {
    // As Quit in the tray does: the installer's own Stop-Process could cut off a write.
    outside(`"${exe}" --quit`);
    const until = Date.now() + 15_000;
    while (runningCopy(exe) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    if (runningCopy(exe)) console.warn("> the installed app didn't quit, so the installer closes it");
  }
  // It ends well even when a running copy kept it from replacing the program, so what it left is
  // compared with what was built, where Windows sees it too.
  const built = join(dirname(installer), "Zuna.exe");
  const result = join(dirname(installer), "install-result.txt");
  rmSync(result, { force: true });
  const installing = outside(`cmd.exe /c ""${installer}" /S & (fc /b "${exe}" "${built}" > nul && echo same > "${result}" || echo different > "${result}")"`);
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Wait-Process -Id ${installing} -Timeout 180 -ErrorAction SilentlyContinue`], { stdio: "ignore" });
  const outcome = existsSync(result) ? readFileSync(result, "utf8").trim() : "";
  rmSync(result, { force: true });
  if (outcome !== "same") {
    console.error(outcome ? `The installer left the old ${exe} in place. Quit the app and run this again.` : "The installer didn't finish.");
    process.exit(1);
  }
  // As its shortcut starts it.
  if (running) spawnSync("explorer.exe", [exe], { stdio: "ignore" });
  console.log(`> installed ${exe}, version ${version}${running ? ", and started it again" : ""}`);
}

/** Whether the installed copy is running. Others named Zuna.exe, such as a development build, don't count. */
function runningCopy(exe) {
  const path = exe.replaceAll("'", "''");
  const found = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-Process Zuna -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${path}' }).Count`], { encoding: "utf8" });
  return Number(found.stdout?.trim()) > 0;
}

/** Starts a command as this person through WMI, outside any package this script runs inside, and returns its process ID. */
function outside(command) {
  const line = command.replaceAll("'", "''");
  const started = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${line}' }).ProcessId`], { encoding: "utf8" });
  const id = Number(started.stdout?.trim());
  if (!id) {
    console.error(`Windows didn't start ${command}: ${started.stderr?.trim() ?? ""}`);
    process.exit(1);
  }
  return id;
}

/**
 * Signs files with the certificate in CSC_LINK (a .pfx as base64, a path or an https address)
 * and CSC_KEY_PASSWORD, as electron-builder reads them, through its own signtool. Null without them.
 */
async function signing(require) {
  const link = process.env.CSC_LINK;
  const password = process.env.CSC_KEY_PASSWORD;
  if (!link || !password) return null;
  const pfx = join(root, "dist", "windows", "signing.pfx");
  if (link.startsWith("https://")) writeFileSync(pfx, Buffer.from(await (await fetch(link)).arrayBuffer()));
  else if (existsSync(link)) copyFileSync(link, pfx);
  else writeFileSync(pfx, Buffer.from(link, "base64"));
  const { getSignToolPath } = require("app-builder-lib/out/toolsets/windows");
  const signtool = await getSignToolPath(undefined, true);
  process.on("exit", () => rmSync(pfx, { force: true }));
  return (file) => {
    const signed = spawnSync(signtool.path, ["sign", "/f", pfx, "/p", password, "/fd", "sha256", "/tr", "http://timestamp.digicert.com", "/td", "sha256", "/d", "Zuna", file], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...(signtool.env ?? {}) } });
    if (signed.status !== 0) {
      console.error(`Signing ${file} failed.`);
      process.exit(signed.status ?? 1);
    }
  };
}

/** An ICO of the desktop's PNG sizes, which Windows has read since Vista. */
function ico(folder) {
  const images = [16, 24, 32, 48, 64, 128, 256].map((size) => [size, join(folder, `${size}x${size}.png`)]).filter(([, path]) => existsSync(path)).map(([size, path]) => [size, readFileSync(path)]);
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, bytes], index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(bytes.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...images.map(([, bytes]) => bytes)]);
}
