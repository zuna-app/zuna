// Checks that the app updates itself on Windows, from releases served by this machine and signed
// with keys made for the run: a build is installed, finds a newer one, and pressing Update quits
// it, installs the new build and starts that. Then that everything an update must pass is held
// to: a manifest nobody signed, one the other channel's key signed, a nightly for an app on
// stable, an older build, and a file that was changed are each refused. And that an update
// nobody pressed is installed as the app quits, and one that didn't take is said so.
//
//   node apps/desktop/test/windows-update-check.mjs [--keep] [--built]
//
// It builds the app twice with the `update-check` feature (`npm run dist:windows -- --update-check`),
// as builds 1000 and 1001: only such a build reads its keys and the releases' address from the
// environment, updates wherever it was installed, writes where its updater stands to
// updates/status.json in its data, and keeps its window hidden. Its installers make no
// shortcuts and write nothing to the registry, and are installed into a folder of the run's
// own, so an installed Zuna is left alone. --built uses the installers of an earlier run, and
// --keep leaves the run's folder.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestOf, newKey, signWith, tagOf, windowsInstaller } from "../../../scripts/release.mjs";

if (process.platform !== "win32") {
  console.error("This checks the app's updates on Windows.");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const dist = join(root, "dist", "windows-update-check");
const [OLD, NEW] = [1000, 1001];
const releaseOf = (build, channel = "nightly") => ({ version, channel, build });
const installerOf = (build) => join(dist, windowsInstaller(releaseOf(build)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
function check(what, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

// --- The two builds ---

if (!process.argv.includes("--built")) {
  for (const build of [OLD, NEW]) {
    const built = spawnSync(process.execPath, [join(root, "scripts", "windows-app.mjs"), "dist", "--update-check"], { stdio: "inherit", cwd: root, env: { ...process.env, ZUNA_BUILD: String(build), ZUNA_CHANNEL: "nightly" } });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
}
for (const build of [OLD, NEW]) {
  if (!existsSync(installerOf(build))) {
    console.error(`${installerOf(build)} isn't there. Run this without --built.`);
    process.exit(1);
  }
}

// --- Releases, served from here ---

const keys = { stable: newKey(), nightly: newKey(), stranger: newKey() };
const installer = readFileSync(installerOf(NEW));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What the feed offers right now: releases by tag, each with its files, and which is "latest". */
let feed = { releases: {}, latest: null };

/** A release of the new build's installer, or of whatever `file` is, signed with `signer`. */
function release({ build = NEW, channel = "nightly", signer = keys[channel], file = installer, says = {} }) {
  const described = releaseOf(build, channel);
  const name = windowsInstaller(described);
  const manifest = Buffer.from(manifestOf({ ...described, commit: "0".repeat(40), files: { "windows-x86_64": { name, size: installer.length, sha256: sha256(installer), ...says } } }));
  return { tag: tagOf(described), files: { "update.json": manifest, "update.json.sig": Buffer.from(`${signWith(signer.secret, manifest).signature}\n`), [name]: file } };
}

function offer(...releases) {
  feed = { releases: Object.fromEntries(releases.map((entry) => [entry.tag, entry.files])), latest: releases[0]?.tag ?? null };
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const send = (status, body, type = "application/json") => {
    response.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
    response.end(body);
  };
  if (url.pathname === "/api/releases/latest") {
    return feed.latest ? send(200, Buffer.from(JSON.stringify({ tag_name: feed.latest }))) : send(404, Buffer.from("{}"));
  }
  if (url.pathname === "/api/releases") {
    return send(200, Buffer.from(JSON.stringify(Object.keys(feed.releases).map((tag) => ({ tag_name: tag, prerelease: tag.includes("-nightly."), draft: false })))));
  }
  const [, area, tag, name] = url.pathname.split("/").map(decodeURIComponent);
  const file = area === "download" ? feed.releases[tag]?.[name] : undefined;
  return file ? send(200, file, "application/octet-stream") : send(404, Buffer.from("{}"));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;

// --- The app, installed in a folder of the run's own ---

const work = mkdtempSync(join(tmpdir(), "zuna-update-check-"));
const home = join(work, "app");
const data = join(work, "data");
const exe = join(home, "Zuna.exe");
const status = join(data, "updates", "status.json");
const env = { ...process.env, ZUNA_DATA_DIR: data, ZUNA_UPDATE_FEED: address, ZUNA_UPDATE_STABLE_KEYS: keys.stable.public, ZUNA_UPDATE_NIGHTLY_KEYS: keys.nightly.public, RUST_LOG: "info" };
mkdirSync(join(data, "updates"), { recursive: true });

/** Installs a build quietly into the run's folder, as its installer installs an update. */
function install(build) {
  // NSIS takes the folder last and unquoted.
  spawnSync(installerOf(build), ["/S", `/D=${home}`], { stdio: "ignore", windowsVerbatimArguments: true });
}

/** The build the installed program says it is: the fourth part of its version. */
function installedBuild() {
  const found = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item '${exe}').VersionInfo.FileVersionRaw.Revision`], { encoding: "utf8" });
  return Number(found.stdout?.trim());
}

/** The IDs of the run's own copies that are running. */
function running() {
  const found = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-Process Zuna -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' }).Id -join ','`], { encoding: "utf8" });
  return (found.stdout ?? "").trim().split(",").filter(Boolean).map(Number);
}

async function until(test, seconds, what) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const found = test();
    if (found) return found;
    await sleep(250);
  }
  check(what, false, `not within ${seconds} seconds`);
  return null;
}

const readStatus = () => {
  try {
    return JSON.parse(readFileSync(status, "utf8"));
  } catch {
    return null;
  }
};

/** Starts the installed app and waits for its updater's first look to end. */
async function start(what) {
  rmSync(status, { force: true });
  const log = openSync(join(work, "app.log"), "a");
  spawn(exe, [], { env, detached: true, stdio: ["ignore", log, log] }).unref();
  return await until(() => {
    const found = readStatus();
    return found && found.activity === "idle" && (found.checked || found.problem) ? found : null;
  }, 90, `${what}: the app looks for an update`);
}

async function quit() {
  spawnSync(exe, ["--quit"], { env, stdio: "ignore" });
  await until(() => running().length === 0, 30, "the app quits");
}

async function refuses(what, releases, expected, setting) {
  writeFileSync(join(data, "settings.json"), JSON.stringify(setting ? { updateChannel: setting } : {}));
  offer(...releases);
  const found = await start(what);
  if (found) {
    check(`${what}: nothing is ready to install`, found.ready === null, JSON.stringify(found.ready));
    check(`${what}: ${expected ? `because ${expected}` : "without a word, as nothing's wrong"}`, expected ? `${found.refused ?? ""} ${found.problem ?? ""}`.includes(expected) : found.refused === null && found.problem === null, `refused: ${found.refused}, problem: ${found.problem}`);
  }
  await quit();
}

let failed;
try {
  install(OLD);
  check("the old build installs into the run's own folder", existsSync(exe) && installedBuild() === OLD, `build ${installedBuild()}`);

  // --- Everything an update must pass ---
  await refuses("a manifest nobody signed", [release({ signer: keys.stranger })], "isn't signed with one of Zuna's keys");
  await refuses("a stable release the nightly key signed", [release({ channel: "stable", signer: keys.nightly })], "signed with the other channel's key");
  await refuses("a nightly, for an app on stable", [release({})], "it's a nightly, and this app follows stable releases", "stable");
  await refuses("an older build", [release({ build: OLD - 1 })], null);
  await refuses("this build again", [release({ build: OLD })], null);
  const changed = Buffer.from(installer);
  changed[changed.length >> 1] ^= 1;
  await refuses("a file that was changed", [release({ file: changed })], "the file isn't the one its manifest names");
  await refuses("a file larger than its manifest says", [release({ file: Buffer.concat([installer, Buffer.alloc(1)]) })], "is larger than its manifest says");
  check("none of that changed what's installed", installedBuild() === OLD, `build ${installedBuild()}`);

  // --- An update that didn't take is said so ---
  writeFileSync(join(data, "settings.json"), "{}");
  writeFileSync(join(data, "updates", "installing.json"), JSON.stringify({ build: 9999, version: "9.9.9" }));
  offer();
  const told = await start("after an update that didn't take");
  check("the app says the update couldn't be installed", told?.not_installed === "9.9.9", JSON.stringify(told));
  await quit();

  // --- The button ---
  offer(release({}));
  const ready = await start("a newer build");
  check("the newer build is downloaded, checked and ready, which is when the button shows", ready?.ready?.build === NEW && ready.ready.channel === "nightly", JSON.stringify(ready));
  const before = running();
  rmSync(status, { force: true });
  // Pressing Update, which the hidden window has no pointer for.
  spawnSync(exe, ["--update"], { env, stdio: "ignore" });
  await until(() => before.every((id) => !running().includes(id)), 30, "the app quits to update");
  await until(() => installedBuild() === NEW, 60, "the new build is installed");
  check("the new build is installed", installedBuild() === NEW, `build ${installedBuild()}`);
  const again = await until(() => (running().length > 0 ? running() : null), 60, "the app starts again");
  check("the app started again by itself", !!again);
  const after = await until(() => {
    const found = readStatus();
    return found && found.activity === "idle" && found.checked ? found : null;
  }, 90, "the new build looks for an update");
  check("the new build is up to date, with nothing more to install", after?.ready === null && after?.not_installed === null && after?.problem === null, JSON.stringify(after));
  await quit();

  // --- An update nobody pressed is installed as the app quits ---
  install(OLD);
  check("the old build is back, for the next part", installedBuild() === OLD, `build ${installedBuild()}`);
  const waiting = await start("a newer build, again");
  check("the newer build is ready again", waiting?.ready?.build === NEW, JSON.stringify(waiting));
  await quit();
  await until(() => installedBuild() === NEW, 60, "quitting installs the update");
  check("quitting installed the update", installedBuild() === NEW, `build ${installedBuild()}`);
  await sleep(3000);
  check("and didn't start the app again", running().length === 0);
} catch (error) {
  failed = error;
} finally {
  for (const id of running()) spawnSync("taskkill", ["/PID", String(id), "/F"], { stdio: "ignore" });
  server.close();
  if (process.argv.includes("--keep") || failed || failures) console.log(`> the run's folder, with the app's log, is ${work}`);
  else rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (failed) {
  console.error(failed);
  process.exit(1);
}
console.log(failures ? `\n${failures} failed.` : "\nThe app updates itself, and refuses what it should.");
process.exit(failures ? 1 : 0);
