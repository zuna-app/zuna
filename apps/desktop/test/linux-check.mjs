// Drives the native app on Linux in a KWin of its own, against a real server and a real
// client in Node as the other person, checks what it does, and saves screenshots to look
// over. Nothing it starts reaches the person's own desktop: it has its own session bus,
// KWin, folders and data, and KWin only gives the driver (test/driver) its fake input and
// window management because the .desktop file this writes names them.
//
//   node apps/desktop/test/linux-check.mjs [screenshot-dir]

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, "..");
const root = join(crate, "..", "..");
const target = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Outside: build everything, then run the checks again inside a session bus of their own.
if (process.env.ZUNA_LINUX_CHECK_INNER !== "1") {
  if (process.platform !== "linux") {
    console.log("This checks the native app on Linux.");
    process.exit(0);
  }
  execFileSync(process.execPath, [join(crate, "core-bundle", "build.mjs")], { stdio: "inherit", cwd: root });
  execFileSync("cargo", ["build"], { stdio: "inherit", cwd: crate, env: { ...process.env, CARGO_TARGET_DIR: target } });
  execFileSync("cargo", ["build"], { stdio: "inherit", cwd: join(here, "driver"), env: { ...process.env, CARGO_TARGET_DIR: target } });
  const server = join(tmpdir(), "zuna-linux-check-server");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", server, "./cmd/zuna-server"], { stdio: "inherit", cwd: join(root, "server") });
  // Each run is marked, as what the session bus starts for the portals outlives it.
  const run = `${process.pid}-${Date.now()}`;
  const inner = spawnSync("dbus-run-session", ["--", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ZUNA_LINUX_CHECK_INNER: "1", ZUNA_LINUX_CHECK_RUN: run, ZUNA_CHECK_SERVER_BINARY: server },
  });
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`ZUNA_LINUX_CHECK_RUN=${run}`)) process.kill(Number(pid));
    } catch {}
  }
  process.exit(inner.status ?? 1);
}

const appBinary = join(target, "debug", "zuna");
const driverBinary = join(target, "debug", "zuna-test-driver");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-linux-shots-"));
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "zuna-linux-check-"));
const socket = `zuna-check-${process.pid}`;

// Folders of its own, so KWin, its services and the app touch nothing of the person's.
const xdg = Object.fromEntries(["config", "data", "cache", "state"].map((name) => [`XDG_${name.toUpperCase()}_HOME`, join(work, name)]));
for (const dir of Object.values(xdg)) mkdirSync(dir, { recursive: true });
const applications = join(xdg.XDG_DATA_HOME, "applications");
mkdirSync(applications, { recursive: true });
writeFileSync(
  join(applications, "zuna-test-driver.desktop"),
  `[Desktop Entry]\nType=Application\nName=Zuna test driver\nExec=${driverBinary}\nNoDisplay=true\nX-KDE-Wayland-Interfaces=org_kde_kwin_fake_input,org_kde_plasma_window_management\n`,
);
writeFileSync(join(applications, "zuna-native.desktop"), `[Desktop Entry]\nType=Application\nName=Zuna Native\nExec=${appBinary} %u\nIcon=zuna\nMimeType=x-scheme-handler/zuna;\n`);
// The GPU overlays some systems put over every Vulkan program would be in each screenshot.
const quiet = { MANGOHUD: "0", DISABLE_MANGOHUD: "1" };
const base = { ...process.env, ...xdg, ...quiet };
delete base.WAYLAND_DISPLAY;
delete base.DISPLAY;
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

async function until(condition, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const kwin = start("kwin_wayland", ["--virtual", "--socket", socket, "--width", "1400", "--height", "900", "--no-lockscreen", "--no-global-shortcuts"], base, "kwin");
await until(() => existsSync(join(process.env.XDG_RUNTIME_DIR, socket)), "KWin's socket");
const session = { ...base, WAYLAND_DISPLAY: socket };

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

let peer;
try {
  // The server, and its setup link for the owner's account.
  const serverData = join(work, "server");
  const port = 21000 + Math.floor(Math.random() * 20000);
  const url = `http://127.0.0.1:${port}`;
  const server = start(process.env.ZUNA_CHECK_SERVER_BINARY, ["--listen", `127.0.0.1:${port}`, "--data", serverData, "--public-url", url, "--auth-burst", "1000"], base, "server");
  const setupLink = await until(() => server.output.match(/http:\/\/\S+\/invite\/\S+/)?.[0], "the server's setup link");

  // Without Wayland it says so and leaves, rather than running with no window.
  const noWayland = spawnSync(appBinary, [], { env: { ...base, ZUNA_DATA_DIR: join(work, "no-wayland") }, encoding: "utf8", timeout: 20_000 });
  check("without Wayland it says so and exits", noWayland.status === 1 && noWayland.stderr.includes("needs a Wayland session"), `status ${noWayland.status}`);

  // The core without a window, as a development build checks it.
  const coreData = join(work, "core-only");
  const coreCheck = spawnSync(appBinary, ["--core-check", "listServers"], { env: { ...base, ZUNA_DATA_DIR: coreData }, encoding: "utf8", timeout: 60_000 });
  check("--core-check runs the core without a window", coreCheck.status === 0 && coreCheck.stdout.trim() === "[]", coreCheck.stdout.trim() || coreCheck.stderr.trim().split("\n").pop());

  const appData = join(work, "app");
  const app = start(appBinary, [], { ...session, ZUNA_DATA_DIR: appData, RUST_LOG: "warn" }, "app");
  const driver = start(driverBinary, [], session, "driver");
  const answers = createInterface({ input: driver.stdout });
  const waiting = [];
  answers.on("line", (line) => waiting.shift()?.(JSON.parse(line)));
  await until(() => driver.output.includes('"ready"'), "the driver");
  // Input is followed by a moment for the app to draw what it changed, as a person would wait.
  const drive = async (command) => {
    const answer = await new Promise((resolve) => {
      waiting.push(resolve);
      driver.stdin.write(`${JSON.stringify(command)}\n`);
    });
    if (["click", "key", "press", "type", "drag"].includes(command.do)) await sleep(250);
    return answer;
  };
  const windowOf = async () => (await drive({ do: "windows" })).windows?.find((window) => window.appId === "zuna-native");

  // --- The window ---
  const first = await until(windowOf, "the app's window", 30_000);
  check("the window's app ID is its .desktop file's", first.appId === "zuna-native");
  check("the window is named", first.title === "Zuna", first.title);
  await sleep(1500);
  await shot("01-start");

  // The title bar, as Windows gives it: buttons, dragging, a double click, and resizing.
  const bar = (window, x) => ({ x: window.x + x, y: window.y + 16 });
  const button = (window, fromRight) => ({ x: window.x + window.width - fromRight, y: window.y + 16 });
  let window = await windowOf();
  await drive({ do: "click", ...button(window, 69) });
  window = await until(async () => ((await windowOf())?.maximized ? windowOf() : null), "maximizing", 5_000).catch(() => windowOf());
  check("the maximize button maximizes", window.maximized);
  await drive({ do: "click", ...button(window, 69) });
  window = await until(async () => ((await windowOf())?.maximized === false ? windowOf() : null), "restoring", 5_000).catch(() => windowOf());
  check("pressing it again restores", !window.maximized);
  await drive({ do: "click", ...bar(window, 300), count: 2 });
  await sleep(600);
  check("a double click on the title bar maximizes", (await windowOf()).maximized);
  window = await windowOf();
  await drive({ do: "click", ...bar(window, 300), count: 2 });
  await sleep(600);
  window = await windowOf();
  check("and another restores", !window.maximized);
  const from = bar(window, 300);
  await drive({ do: "drag", from: [from.x, from.y], to: [from.x - 40, from.y + 30], steps: 12 });
  await sleep(600);
  const moved = await windowOf();
  check("dragging the title bar moves the window", Math.abs(moved.x - window.x + 40) <= 3 && Math.abs(moved.y - window.y - 30) <= 3, `by ${moved.x - window.x},${moved.y - window.y}`);
  const right = { x: moved.x + moved.width + 3, y: moved.y + Math.round(moved.height / 2) };
  await drive({ do: "drag", from: [right.x, right.y], to: [right.x - 80, right.y], steps: 10 });
  await sleep(600);
  const narrower = await windowOf();
  check("dragging the right edge resizes", Math.abs(narrower.width - (moved.width - 80)) <= 3, `${moved.width} to ${narrower.width}`);
  const top = { x: narrower.x + Math.round(narrower.width / 2), y: narrower.y - 3 };
  await drive({ do: "drag", from: [top.x, top.y], to: [top.x, top.y - 20], steps: 10 });
  await sleep(600);
  const taller = await windowOf();
  check("dragging the top edge resizes", Math.abs(taller.height - (narrower.height + 20)) <= 3 && Math.abs(taller.y - (narrower.y - 20)) <= 3, `${narrower.height} to ${taller.height}`);
  await drive({ do: "click", ...button(taller, 115) });
  await sleep(600);
  check("the minimize button minimizes", (await windowOf()).minimized);
  await drive({ do: "restore", appId: "zuna-native" });
  await sleep(600);
  check("and the taskbar brings it back", !(await windowOf()).minimized);
  await drive({ do: "click", ...button(await windowOf(), 23) });
  await sleep(600);
  const closed = await windowOf();
  check("closing keeps it running, minimized, as it's on to the tray", !!closed && closed.minimized && app.exitCode === null);
  await drive({ do: "restore", appId: "zuna-native" });
  await sleep(600);
  // Maximized from here on, so where things are is the same each run.
  await drive({ do: "click", ...bar(await windowOf(), 300), count: 2 });
  await sleep(800);
  check("maximized for the rest", (await windowOf()).maximized);

  // --- Onboarding, as the server's owner ---
  await drive({ do: "click", x: 700, y: 535 });
  await sleep(600);
  await shot("02-invite");
  await drive({ do: "type", text: setupLink });
  await drive({ do: "key", key: "enter" });
  await sleep(2000);
  await shot("03-owner");
  const password = `linux-check-${process.pid}-owner`;
  await drive({ do: "click", x: 700, y: 328 });
  await drive({ do: "type", text: "Linux Owner" });
  await drive({ do: "click", x: 700, y: 405 });
  await drive({ do: "press", keys: ["ctrl", "a"] });
  await drive({ do: "type", text: "owner" });
  await drive({ do: "click", x: 680, y: 505 });
  await drive({ do: "type", text: password });
  await drive({ do: "click", x: 680, y: 603 });
  await drive({ do: "type", text: password });
  await sleep(300);
  await shot("04-owner-filled");
  await drive({ do: "click", x: 700, y: 749 });
  // The recovery key, copied to Wayland's clipboard once the account is made.
  const recovery = await until(async () => {
    await drive({ do: "click", x: 607, y: 538 });
    await sleep(500);
    return /^([A-Z0-9]{4}-){9}[A-Z0-9]{4}$/.test(clipboard().trim()) ? clipboard().trim() : null;
  }, "the recovery key to be copied", 60_000).catch(() => null);
  check("the account is made, and Copy puts its recovery key on the clipboard", !!recovery);
  await shot("05-recovery-key");
  await drive({ do: "click", x: 529, y: 582 });
  await drive({ do: "click", x: 700, y: 630 });
  await sleep(800);
  await shot("06-name-server");
  await drive({ do: "click", x: 700, y: 491 });
  await drive({ do: "type", text: "Linux Lab" });
  await drive({ do: "click", x: 700, y: 546 });
  await sleep(2500);
  await shot("07-ready");

  // --- An invite, and the other person through it ---
  await drive({ do: "click", x: 123, y: 57 });
  await sleep(500);
  await drive({ do: "click", x: 151, y: 98 });
  await sleep(700);
  await drive({ do: "click", x: 700, y: 540 });
  const invite = await until(() => (/\/invite\/\S+#k=/.test(clipboard()) ? clipboard().trim() : null), "the invite link to be copied", 15_000).catch(() => null);
  check("Create invite link copies a link with its key", !!invite);
  await shot("08-invite-made");
  // Its ×, as Escape only reaches a dialog through a field in it.
  await drive({ do: "click", x: 889, y: 281 });
  peer = start("npx", ["vite-node", join(here, "peer.ts"), invite ?? ""], { ...process.env, ...quiet }, "peer", join(root, "packages", "core"));
  peer.stdout.removeAllListeners("data");
  const heard = [];
  createInterface({ input: peer.stdout }).on("line", (line) => {
    peer.output += `${line}\n`;
    try {
      heard.push(JSON.parse(line));
    } catch {}
  });
  await until(() => heard.some((line) => line.ready), "the other person to join", 90_000);
  peer.stdin.write(`${JSON.stringify({ send: "Hi from Casey" })}\n`);
  await sleep(3000);
  await shot("09-list");

  // --- Chatting ---
  await drive({ do: "click", x: 237, y: 251 });
  await sleep(1000);
  const message = "Hello from Linux, under Wayland!";
  await drive({ do: "type", text: message });
  await drive({ do: "key", key: "enter" });
  const received = await until(() => heard.find((line) => line.received === message), "the message to reach the other person", 20_000).catch(() => null);
  check("a message typed and sent reaches the other person", !!received);
  await sleep(2500);
  await shot("10-chat");

  // --- What the window costs at rest ---
  await drive({ do: "move", x: 900, y: 300 });
  await sleep(2000);
  const rest = await idleCost(app.pid, 5);
  console.log(`INFO  at rest with a chat open: ${rest.wakeups} main-thread wakeups a second, ${rest.cpu.toFixed(1)}% of a core (KWin at 60 Hz)`);
} catch (error) {
  failures.push(String(error));
  console.error(error);
  for (const child of children) if (child.label !== "kwin") console.error(`--- ${child.label} ---\n${child.output.split("\n").slice(-15).join("\n")}`);
} finally {
  for (const child of children.reverse()) child.kill();
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
}

console.log(`\nScreenshots in ${shots}`);
if (failures.length) {
  console.log(`${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("All passed.");
