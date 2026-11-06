import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Tools installed per-user may not be on PATH yet in an already open terminal.
const extraPaths = [
  join(homedir(), ".cargo", "bin"),
  // Homebrew's rustup is keg-only, so it isn't on PATH unless the shell profile adds it.
  "/opt/homebrew/opt/rustup/bin",
  join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"),
].filter((path) => existsSync(path));

export const env = {
  ...process.env,
  PATH: [...extraPaths, process.env.PATH ?? process.env.Path ?? ""].join(delimiter),
};

/** Everything the test server and the development app store. Deleting it starts over. */
export const devData = join(root, ".dev-data");
export const devAppData = join(devData, "app");
/** The native app's development data, as `npm run dev:windows` keeps it. */
export const devNativeAppData = join(devData, "native-app");
export const devWorld = join(devData, "world");
export const devWorldFile = join(devWorld, "world.json");

/** When any of these files last changed, or anything in these folders. */
function lastChanged(paths) {
  let newest = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    newest = Math.max(newest, stat.isDirectory() ? lastChanged(readdirSync(path).map((name) => join(path, name))) : stat.mtimeMs);
  }
  return newest;
}

const lockHash = () => createHash("sha256").update(readFileSync(join(root, "package-lock.json"))).digest("hex");

/** Installs and builds whatever is missing or out of date, so a new checkout or a pull just works. */
export function ensureBuilt() {
  // What was installed goes by the lock file's content, since a pull that leaves it the same still touches it.
  const installed = join(root, "node_modules", ".zuna-installed");
  if (!existsSync(installed) || readFileSync(installed, "utf8") !== lockHash()) {
    const result = spawnSync("npm install", { shell: true, stdio: "inherit", cwd: root });
    if (result.status !== 0) process.exit(result.status ?? 1);
    writeFileSync(installed, lockHash());
  }
  const wasm = join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm");
  const crate = join(root, "crypto");
  if (!existsSync(wasm) || lastChanged([join(crate, "src"), join(crate, "Cargo.toml"), join(crate, "Cargo.lock")]) > statSync(wasm).mtimeMs) {
    run(process.execPath, [join(root, "scripts", "build-crypto.mjs")]);
  }
}

/**
 * Keeps native screen capture current, if it's been built here. The first build is
 * long and needs tools of its own, so that stays something to ask for, and the app
 * shares through Chromium without it. The folder is made anew by each build.
 */
export function ensureNativeScreenCurrent() {
  const crate = join(root, "apps", "screenshare");
  const dist = join(crate, "dist");
  if (!existsSync(dist)) return;
  const sources = ["src", "native", "build.rs", "Cargo.toml", "Cargo.lock"].map((name) => join(crate, name));
  if (lastChanged(sources) <= statSync(dist).mtimeMs) return;
  console.log("Native screen capture changed, so it's being rebuilt...");
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-screenshare.mjs")], { stdio: "inherit", env, cwd: root });
  if (result.status !== 0) console.warn("\nCouldn't rebuild native screen capture, so the app keeps using its last build.\n");
}

/** Long enough for a slow network, short enough not to keep anyone from the app. */
const PULL_TIMEOUT_MS = 20_000;

/**
 * Brings this checkout up to date when that can't get in anyone's way: only with
 * nothing uncommitted, and only as a fast-forward. Failing is no reason not to carry
 * on with what's here, such as being offline.
 */
export function pullLatest() {
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: PULL_TIMEOUT_MS, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  const changes = git("status", "--porcelain", "--untracked-files=no");
  if (changes.status !== 0) return;
  if (changes.stdout.trim()) {
    console.log("Not pulling, since this checkout has uncommitted changes.");
    return;
  }
  const before = git("rev-parse", "HEAD").stdout;
  const pull = git("pull", "--ff-only", "--no-rebase", "--quiet");
  if (pull.status !== 0) {
    const reason = (pull.stderr ?? "").split(/\r?\n/).find((line) => line && !line.startsWith("hint:")) ?? "it took too long";
    console.log(`Couldn't pull, so this uses what's here: ${reason}`);
  } else if (git("rev-parse", "HEAD").stdout !== before) {
    console.log(`Updated to ${git("log", "-1", "--format=%h %s").stdout.trim()}`);
  }
}

/** The LiveKit server voice channels use. Update this, the image in `deploy/docker-compose.yml` and `deploy/docker-compose.proxy.yml`, and `LIVEKIT_VERSION` in `deploy/update.sh` together. */
export const LIVEKIT_TAG = "v1.13.11";

/**
 * What LiveKit is configured with beyond its defaults, as its --config-body. Change it with the
 * same in `deploy/docker-compose.yml`, `deploy/docker-compose.proxy.yml` and `deploy/update.sh`,
 * which can't read this.
 *
 * LiveKit's codecs, with H.264's Baseline profile as well as Constrained Baseline. Chromium on
 * macOS only encodes Baseline on the GPU, through VideoToolbox, and offers it first, so a share
 * goes out in hardware. LiveKit only takes a profile beyond its defaults by its exact fmtp line.
 */
export const LIVEKIT_CONFIG = `room:
  enabled_codecs:
    - mime: audio/opus
    - mime: audio/red
    - mime: audio/pcmu
    - mime: audio/pcma
    - mime: video/vp8
    - mime: video/h264
    - mime: video/h264
      fmtp_line: level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
    - mime: video/vp9
    - mime: video/av1
    - mime: video/h265
    - mime: video/rtx
`;

/**
 * A LiveKit server for development, built from its pinned tag the first time. It's
 * stripped, since Windows Defender quarantines Go binaries with debug symbols.
 */
export function ensureLiveKit() {
  const name = process.platform === "win32" ? "livekit-server.exe" : "livekit-server";
  const binary = join(devData, "bin", name);
  const stamp = `${binary}.tag`;
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8") === LIVEKIT_TAG) return binary;
  mkdirSync(dirname(binary), { recursive: true });
  // The screen sharing proof of concept may already have one.
  const built = join(root, "poc", "screenshare", ".deps", name);
  if (existsSync(built) && existsSync(`${built}.tag`) && readFileSync(`${built}.tag`, "utf8") === LIVEKIT_TAG) {
    copyFileSync(built, binary);
  } else {
    console.log(`Building LiveKit ${LIVEKIT_TAG}, which only happens once...`);
    const source = join(devData, "livekit-src");
    rmSync(source, { recursive: true, force: true });
    run("git", ["clone", "--quiet", "--depth", "1", "--branch", LIVEKIT_TAG, "https://github.com/livekit/livekit", source]);
    run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/server"], { cwd: source });
    rmSync(source, { recursive: true, force: true });
  }
  writeFileSync(stamp, LIVEKIT_TAG);
  return binary;
}

export async function devServerRunning() {
  try {
    const response = await fetch("http://127.0.0.1:8787/healthz", { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

export function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
    cwd: root,
    ...options,
  });
  if (result.error?.code === "ENOENT") {
    console.error(`\n"${command}" was not found. See CONTRIBUTING.md for the tools you need.`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
