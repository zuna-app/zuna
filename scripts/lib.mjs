import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The version every app is released with: the root package.json's. */
export const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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
  // Exactly what it says, as npm ci installs, which leaves the lock file alone, where npm install
  // could rewrite it for this npm, and takes away what's no longer in it.
  const installed = join(root, "node_modules", ".zuna-installed");
  if (!existsSync(installed) || readFileSync(installed, "utf8") !== lockHash()) {
    const result = spawnSync("npm ci", { shell: true, stdio: "inherit", cwd: root });
    if (result.status !== 0) process.exit(result.status ?? 1);
    writeFileSync(installed, lockHash());
  }
  const wasm = join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm");
  const crate = join(root, "crypto");
  if (!existsSync(wasm) || lastChanged([join(crate, "src"), join(crate, "Cargo.toml"), join(crate, "Cargo.lock")]) > statSync(wasm).mtimeMs) {
    run(process.execPath, [join(root, "scripts", "build-crypto.mjs")]);
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
  console.log(`Building LiveKit ${LIVEKIT_TAG}, which only happens once...`);
  const source = join(devData, "livekit-src");
  rmSync(source, { recursive: true, force: true });
  run("git", ["clone", "--quiet", "--depth", "1", "--branch", LIVEKIT_TAG, "https://github.com/livekit/livekit", source]);
  run("go", ["build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", binary, "./cmd/server"], { cwd: source });
  rmSync(source, { recursive: true, force: true });
  writeFileSync(stamp, LIVEKIT_TAG);
  return binary;
}

/**
 * The command that runs a TypeScript file through vite-node: Node with vite-node's own script,
 * wherever its version keeps it, so there's no npx, no shell on Windows and nothing between
 * this and the process to stop. As [command, args].
 */
export function viteNodeArgs(script, ...args) {
  const dir = join(root, "node_modules", "vite-node");
  const bin = join(dir, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).bin["vite-node"]);
  return [process.execPath, [bin, script, ...args]];
}

/** The systems the server and zuna-web are released for, as GOOS and GOARCH. */
export const GO_TARGETS = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["windows", "amd64"],
];

/**
 * Cross-compiles a Go program in server/ for every one of GO_TARGETS, stripped and pure Go,
 * into `outDir` as `<prefix>-<os>-<arch>`, with ZUNA_VERSION as its version.
 */
export function goBuildAll(pkg, outDir, prefix) {
  const version = process.env.ZUNA_VERSION ?? "dev";
  for (const [goos, goarch] of GO_TARGETS) {
    const name = `${prefix}-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
    run("go", ["build", "-trimpath", "-ldflags", `-s -w -buildid= -X main.version=${version}`, "-o", join(outDir, name), pkg], {
      cwd: join(root, "server"),
      env: { ...env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    });
  }
}

export async function devServerRunning() {
  try {
    const response = await fetch("http://127.0.0.1:8787/healthz", { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

const systemNames = { win32: "Windows", linux: "Linux", darwin: "macOS" };
const devScripts = { win32: "npm run dev:windows", linux: "npm run dev:linux", darwin: "npm run dev:macos" };

/**
 * A native app script's command line, `<command> [flags] [-- app args]`, with `run` as the
 * command when none is given. Exits 1 on any system but the one the script builds for, and
 * 2 on a command it doesn't take, rather than building something else.
 */
export function parseAppArgs(platform, commands) {
  if (process.platform !== platform) {
    const here = devScripts[process.platform];
    console.error(`This builds the native app on ${systemNames[platform]}.${here ? ` Here, use ${here}.` : ""}`);
    process.exit(1);
  }
  const [command = "run", ...rest] = process.argv.slice(2);
  if (!commands.includes(command)) {
    console.error(`There's no command "${command}" here. It takes ${commands.join(", ")}.`);
    process.exit(2);
  }
  const split = rest.indexOf("--");
  return { command, flags: split < 0 ? rest : rest.slice(0, split), appArgs: split < 0 ? [] : rest.slice(split + 1) };
}

/** Bundles the client core for the native app's QuickJS, which its build takes in. */
export function bundleCore() {
  run(process.execPath, [join(root, "apps", "desktop", "core-bundle", "build.mjs")]);
}

/** The Rust MSVC toolchain, which builds on Windows need: the native app's and the screen capture's. */
export function msvcToolchain() {
  const list = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8", env });
  if (list.error?.code === "ENOENT") {
    console.error('"rustup" was not found. See CONTRIBUTING.md for the tools you need.');
    process.exit(1);
  }
  const found = (list.stdout ?? "").split("\n").map((line) => line.trim().split(" ")[0]).find((name) => name.endsWith("-pc-windows-msvc"));
  if (!found) {
    console.error("Building on Windows needs a Rust MSVC toolchain: rustup toolchain install stable-x86_64-pc-windows-msvc");
    process.exit(1);
  }
  return found;
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
