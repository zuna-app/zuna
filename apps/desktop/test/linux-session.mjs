// What the checks of the native app on Linux share: building it, a session bus, KWin and
// folders of their own, so nothing they start reaches the person's desktop, a keyring, the
// driver (test/driver) with its stand-ins for the desktop's services, a test server, and
// screenshots. A check calls `outside` first, which builds and runs the check again inside
// its own session bus, and then `inside`.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ensureFfmpeg, nativeAppDeps } from "../../../scripts/ffmpeg.mjs";
import { ensureWebrtcSys } from "../../../scripts/webrtc-sys.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
export const crate = join(here, "..");
export const root = join(crate, "..", "..");
// The inside's XDG_CACHE_HOME is the check's own, so it's told where the builds are.
export const target = process.env.ZUNA_CHECK_TARGET || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");
export const appBinary = join(target, "debug", "zuna");
export const driverBinary = join(target, "debug", "zuna-test-driver");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Outside: builds everything, then runs the check again inside a session bus of its own,
 * and exits with how that went. Inside, it returns at once.
 */
export async function outside(script) {
  if (process.env.ZUNA_LINUX_CHECK_INNER === "1") return;
  if (process.platform !== "linux") {
    console.log("This checks the native app on Linux.");
    process.exit(0);
  }
  execFileSync(process.execPath, [join(crate, "core-bundle", "build.mjs")], { stdio: "inherit", cwd: root });
  // The FFmpeg the app's media links to, as scripts/linux-app.mjs makes sure of.
  await ensureFfmpeg(nativeAppDeps);
  await ensureWebrtcSys(nativeAppDeps);
  execFileSync("cargo", ["build"], { stdio: "inherit", cwd: crate, env: { ...process.env, CARGO_TARGET_DIR: target } });
  execFileSync("cargo", ["build"], { stdio: "inherit", cwd: join(here, "driver"), env: { ...process.env, CARGO_TARGET_DIR: target } });
  const server = join(tmpdir(), "zuna-linux-check-server");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", server, "./cmd/zuna-server"], { stdio: "inherit", cwd: join(root, "server") });
  const webHost = join(tmpdir(), "zuna-linux-check-web");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", webHost, "./cmd/zuna-web"], { stdio: "inherit", cwd: join(root, "server") });
  // Each run is marked, as what the session bus starts for the portals outlives it.
  const run = `${process.pid}-${Date.now()}`;
  // Folders of its own, given to the session bus itself, so that everything it starts, the
  // portals, a keyring, KWallet, touches nothing of the person's: a service the bus starts
  // has the bus's environment, not the caller's.
  const work = mkdtempSync(join(tmpdir(), "zuna-linux-check-"));
  const xdg = Object.fromEntries(["config", "data", "cache", "state"].map((name) => [`XDG_${name.toUpperCase()}_HOME`, join(work, name)]));
  for (const dir of Object.values(xdg)) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ...xdg, MANGOHUD: "0", DISABLE_MANGOHUD: "1", XDG_CURRENT_DESKTOP: "KDE", WAYLAND_DISPLAY: `zuna-check-${run}` };
  delete env.DISPLAY;
  const inner = spawnSync("dbus-run-session", ["--", process.execPath, fileURLToPath(script), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...env, ZUNA_LINUX_CHECK_INNER: "1", ZUNA_LINUX_CHECK_RUN: run, ZUNA_LINUX_CHECK_WORK: work, ZUNA_CHECK_SERVER_BINARY: server, ZUNA_CHECK_WEB_BINARY: webHost, ZUNA_CHECK_TARGET: target },
  });
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`ZUNA_LINUX_CHECK_RUN=${run}`)) process.kill(Number(pid));
    } catch {}
  }
  rmSync(work, { recursive: true, force: true });
  process.exit(inner.status ?? 1);
}

/** The loudest sample in a WAV file of 16-bit samples, from 0 to 1. */
export function peakOf(file) {
  const bytes = readFileSync(file);
  const data = bytes.indexOf("data", 12);
  let peak = 0;
  for (let at = data + 8; at + 1 < bytes.length; at += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(at)) / 32768);
  return peak;
}

export async function until(condition, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Inside: KWin, a keyring, the driver and everything a check needs. */
export async function inside({ shots: shotsDir, width = 1400, height = 900, globalShortcuts = false } = {}) {
  const shots = shotsDir ?? mkdtempSync(join(tmpdir(), "zuna-linux-shots-"));
  mkdirSync(shots, { recursive: true });
  const work = process.env.ZUNA_LINUX_CHECK_WORK;
  const socket = process.env.WAYLAND_DISPLAY;

  // The folders the outside gave the session bus, KWin and everything else.
  const xdg = Object.fromEntries(["config", "data", "cache", "state"].map((name) => [`XDG_${name.toUpperCase()}_HOME`, join(work, name)]));
  const applications = join(xdg.XDG_DATA_HOME, "applications");
  mkdirSync(applications, { recursive: true });
  writeFileSync(
    join(applications, "zuna-test-driver.desktop"),
    `[Desktop Entry]\nType=Application\nName=Zuna test driver\nExec=${driverBinary}\nNoDisplay=true\nX-KDE-Wayland-Interfaces=org_kde_kwin_fake_input,org_kde_plasma_window_management\n`,
  );
  writeFileSync(join(applications, "zuna.desktop"), `[Desktop Entry]\nType=Application\nName=Zuna\nExec=${appBinary} %u\nIcon=zuna\nMimeType=x-scheme-handler/zuna;\n`);
  // Animations off, as the desktop's setting, which KWin's own animations heed too.
  writeFileSync(join(xdg.XDG_CONFIG_HOME, "kdeglobals"), "[KDE]\nAnimationDurationFactor=0\n");
  /**
   * Whether KWin draws windows' frames, or leaves them to each window, as GNOME's Mutter does.
   * KWin has no switch for that, but with a decoration theme that isn't there it falls back to
   * the window's own, and it takes either at once when told to reconfigure. Without frames
   * until a check asks, whatever the person's own theme, which Plasma hands on through
   * `XDG_CONFIG_DIRS`.
   */
  const kwinrc = (frames) =>
    writeFileSync(join(xdg.XDG_CONFIG_HOME, "kwinrc"), `[org.kde.kdecoration2]\n${frames ? "library=org.kde.breeze\n" : "library=org.kde.kwin.aurorae.v2\ntheme=__aurorae__svg__zuna-check-none\n"}`);
  kwinrc(false);
  // The GPU overlays some systems put over every Vulkan program would be in each screenshot.
  const quiet = { MANGOHUD: "0", DISABLE_MANGOHUD: "1" };
  const base = { ...process.env, ...xdg, ...quiet };
  delete base.WAYLAND_DISPLAY;
  execFileSync("kbuildsycoca6", [], { env: base, stdio: "ignore" });

  const failures = [];
  function check(name, passed, detail = "") {
    console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!passed) failures.push(name);
  }

  const children = [];
  function start(command, args, env, name, cwd) {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    child.output = "";
    child.stdout.on("data", (chunk) => (child.output += chunk));
    child.stderr.on("data", (chunk) => (child.output += chunk));
    child.label = name;
    children.push(child);
    return child;
  }

  // KWin's own shortcuts would take keys the checks type, unless one checks the portal's.
  start("kwin_wayland", ["--virtual", "--socket", socket, "--width", String(width), "--height", String(height), "--no-lockscreen", ...(globalShortcuts ? [] : ["--no-global-shortcuts"])], base, "kwin");
  await until(() => existsSync(join(process.env.XDG_RUNTIME_DIR, socket)), "KWin's socket");
  const session = { ...base, WAYLAND_DISPLAY: socket };

  /** Breeze's frames on every window from now on, or none. */
  function kwinFrames(frames) {
    kwinrc(frames);
    spawnSync("dbus-send", ["--session", "--dest=org.kde.KWin", "--type=method_call", "/KWin", "org.kde.KWin.reconfigure"], { env: session, stdio: "ignore", timeout: 10_000 });
  }

  /** A screenshot of the whole KWin, taken by Spectacle inside it. */
  async function shot(name) {
    const file = join(shots, `${name}.png`);
    spawnSync("spectacle", ["-b", "-n", "-f", "-o", file], { env: session, stdio: "ignore", timeout: 15_000 });
    return file;
  }

  function clipboard() {
    const read = spawnSync("wl-paste", ["-n"], { env: session, encoding: "utf8", timeout: 3_000 });
    return read.status === 0 ? read.stdout : "";
  }

  /** Main-thread wakeups a second, and the share of a core, over a while with nothing happening. */
  async function idleCost(pid, seconds) {
    const ticks = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ").slice(11, 13).reduce((sum, value) => sum + Number(value), 0);
    const switches = () =>
      readFileSync(`/proc/${pid}/task/${pid}/status`, "utf8")
        .split("\n")
        .filter((line) => line.includes("ctxt_switches"))
        .reduce((sum, line) => sum + Number(line.split(/\s+/)[1]), 0);
    const [t0, s0] = [ticks(), switches()];
    await sleep(seconds * 1000);
    const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
    return { wakeups: Math.round((switches() - s0) / seconds), cpu: ((ticks() - t0) / hz / seconds) * 100 };
  }

  const modules = [];
  /** Speakers nobody hears, on the person's own PipeWire, which go as the check finishes: their node's name. */
  function quietSpeakers(label) {
    const name = `zuna_check_${label}_${process.pid}`;
    const loaded = spawnSync("pactl", ["load-module", "module-null-sink", `sink_name=${name}`, `sink_properties=device.description=Zuna_check_${label}`], { encoding: "utf8" });
    if (loaded.status !== 0) throw new Error(`pactl couldn't make ${name}: ${loaded.stderr}`);
    modules.push(loaded.stdout.trim());
    return name;
  }

  /** What a sink plays over some seconds, recorded from its monitor: the loudest of it, from 0 to 1. */
  function loudestOn(sink, seconds) {
    const file = join(work, `${sink}-${Date.now()}.wav`);
    return new Promise((resolve) => {
      // SIGINT, as pw-record only finishes the file's header when it's stopped that way.
      const recording = spawn("timeout", ["-s", "INT", String(seconds), "pw-record", "--target", sink, "-P", "{ stream.capture.sink = true }", file], { stdio: "ignore" });
      recording.on("exit", () => resolve(existsSync(file) ? peakOf(file) : 0));
    });
  }

  /** A test server, and its setup link for the owner's account. */
  async function startServer(extra = []) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const url = `http://127.0.0.1:${port}`;
    const server = start(process.env.ZUNA_CHECK_SERVER_BINARY, ["--listen", `127.0.0.1:${port}`, "--data", join(work, "server"), "--public-url", url, "--auth-burst", "1000", ...extra], base, "server");
    const setupLink = await until(() => server.output.match(/http:\/\/\S+\/invite\/\S+/)?.[0], "the server's setup link");
    return { port, url, setupLink, server };
  }

  /** The built web app (npm run build -w @zuna/web), served by a zuna-web of its own, at an address a browser counts as secure. */
  async function startWebHost() {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const host = start(process.env.ZUNA_CHECK_WEB_BINARY, ["--listen", `127.0.0.1:${port}`, "--root", join(root, "apps", "web", "dist"), "--dev"], base, "zuna-web");
    await until(() => host.output.includes("Listening on"), "zuna-web");
    return { url: `http://localhost:${port}/` };
  }

  /** The Secret Service, unlocked with a throwaway password, as a desktop's keyring is at login. */
  async function startKeyring() {
    const keyring = start("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], session, "keyring");
    keyring.stdin.end(`linux-check-${process.pid}-keyring`);
    const owned = (name) => spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", name], { env: session, encoding: "utf8" }).stdout.includes("true");
    return !!(await until(() => owned("org.freedesktop.secrets"), "the keyring", 10_000).catch(() => false));
  }

  /** The driver, with its stand-ins for the desktop's services, which have to be there before the app looks. */
  async function startDriver() {
    const driver = start(driverBinary, [], session, "driver");
    const answers = createInterface({ input: driver.stdout });
    const waiting = [];
    const events = [];
    answers.on("line", (line) => {
      const said = JSON.parse(line);
      if (said.event) events.push(said.event);
      else waiting.shift()?.(said);
    });
    await until(() => driver.output.includes('"ready"'), "the driver");
    // Input is followed by a moment for the app to draw what it changed, as a person would wait.
    // A driver that stops answering fails the step after 30 seconds, rather than holding the check.
    const drive = async (command) => {
      const answer = await Promise.race([
        new Promise((resolve) => {
          waiting.push(resolve);
          driver.stdin.write(`${JSON.stringify(command)}\n`);
        }),
        new Promise((resolve) => setTimeout(() => resolve({ error: "timed out" }), 30_000).unref()),
      ]);
      if (["click", "key", "press", "type", "drag"].includes(command.do)) await sleep(250);
      return answer;
    };
    const windowOf = async () => (await drive({ do: "windows" })).windows?.find((window) => window.appId === "zuna");
    const heardEvent = (match, timeoutMs = 10_000, after = 0) => until(() => events.slice(after).find(match), "an event", timeoutMs).catch(() => null);
    return { drive, windowOf, events, heardEvent };
  }

  /** The app's core without a window, as a development build checks it. */
  function core(dataDir, args, env = {}) {
    const run = spawnSync(appBinary, ["--core-check", ...args], { env: { ...session, ZUNA_DATA_DIR: dataDir, RUST_LOG: "error", ...env }, encoding: "utf8", timeout: 120_000 });
    if (run.status !== 0) throw new Error(`--core-check ${args[0]}: ${run.stderr.trim().split("\n").pop()}`);
    return JSON.parse(run.stdout);
  }

  /** Kills what the check started, and says how it went. */
  let finishing = null;
  function finish(error) {
    finishing ??= finishOnce(error);
    return finishing;
  }

  async function finishOnce(error) {
    if (error) {
      failures.push(String(error));
      console.error(error);
    }
    if (failures.length) {
      for (const child of children) console.error(`--- ${child.label}${child.exitCode !== null ? ` (exited ${child.exitCode ?? child.signalCode})` : ""} ---\n${child.output.split("\n").slice(-15).join("\n")}`);
    }
    for (const child of children.reverse()) child.kill();
    for (const module of modules) spawnSync("pactl", ["unload-module", module]);
    await sleep(500);
    console.log(`\nScreenshots in ${shots}`);
    if (failures.length) {
      console.log(`${failures.length} failed: ${failures.join("; ")}`);
      process.exit(1);
    }
    console.log("All passed.");
    // Whatever a check left listening, such as a TLS front, goes with it.
    process.exit(0);
  }

  // Stopped by hand, or by an error nothing caught: the KWin, the keyring and the sinks loaded
  // into the person's own PipeWire go all the same.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void finish(`stopped by ${signal}`));
  process.once("uncaughtException", (error) => void finish(error));

  return { work, xdg, base, session, shots, check, failures, start, shot, kwinFrames, clipboard, idleCost, quietSpeakers, loudestOn, startServer, startWebHost, startKeyring, startDriver, core, finish };
}
