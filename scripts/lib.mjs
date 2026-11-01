import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
export const devWorld = join(devData, "world");
export const devWorldFile = join(devWorld, "world.json");

/** Installs and builds whatever is missing, so a new checkout just works. */
export function ensureBuilt() {
  if (!existsSync(join(root, "node_modules"))) {
    const result = spawnSync("npm install", { shell: true, stdio: "inherit", cwd: root });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (!existsSync(join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm"))) {
    run(process.execPath, [join(root, "scripts", "build-crypto.mjs")]);
  }
}

/** The LiveKit server voice channels use. Update this, `deploy/docker-compose.voice.yml` and `LIVEKIT_VERSION` in `deploy/update.sh` together. */
export const LIVEKIT_TAG = "v1.13.11";

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
