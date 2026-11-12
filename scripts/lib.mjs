import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The version every app is released with: the root package.json's. */
export const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

/**
 * What a release build of the native app is stamped with, as its environment: the version, its
 * build number, which is how many commits it has behind it and what an update is compared by,
 * and the channel its updates come from. A release's workflow sets the last two, and a build
 * made here is a nightly of this checkout. Development builds aren't stamped, so that a commit
 * doesn't rebuild them.
 */
export function appStamp() {
  const count = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" });
  const build = process.env.ZUNA_BUILD ?? (count.status === 0 ? count.stdout.trim() : "0");
  return { ZUNA_VERSION: appVersion, ZUNA_BUILD: build, ZUNA_CHANNEL: process.env.ZUNA_CHANNEL ?? "nightly" };
}

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

/**
 * What LiveKit is configured with beyond its defaults, as its --config-body. Change it with the
 * same in `deploy/docker-compose.yml`, `deploy/docker-compose.proxy.yml` and `deploy/update.sh`,
 * which can't read this.
 *
 * LiveKit's codecs, with H.264's Baseline profile as well as Constrained Baseline. Chromium on
 * macOS only encodes Baseline on the GPU, through VideoToolbox, and offers it first, so a share
 * goes out in hardware. LiveKit only takes a profile beyond its defaults by its exact fmtp line.
 *
 * And how many of a video's packets it keeps to send again to someone who lost one: 4,096, where
 * it keeps 500 by itself, which is a third of a second of a share at 15 Mbit/s and an eighth at
 * 40, less than asking again takes (docs/SCREEN_SHARE.md, "Lost packets"). `rtc` comes last, so
 * that a check can put its own ports under it.
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
rtc:
  packet_buffer_size_video: 4096
`;

/**
 * Where LiveKit is built from: the commit `deploy/livekit/version` names, with Zuna's patch, which
 * keeps what LiveKit learns about the people who join out of its log (docs/VOICE_LOGS_PLAN.md).
 */
const liveKitDir = join(root, "deploy", "livekit");

/**
 * A LiveKit server for development, built as `deploy/livekit/build.sh` builds it for servers, and
 * again when its commit or the patch changes: the same steps, in Node, so that they run on Windows
 * too. Change both together. It's stripped, since Windows Defender quarantines Go binaries with
 * debug symbols.
 */
export function ensureLiveKit() {
  const name = process.platform === "win32" ? "livekit-server.exe" : "livekit-server";
  const binary = join(devData, "bin", name);
  const stamp = `${binary}.tag`;
  const [tag, commit, toolchain] = readFileSync(join(liveKitDir, "version"), "utf8").trim().split(/\s+/);
  const patch = join(liveKitDir, "zuna.patch");
  const patchHash = createHash("sha256").update(readFileSync(patch)).digest("hex").slice(0, 12);
  const wanted = `${commit} ${patchHash}`;
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8") === wanted) return binary;
  mkdirSync(dirname(binary), { recursive: true });
  console.log(`Building LiveKit ${tag} with Zuna's patch, which only happens when either changes...`);
  const source = join(devData, "livekit-src");
  const writable = (path) => {
    chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644);
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) writable(join(path, entry));
  };
  const remove = () => {
    if (existsSync(source)) writable(source);
    rmSync(source, { recursive: true, force: true });
  };
  remove();
  mkdirSync(source, { recursive: true });
  // LiveKit's go.mod names no toolchain, so a Go older than the one it asks for would fetch the
  // first release of that, without its fixes. Without cgo, as servers build it, but on macOS,
  // where the CPU statistics LiveKit's protocol module reads only build with it.
  const goEnv = { ...env, GOTOOLCHAIN: `${toolchain}+auto`, CGO_ENABLED: process.platform === "darwin" ? "1" : "0" };
  const inSource = { cwd: source, env: goEnv };
  // That commit and no other, as a tag can be moved.
  run("git", ["init", "--quiet"], inSource);
  run("git", ["fetch", "--quiet", "--depth", "1", "https://github.com/livekit/livekit", commit], inSource);
  // With its lines ending as LiveKit's do, which the patch's do too: a Windows whose git turns
  // them into CRLF on the way out would have a checkout the patch doesn't apply to.
  run("git", ["-c", "advice.detachedHead=false", "-c", "core.autocrlf=false", "checkout", "--quiet", "FETCH_HEAD"], inSource);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { ...inSource, encoding: "utf8" }).stdout.trim();
  if (head !== commit) throw new Error(`Fetched LiveKit ${head}, not ${commit}`);
  // The patch reaches into LiveKit's protocol module, so a copy of it from Go's module cache,
  // where go.sum has checked it, takes its place.
  run("go", ["mod", "download", "github.com/livekit/protocol"], inSource);
  const protocol = spawnSync("go", ["list", "-m", "-f", "{{.Dir}}", "github.com/livekit/protocol"], { ...inSource, encoding: "utf8" }).stdout.trim();
  cpSync(protocol, join(source, "zuna-protocol"), { recursive: true });
  writable(join(source, "zuna-protocol"));
  run("go", ["mod", "edit", "-replace", "github.com/livekit/protocol=./zuna-protocol"], inSource);
  run("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", patch], inSource);
  // What shows the patch reached what it was for, as build.sh checks.
  const reached = [
    ["zuna-protocol/logger/zaputil/zaputil.go", "enc zunaEncoder"],
    ["zuna-protocol/logger/zaputil/zaputil.go", "zunaCore{zapcore.NewCore"],
    ["zuna-protocol/logger/zaputil/zuna.go", "func (e zunaEncoder) EncodeEntry"],
    ["pkg/service/server.go", "zunaRecovery(),"],
    ["cmd/server/main.go", '"-zuna." + zunaPatch'],
    ["pkg/service/roommanager.go", "Zuna: apps are given no outside STUN servers"],
  ];
  for (const [file, mark] of reached) {
    if (!readFileSync(join(source, file), "utf8").includes(mark)) throw new Error(`${patch} didn't reach ${file} in LiveKit ${tag}`);
  }
  // A logger of LiveKit's own that writes past the encoder, which these would make.
  const pastTheFilter = [];
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go") && /\.(WithTee|ToZap|FromZapLogger)\(/.test(readFileSync(path, "utf8"))) pastTheFilter.push(path);
    }
  };
  scan(join(source, "pkg"));
  scan(join(source, "cmd"));
  if (pastTheFilter.length) throw new Error(`LiveKit ${tag} logs past Zuna's filter in ${pastTheFilter.join(", ")}`);
  run("go", ["build", "-buildvcs=false", "-trimpath", "-ldflags", `-s -w -buildid= -X main.zunaPatch=${patchHash}`, "-o", binary, "./cmd/server"], inSource);
  const said = spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim();
  if (!said.endsWith(`${tag.slice(1)}-zuna.${patchHash}`)) throw new Error(`The LiveKit just built says it's "${said}"`);
  remove();
  writeFileSync(stamp, wanted);
  return binary;
}

/** The keys Zuna's patch lets through LiveKit's log, read from the patch's `zunaKeys`. */
export function liveKitLogKeys() {
  const patch = readFileSync(join(liveKitDir, "zuna.patch"), "utf8");
  const list = patch.match(/^\+var zunaKeys = map\[string\]bool\{$([\s\S]*?)^\+\}$/m)?.[1];
  if (!list) throw new Error("deploy/livekit/zuna.patch has no zunaKeys");
  return new Set([...list.matchAll(/"([^"]+)": true/g)].map((match) => match[1]));
}

/**
 * What's wrong with what a LiveKit from `ensureLiveKit` wrote while people joined it, started with
 * --dev, which logs at debug in the console's format: a key that isn't on the patch's list, or
 * anything that points at a person or their device, which are this machine's addresses, the
 * system's name and the device's model, any of Zuna's IDs, which are all 32 hex digits, and what
 * an ICE candidate or an SDP holds. A log without LiveKit's own ID for a participant has nothing
 * in it to check. Lines are picked by the fields that end them, as those from Go's log package
 * have no logger's name.
 */
export function liveKitLogProblems(output) {
  const keys = liveKitLogKeys();
  const problems = [];
  let participants = 0;
  for (const line of output.split("\n")) {
    const at = line.indexOf("\t{");
    if (at < 0) continue;
    let fields;
    try {
      fields = JSON.parse(line.slice(at + 1));
    } catch {
      problems.push(`fields that aren't JSON: ${line}`);
      continue;
    }
    for (const key of Object.keys(fields)) if (!keys.has(key)) problems.push(`"${key}" isn't on the patch's list: ${line}`);
    if (typeof fields.participantID === "string" && fields.participantID.startsWith("PA_")) participants++;
  }
  if (!participants) problems.push("no line names a participantID, so there was nothing to check");
  // What LiveKit found for itself as it started stays.
  const text = output.replace(/"nodeIP": "[^"]*"/g, "");
  const read = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const system = read("/etc/os-release").match(/^NAME="?([^"\n]+)"?$/m)?.[1];
  const model = read("/sys/class/dmi/id/product_name").trim();
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((item) => !item.internal)
    .map((item) => item.address);
  for (const [what, value] of [...addresses.map((address) => ["this machine's address", address]), ["the system's name", system], ["the device's model", model]]) {
    if (value && text.includes(value)) problems.push(`${what}, ${value}`);
  }
  const id = text.match(/[0-9a-f]{32}/i)?.[0];
  if (id) problems.push(`one of Zuna's IDs, ${id}`);
  for (const [what, pattern] of [["an ICE candidate", /candidate:\d|typ (host|srflx|prflx|relay)/], ["an SDP", /a=(ice-ufrag|ice-pwd|fingerprint):/]]) {
    const found = text.match(pattern)?.[0];
    if (found) problems.push(`${what}: ${found}`);
  }
  return problems;
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
