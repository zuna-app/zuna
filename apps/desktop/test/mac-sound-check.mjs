// The computer's sound going with a screen share on macOS, which the native program takes
// through Core Audio's process taps. Drives two real Electron apps against a real server
// and a real LiveKit, and checks what reaches someone watching: everything but Zuna, and
// one app alone.
//
//   npm run build:screenshare && npm run build -w @zuna/desktop && node apps/desktop/test/mac-sound-check.mjs [screenshot-dir]
//
// macOS asks once whether an app may record the computer's sound, and remembers the app
// that started the program asking. So the one sharing is started through `open`, which
// makes Electron that app rather than whatever runs this, and is driven over its debugging
// port. The first run waits for that answer. What it shares is a moving picture, as macOS's
// own picker can't be driven. Zuna's own sound is a tone its page plays, and the other apps
// are two small ones built here, each playing a tone through afplay. macOS has no player
// nobody hears, so they're quiet but out loud, and anything else playing on the computer
// goes into the share too: it's best run in quiet.

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, chromium } from "playwright-core";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../scripts/lib.mjs";

if (process.platform !== "darwin") {
  console.log("This checks macOS's sound; sound-check.mjs checks Linux's and win-sound-check.mjs Windows's.");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-mac-sound-"));
mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

// --- Apps that play a tone ---

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

const fixtures = mkdtempSync(join(tmpdir(), "zuna-mac-sound-tones-"));

/** An app of its own, so macOS names the sound it plays after it, as the picker does. */
function toneApp(name, frequency, peak) {
  const wav = join(fixtures, `${name}.wav`);
  tone(wav, frequency, peak);
  const contents = join(fixtures, `${name}.app`, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>chat.zuna.check.${name.toLowerCase()}</string><key>CFBundleName</key><string>${name}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>\n`,
  );
  // A program of its own that starts afplay, rather than a script, which macOS would know by its shell.
  const source = join(fixtures, `${name}.c`);
  writeFileSync(
    source,
    `#include <spawn.h>\n#include <sys/wait.h>\nextern char **environ;\nint main(void) {\n  char *args[] = { "/usr/bin/afplay", ${JSON.stringify(wav)}, 0 };\n  pid_t pid;\n  if (posix_spawn(&pid, args[0], 0, 0, args, environ)) return 1;\n  int status;\n  waitpid(pid, &status, 0);\n  return 0;\n}\n`,
  );
  execFileSync("cc", ["-O2", "-o", join(contents, "MacOS", name), source]);
  return join(fixtures, `${name}.app`);
}

const toneA = toneApp("ToneA", 1000, 0.05);
const toneB = toneApp("ToneB", 2000, 0.02);
const playing = [];
const play = (bundle) => playing.push(spawn("open", ["-n", "-W", bundle], { stdio: "ignore" }));
const stopPlaying = () => {
  try {
    execFileSync("pkill", ["-f", fixtures]);
  } catch {
    // Already done.
  }
};

// --- A server and a media server ---

const goBin = [join(homedir(), "go", "bin")];
const pathEnv = { ...process.env, PATH: [...goBin, process.env.PATH ?? ""].join(delimiter) };
const binary = join(tmpdir(), "zuna-mac-sound-server");
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], { cwd: join(root, "server"), env: pathEnv, stdio: "inherit" });

const liveKitPort = 17895;
const liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort), "--config-body", LIVEKIT_CONFIG], { stdio: ["ignore", "pipe", "pipe"] });
const liveKitLog = createWriteStream(join(shots, "livekit-server.log"));
liveKit.stdout.pipe(liveKitLog);
liveKit.stderr.pipe(liveKitLog);
const data = mkdtempSync(join(tmpdir(), "zuna-mac-sound-data-"));
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

function watch(name, page) {
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("WebSocket")) errors.push(`${name}: ${text}`);
    if (text.includes("[zuna]") || process.env.VOICE_DEBUG) console.log(`  [${name}] ${message.type()}: ${text}`);
  });
}

/** So that what's really being received can be listened to, and with a moving picture to share in place of the screen. */
async function prepare(page) {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__connections = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args);
        window.__connections.push(this);
      }
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      let frame = 0;
      setInterval(() => {
        frame++;
        context.fillStyle = "#123";
        context.fillRect(0, 0, 1280, 720);
        context.fillStyle = "#0f0";
        context.fillRect((frame * 8) % 1200, 300, 80, 80);
      }, 33);
      return canvas.captureStream(30);
    };
  });
  await page.reload();
}

/** The one sharing: Electron started through `open`, so it's what macOS asks about, and driven over its debugging port. */
async function launchOpened(name) {
  const userData = mkdtempSync(join(tmpdir(), `zuna-mac-sound-${name}-`));
  const debugPort = 19400 + Math.floor(Math.random() * 500);
  const electronApp = join(root, "node_modules", "electron", "dist", "Electron.app");
  spawn("open", ["-n", "-W", electronApp, "--args", app, `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"], { stdio: "ignore" });
  let browser = null;
  for (let i = 0; i < 120 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`).catch(() => null);
    if (!browser) await sleep(250);
  }
  if (!browser) throw new Error(`${name} didn't open its debugging port`);
  const context = browser.contexts()[0];
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    page = context.pages().find((candidate) => candidate.url().startsWith("zuna-app:")) ?? null;
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`${name} showed no window`);
  watch(name, page);
  await prepare(page);
  const entry = { name, page, userData, close: async () => { await browser.close().catch(() => undefined); try { execFileSync("pkill", ["-f", userData]); } catch { /* Gone. */ } } };
  apps.push(entry);
  return entry;
}

/** Someone watching, who plays nothing out loud. */
async function launch(name) {
  const userData = mkdtempSync(join(tmpdir(), `zuna-mac-sound-${name}-`));
  const electronApp = await electron.launch({ args: [app, `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"], env: { ...process.env, ELECTRON_RENDERER_URL: "" } });
  const page = await electronApp.firstWindow();
  watch(name, page);
  await prepare(page);
  const entry = { name, page, userData, close: () => electronApp.close().catch(() => undefined) };
  apps.push(entry);
  return entry;
}

async function signUp({ page }, link, displayName, first) {
  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill(displayName, { timeout: 15_000 });
  if (first === false) await page.getByPlaceholder(/username/i).fill(displayName.toLowerCase()).catch(() => undefined);
  await page.locator('input[type="password"]').first().fill(`mac-sound-check-Pass-${displayName}-9182`);
  await page.getByLabel("Confirm password").fill(`mac-sound-check-Pass-${displayName}-9182`);
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
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${liveKitPort}/`).then(() => true, () => false)); i++) await sleep(100);
  const link = await setupLink();
  const alice = await launchOpened("alice");
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

  // What plays: Zuna itself, loud, from its page as everything it plays does, and two other apps, quietly.
  await alice.page.evaluate(() => {
    const context = new AudioContext();
    const own = context.createOscillator();
    own.frequency.value = 1500;
    const gain = context.createGain();
    gain.gain.value = 0.3;
    own.connect(gain).connect(context.destination);
    own.start();
    window.__ownTone = context;
    return context.resume();
  });
  play(toneA);
  play(toneB);
  await sleep(2500);

  const soundChoice = () => alice.page.getByRole("combobox", { name: /^Sound/ });
  // With the list of screens where Zuna may record the screen, and saying macOS's own picker comes next where it may not.
  const openPicker = async () => {
    await alice.page.getByRole("button", { name: "Share your screen" }).first().click();
    await soundChoice().waitFor({ timeout: 10_000 });
  };
  const share = async (choice) => {
    await openPicker();
    if (choice) await soundChoice().selectOption({ label: choice });
    await alice.page.getByRole("button", { name: "Share", exact: true }).click();
    // The first time, macOS asks the person whether this may record the computer's sound.
    await alice.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 150_000 });
    await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ timeout: 20_000 });
    await sleep(3000);
  };
  const stop = async () => {
    await alice.page.getByRole("button", { name: "Stop sharing" }).first().click();
    await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ state: "detached", timeout: 15_000 });
    await sleep(2500);
  };

  await openPicker();
  await sleep(3500);
  const offered = await soundChoice().locator("option").allTextContents();
  const byDefault = await soundChoice().evaluate((select) => ({ value: select.value, label: select.selectedOptions[0]?.textContent ?? "" }));
  await shot(alice, "01-picker");
  console.log(`  Offered: ${offered.join(", ")}, with ${byDefault.label} (${byDefault.value})`);
  check("the picker offers no sound, the entire system, and each app playing", ["No sound", "Entire system", "ToneA", "ToneB"].every((name) => offered.some((option) => option.startsWith(name))), offered.join(", "));
  check("Zuna's own sound isn't offered", !offered.some((name) => name.startsWith("Electron")), offered.join(", "));
  check("a screen starts with the entire system's sound", byDefault.value === "everything", `${byDefault.label} (${byDefault.value})`);
  await alice.page.getByRole("button", { name: "Cancel" }).click();

  const quiet = await loudestArriving(bob.page, 2);
  check("before sharing, nothing arrives", quiet < 0.005, `peak ${quiet.toFixed(4)}`);

  await share();
  await shot(bob, "02-watching");
  const everything = await loudestArriving(bob.page, 4);
  check("the entire system's sound reaches someone watching, and decrypts", everything > 0.04, `peak ${everything.toFixed(3)}`);
  check("Zuna's own sound isn't in it", everything < 0.2, `peak ${everything.toFixed(3)}, where Zuna's own is 0.3 and the two apps' 0.07`);
  check("it's captured by the native program", capturing() === 1, `${capturing()} running`);
  await stop();
  check("stopping the share stops capturing", capturing() === 0, `${capturing()} running`);

  await share("ToneB");
  const one = await loudestArriving(bob.page, 4);
  check("one app's sound reaches someone watching alone", one > 0.01 && one < 0.035, `peak ${one.toFixed(3)}, where that app's is 0.02 and the rest 0.35`);
  await stop();

  // Someone new can't open what others send under the old key for a moment, until they all move on to the new one.
  const realErrors = errors.filter((error) => !error.includes("MissingKey"));
  check("nothing went wrong on the page", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
} catch (error) {
  failed = error;
  console.error(error);
  for (const entry of apps) await entry.page.screenshot({ path: join(shots, `failed-${entry.name}.png`) }).catch(() => undefined);
} finally {
  stopPlaying();
  for (const entry of apps) await entry.close();
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
console.log("All of macOS's sound checks passed.");
process.exit(0);
