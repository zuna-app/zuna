// The computer's sound going with a screen share on Linux, which the native program
// captures from PipeWire. Drives two real Electron apps against a real server and a
// real LiveKit, with players that go to no speaker, so nothing here can be heard, and
// checks what reaches someone watching: everything but Zuna, one app alone, and by
// default the app whose window is shared.
//
//   npm run build:screenshare && npm run build -w @zuna/desktop && node apps/desktop/test/sound-check.mjs [screenshot-dir]
//
// Zuna's own sound is stood in for by a player the app starts itself, which is how
// Chromium plays: from a process under the app's. The window shared is the other app's,
// which plays a tone of its own the same way. The apps run on X11 and share a window,
// since on Wayland listing what can be shared asks the person through the portal. Anything
// else playing on the computer goes into the share as well, so it's best run in quiet.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { ensureLiveKit } from "../../../scripts/lib.mjs";

if (process.platform !== "linux") {
  console.log("Zuna only captures the computer's sound itself on Linux, so there's nothing to check here.");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-sound-"));
mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

// --- Players nobody hears ---

/** A tone as a stereo WAV, at this frequency and peak. */
function tone(path, frequency, peak, seconds = 120) {
  const rate = 48000;
  const data = Buffer.alloc(rate * seconds * 4);
  for (let index = 0; index < rate * seconds; index++) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * peak * 32767);
    data.writeInt16LE(sample, index * 4);
    data.writeInt16LE(sample, index * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const fixtures = mkdtempSync(join(tmpdir(), "zuna-sound-tones-"));
const loudPath = join(fixtures, "own.wav");
const aPath = join(fixtures, "a.wav");
const bPath = join(fixtures, "b.wav");
const windowPath = join(fixtures, "window.wav");
tone(loudPath, 1500, 0.8);
tone(aPath, 1000, 0.05);
tone(bPath, 2000, 0.02);
tone(windowPath, 2500, 0.035);

// "--target 0" links a player to nothing, so it's silent until the share links it in.
const players = [];
const play = (name, file) => {
  const player = spawn("pw-play", ["--target", "0", "-P", `application.name=${name}`, file], { stdio: "ignore" });
  players.push(player);
  return player;
};

// --- A server and a media server ---

const goBin = [join(homedir(), "go", "bin")];
const pathEnv = { ...process.env, PATH: [...goBin, process.env.PATH ?? ""].join(delimiter) };
const binary = join(tmpdir(), "zuna-sound-server");
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], { cwd: join(root, "server"), env: pathEnv, stdio: "inherit" });

const liveKitPort = 17890;
const liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort)], { stdio: "ignore" });
const data = mkdtempSync(join(tmpdir(), "zuna-sound-data-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--data", data, "--public-url", url, "--auth-burst", "1000", "--livekit-url", `ws://127.0.0.1:${liveKitPort}`, "--livekit-internal-url", `http://127.0.0.1:${liveKitPort}`, "--livekit-key", "devkey", "--livekit-secret", "secret"], { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

async function setupLink() {
  for (let i = 0; i < 200; i++) {
    const match = serverOutput.match(/http:\/\/\S+\/invite\/\S+/);
    if (match) return match[0];
    await sleep(50);
  }
  throw new Error(`the server didn't start:\n${serverOutput}`);
}

// --- Apps ---

const apps = [];
const errors = [];
async function launch(name) {
  const userData = mkdtempSync(join(tmpdir(), `zuna-sound-${name}-`));
  // Neither app plays anything out loud, and both run on X11, where listing screens asks nobody.
  const args = [app, `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio", "--ozone-platform=x11", "--disable-features=WebRtcPipeWireCapturer"];
  const env = { ...process.env, ELECTRON_RENDERER_URL: "", XDG_SESSION_TYPE: "x11" };
  delete env.WAYLAND_DISPLAY;
  const electronApp = await electron.launch({ args, env });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("WebSocket")) errors.push(`${name}: ${text}`);
    if (text.includes("[zuna]") || process.env.VOICE_DEBUG) console.log(`  [${name}] ${message.type()}: ${text}`);
  });
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__connections = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args);
        window.__connections.push(this);
      }
    };
  });
  await page.reload();
  const entry = { name, page, electronApp, userData };
  apps.push(entry);
  return entry;
}

async function signUp({ page }, link, displayName, first) {
  await page.getByLabel("Invite link").fill(link, { timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill(displayName, { timeout: 15_000 });
  if (first === false) await page.getByPlaceholder(/username/i).fill(displayName.toLowerCase()).catch(() => undefined);
  await page.locator('input[type="password"]').fill(`sound-check-Pass-${displayName}-9182`);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  if (first) {
    await page.getByPlaceholder("Our corner of the internet").fill("Friends");
    await page.getByRole("button", { name: "Finish" }).click();
  }
  await page.locator(".server-title").waitFor({ timeout: 20_000 });
}

/** The loudest of everything arriving, listening to the tracks themselves. */
async function loudestArriving(page, seconds = 3) {
  return page.evaluate(async (seconds) => {
    const context = new AudioContext();
    await context.resume();
    const analysers = [];
    for (const connection of window.__connections) {
      if (connection.connectionState === "closed") continue;
      for (const receiver of connection.getReceivers()) {
        if (receiver.track.kind !== "audio" || receiver.track.readyState !== "live") continue;
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(new MediaStream([receiver.track])).connect(analyser);
        analysers.push(analyser);
      }
    }
    let peak = 0;
    const samples = new Float32Array(2048);
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
      for (const analyser of analysers) {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await context.close();
    return peak;
  }, seconds);
}

const capturing = () => {
  try {
    return execFileSync("pgrep", ["-f", "zuna-screenshare --sound"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

const rowFor = (page, name) => page.locator(".channel-row", { hasText: name });

let failed = null;
try {
  const link = await setupLink();
  const alice = await launch("alice");
  const shot = (who, name) => who.page.screenshot({ path: join(shots, `${name}.png`) });

  await signUp(alice, link, "Alice", true);
  await alice.page.locator(".server-title").click();
  await alice.page.getByRole("menuitem", { name: "Invite people" }).click();
  await alice.page.getByRole("button", { name: "Create invite link" }).click();
  const invite = await alice.page.locator(".invite-link span").first().textContent({ timeout: 10_000 });
  await alice.page.keyboard.press("Escape");
  await alice.page.locator(".channel-empty button").click();
  await alice.page.getByRole("button", { name: /^Voice/ }).click();
  await alice.page.getByPlaceholder("Lounge").fill("Lounge");
  await alice.page.getByRole("button", { name: "Create channel" }).click();
  await rowFor(alice.page, "Lounge").waitFor({ timeout: 15_000 });

  const bob = await launch("bob");
  await signUp(bob, invite, "Bob", false);
  await rowFor(bob.page, "Lounge").waitFor({ timeout: 20_000 });

  for (const who of [alice, bob]) {
    await rowFor(who.page, "Lounge").click();
    await who.page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    // Only the share's sound is left to arrive.
    await who.page.getByRole("button", { name: "Mute", exact: true }).first().click();
  }
  await alice.page.locator(".voice-occupant", { hasText: "Bob" }).waitFor({ timeout: 10_000 });

  // Through the browser, since the native capture of a screen asks through the portal.
  await alice.page.getByLabel("Settings", { exact: true }).click();
  await alice.page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
  await alice.page.getByRole("switch", { name: "Capture whole screens on your graphics card" }).click();
  await alice.page.keyboard.press("Escape");

  // What plays: Zuna itself, loud, the app whose window is shared, and two other apps.
  const playInside = (who, name, file) =>
    who.electronApp.evaluate(
      (_electron, { name, file }) => {
        const { spawn } = process.getBuiltinModule("node:child_process");
        globalThis.__ownPlayer = spawn("pw-play", ["--target", "0", "-P", `application.name=${name}`, file], { stdio: "ignore" });
      },
      { name, file },
    );
  await playInside(alice, "ZunaItself", loudPath);
  await playInside(bob, "WindowTone", windowPath);
  play("ToneA", aPath);
  play("ToneB", bPath);
  await sleep(1500);

  const soundChoice = () => alice.page.getByRole("combobox", { name: /^Sound/ });
  // The other app's window: XWayland's screen is the whole of it, which shows little.
  const openPicker = async () => {
    await alice.page.getByRole("button", { name: "Share your screen" }).first().click();
    await alice.page.getByRole("button", { name: "Windows", exact: true }).click();
    await alice.page.locator(".screen-source").first().click({ timeout: 15_000 });
  };
  const share = async (choice) => {
    await openPicker();
    if (choice) await soundChoice().selectOption({ label: choice });
    await alice.page.getByRole("button", { name: "Share", exact: true }).click();
    await alice.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
    await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ timeout: 20_000 });
    await sleep(3000);
  };
  const stop = async () => {
    await alice.page.getByRole("button", { name: "Stop sharing" }).first().click();
    await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ state: "detached", timeout: 15_000 });
    await sleep(2500);
  };

  const picked = () => soundChoice().evaluate((select) => ({ value: select.value, label: select.selectedOptions[0]?.textContent ?? "" }));
  await openPicker();
  await sleep(3500);
  const offered = await soundChoice().locator("option").allTextContents();
  const byDefault = await picked();
  await shot(alice, "01-picker");
  console.log(`  Offered: ${offered.join(", ")}, with ${byDefault.label} (${byDefault.value})`);
  check("the picker offers no sound, the entire system, and each app playing", ["No sound", "Entire system", "ToneA", "ToneB"].every((name) => offered.includes(name)), offered.join(", "));
  check("Zuna's own sound isn't offered", !offered.some((name) => name.includes("ZunaItself")), offered.join(", "));
  check("a window starts with the sound of the app it belongs to", byDefault.value.startsWith("app:pid:"), `${byDefault.label} (${byDefault.value})`);
  check("that app's sound isn't offered twice", !offered.includes("WindowTone"), offered.join(", "));
  await alice.page.getByRole("button", { name: "Screens", exact: true }).click();
  await alice.page.locator(".screen-source").first().click({ timeout: 15_000 });
  const forScreen = await picked();
  check("a screen starts with the entire system's sound", forScreen.value === "everything", `${forScreen.label} (${forScreen.value})`);
  await alice.page.getByRole("button", { name: "Cancel" }).click();

  const quiet = await loudestArriving(bob.page, 2);
  check("before sharing, nothing arrives", quiet < 0.005, `peak ${quiet.toFixed(4)}`);

  await share(null);
  const windowSound = await loudestArriving(bob.page, 3);
  check("by default a window's app's sound reaches someone watching alone", windowSound > 0.025 && windowSound < 0.045, `peak ${windowSound.toFixed(3)}, where that app's is 0.035 and everything 0.9`);
  await stop();

  await share("Entire system");
  const everything = await loudestArriving(bob.page, 3);
  check("the entire system's sound reaches someone watching, and decrypts", everything > 0.04, `peak ${everything.toFixed(3)}`);
  check("Zuna's own sound isn't in it", everything < 0.3, `peak ${everything.toFixed(3)}, where Zuna's own is 0.8`);
  check("it's captured by the native program", capturing() === 1, `${capturing()} running`);
  await shot(bob, "02-watching");
  await stop();
  check("stopping the share stops capturing", capturing() === 0, `${capturing()} running`);

  await share("ToneB");
  const one = await loudestArriving(bob.page, 3);
  check("one app's sound reaches someone watching alone", one > 0.01 && one < 0.035, `peak ${one.toFixed(3)}, where that app's is 0.02 and the rest 0.85`);
  await stop();

  // What was chosen for one share isn't kept for the next.
  await openPicker();
  await sleep(500);
  const next = await picked();
  check("the next share starts from the window's app again", next.value.startsWith("app:pid:"), `${next.label} (${next.value})`);
  // It's the window's app that's chosen, whatever in it is playing at the moment.
  await bob.electronApp.evaluate(() => globalThis.__ownPlayer?.kill());
  await alice.page.getByRole("button", { name: "Cancel" }).click();
  await sleep(1000);
  await openPicker();
  await sleep(500);
  const after = await picked();
  check("a window's app stays chosen as what it plays changes", after.value === next.value, `${after.label} (${after.value})`);
  await shot(alice, "03-picker-after");
  await alice.page.getByRole("button", { name: "Cancel" }).click();

  const realErrors = errors.filter((error) => !error.includes("MissingKey"));
  check("nothing went wrong on the page", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
} catch (error) {
  failed = error;
  console.error(error);
  for (const entry of apps) await entry.page.screenshot({ path: join(shots, `failed-${entry.name}.png`) }).catch(() => undefined);
} finally {
  for (const player of players) player.kill();
  for (const entry of apps) {
    await entry.electronApp.evaluate(() => globalThis.__ownPlayer?.kill()).catch(() => undefined);
    await entry.electronApp.close().catch(() => undefined);
  }
  server.kill();
  liveKit.kill();
  await sleep(300);
  for (const dir of [data, fixtures, ...apps.map((entry) => entry.userData)]) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nScreenshots are in ${shots}`);
if (failed || failures.length > 0) {
  console.error(failed ? "It stopped partway." : `${failures.length} checks failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("All sound checks passed.");
process.exit(0);
