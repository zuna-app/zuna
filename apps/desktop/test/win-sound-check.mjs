// The computer's sound going with a screen share on Windows, which the native program takes
// through process loopback. Drives two real Electron apps against a real server and a real
// LiveKit, and checks what reaches someone watching: everything but Zuna, one app alone, and
// beside a native share.
//
//   npm run build:screenshare && npm run build -w @zuna/desktop && node apps/desktop/test/win-sound-check.mjs [screenshot-dir]
//
// Windows has no player nobody hears, and process loopback only hears what goes to the
// default output, so the other app is FFmpeg's ffplay playing a tone at -60 dBFS: quiet
// enough not to be heard, and loud enough to survive Chromium's 16-bit audio. Zuna's own is
// another tone from a player the app starts itself, as Chromium plays from a process under
// the app's. Each is told apart from the other by its frequency, so whatever else plays on
// the computer only gets in the way of the checks that it's there, not those that it isn't.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { ensureLiveKit } from "../../../scripts/lib.mjs";

if (process.platform !== "win32") {
  console.log("This checks Windows's sound; sound-check.mjs checks Linux's and mac-sound-check.mjs macOS's.");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-win-sound-"));
mkdirSync(shots, { recursive: true });
const ffplay = join(app, "native", "screenshare", ".deps", "ffmpeg", "bin", "ffplay.exe");
if (!existsSync(ffplay)) {
  console.error("Run npm run build:screenshare first, which fetches FFmpeg and its ffplay.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

// --- Tones too quiet to hear ---

const PEAK = 0.001;
const OTHER_HZ = 2000;
const OWN_HZ = 1500;

/** A tone as a stereo WAV, at this frequency and peak. */
function tone(path, frequency, peak, seconds = 300) {
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

const fixtures = mkdtempSync(join(tmpdir(), "zuna-win-sound-tones-"));
const otherPath = join(fixtures, "other.wav");
const ownPath = join(fixtures, "own.wav");
tone(otherPath, OTHER_HZ, PEAK);
tone(ownPath, OWN_HZ, PEAK);
const playerArgs = (file) => ["-nodisp", "-loop", "0", "-loglevel", "quiet", file];

// --- A server and a media server ---

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const pathEnv = { ...process.env, PATH: [...goBin, process.env.PATH ?? ""].join(delimiter) };
const binary = join(tmpdir(), "zuna-win-sound-server.exe");
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], { cwd: join(root, "server"), env: pathEnv, stdio: "inherit" });

const liveKitPort = 17891;
const liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort)], { stdio: "ignore" });
const data = mkdtempSync(join(tmpdir(), "zuna-win-sound-data-"));
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
  const userData = mkdtempSync(join(tmpdir(), `zuna-win-sound-${name}-`));
  // What arrives is measured in the page, so nothing Chromium plays needs to be heard.
  const args = [app, `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"];
  const electronApp = await electron.launch({ args, env: { ...process.env, ELECTRON_RENDERER_URL: "" } });
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
  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill(displayName, { timeout: 15_000 });
  if (first === false) await page.getByPlaceholder(/username/i).fill(displayName.toLowerCase()).catch(() => undefined);
  await page.locator('input[type="password"]').fill(`win-sound-check-Pass-${displayName}-9182`);
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

/** How strong each of these frequencies is in everything arriving, in dB, listening to the tracks themselves. */
async function tonesArriving(page, frequencies, seconds = 3) {
  return page.evaluate(
    async ({ frequencies, seconds }) => {
      const context = new AudioContext({ sampleRate: 48000 });
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0;
      for (const connection of window.__connections) {
        if (connection.connectionState === "closed") continue;
        for (const receiver of connection.getReceivers()) {
          if (receiver.track.kind === "audio" && receiver.track.readyState === "live") context.createMediaStreamSource(new MediaStream([receiver.track])).connect(analyser);
        }
      }
      const bins = new Float32Array(analyser.frequencyBinCount);
      const strongest = frequencies.map(() => -Infinity);
      const until = performance.now() + seconds * 1000;
      while (performance.now() < until) {
        analyser.getFloatFrequencyData(bins);
        frequencies.forEach((frequency, index) => {
          const bin = Math.round((frequency / context.sampleRate) * analyser.fftSize);
          for (let at = bin - 2; at <= bin + 2; at++) strongest[index] = Math.max(strongest[index], bins[at]);
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await context.close();
      return strongest;
    },
    { frequencies, seconds },
  );
}

/** How many of the program's sound captures are running, and with what. */
const capturing = () => {
  const list = execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name = 'zuna-screenshare.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: "utf8" });
  return list
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => / --sound( |$)| --sound-from /.test(line));
};

const rowFor = (page, name) => page.locator(".channel-row", { hasText: name });
const HEARD = -100;

let failed = null;
let other = null;
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

  // Zuna's own tone, from a player under the app as Chromium's audio is, and another app's.
  await alice.electronApp.evaluate((_electron, { ffplay, args }) => {
    const { spawn } = process.getBuiltinModule("node:child_process");
    globalThis.__ownPlayer = spawn(ffplay, args, { stdio: "ignore" });
  }, { ffplay, args: playerArgs(ownPath) });
  other = spawn(ffplay, playerArgs(otherPath), { stdio: "ignore" });
  await sleep(2000);

  const soundChoice = () => alice.page.getByRole("combobox", { name: /^Sound/ });
  const openPicker = async () => {
    await alice.page.getByRole("button", { name: "Share your screen" }).first().click();
    await alice.page.locator(".screen-source").first().click({ timeout: 15_000 });
    await soundChoice().waitFor({ timeout: 10_000 });
  };
  const share = async (choice) => {
    await openPicker();
    await sleep(500);
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
  const toggleNative = async () => {
    await alice.page.getByLabel("Settings", { exact: true }).click();
    await alice.page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
    await alice.page.getByRole("switch", { name: "Capture on your graphics card" }).click();
    await alice.page.keyboard.press("Escape");
    await sleep(300);
  };

  await openPicker();
  await sleep(3500);
  const offered = await soundChoice().locator("option").allTextContents();
  const values = await soundChoice().locator("option").evaluateAll((options) => options.map((option) => option.value));
  const byDefault = await soundChoice().evaluate((select) => ({ value: select.value, label: select.selectedOptions[0]?.textContent ?? "" }));
  await shot(alice, "01-picker");
  console.log(`  Offered: ${offered.join(", ")}, with ${byDefault.label} (${byDefault.value})`);
  const otherOption = offered.find((name) => name.toLowerCase().startsWith("ffplay"));
  check("the picker offers no sound, the entire system, and the app playing", offered.includes("No sound") && offered.includes("Entire system") && !!otherOption, offered.join(", "));
  // Bob's app is Electron too, and another app, so it's offered: Alice's own is known by its process.
  const own = `app:pid:${await alice.electronApp.evaluate(() => process.pid)}`;
  check("Zuna's own sound isn't offered", !values.includes(own), `${values.join(", ")}, where Zuna's own would be ${own}`);
  check("a screen starts with the entire system's sound", byDefault.value === "everything", `${byDefault.label} (${byDefault.value})`);
  // Bob's window, which is the only one of Zuna's listed, as Alice's own isn't.
  await alice.page.getByRole("button", { name: "Windows", exact: true }).click();
  await alice.page.locator(".screen-source", { hasText: "Zuna" }).first().click();
  await sleep(1500);
  const forWindow = await soundChoice().evaluate((select) => ({ value: select.value, label: select.selectedOptions[0]?.textContent ?? "" }));
  const bobsApp = `app:pid:${await bob.electronApp.evaluate(() => process.pid)}`;
  check("a window starts with the sound of the app it belongs to", forWindow.value === bobsApp, `${forWindow.label} (${forWindow.value}), where Bob's app is ${bobsApp}`);
  await alice.page.getByRole("button", { name: "Cancel" }).click();

  const [quietOther, quietOwn] = await tonesArriving(bob.page, [OTHER_HZ, OWN_HZ], 2);
  check("before sharing, nothing arrives", quietOther < HEARD && quietOwn < HEARD, `${quietOther.toFixed(0)} dB and ${quietOwn.toFixed(0)} dB`);

  for (const native of [true, false]) {
    const route = native ? "beside a native share" : "beside a share through the browser";
    if (!native) await toggleNative();
    await share("Entire system");
    const [everythingOther, everythingOwn] = await tonesArriving(bob.page, [OTHER_HZ, OWN_HZ]);
    const running = capturing();
    check(`the entire system's sound reaches someone watching ${route}`, everythingOther > HEARD, `the other app's tone at ${everythingOther.toFixed(0)} dB`);
    check(`Zuna's own sound isn't in it ${route}`, everythingOwn < everythingOther - 20, `${everythingOwn.toFixed(0)} dB, where the other app's is ${everythingOther.toFixed(0)} dB`);
    check(`it's captured by the native program ${route}`, running.length === 1 && / --sound( |$)/.test(running[0]), running.join(" | ") || "nothing running");
    if (native) await shot(bob, "02-watching");
    await stop();
    check(`stopping the share stops capturing ${route}`, capturing().length === 0, capturing().join(" | "));
    if (!native) await toggleNative();
  }

  await share(otherOption);
  const [oneOther, oneOwn] = await tonesArriving(bob.page, [OTHER_HZ, OWN_HZ]);
  check("one app's sound reaches someone watching", oneOther > HEARD, `${oneOther.toFixed(0)} dB`);
  check("nothing else comes with it", oneOwn < oneOther - 20, `Zuna's own at ${oneOwn.toFixed(0)} dB`);
  check("it's captured from that app alone", capturing().some((line) => line.includes(`--sound-from pid:${other.pid}`)), capturing().join(" | "));
  await stop();

  const realErrors = errors.filter((error) => !error.includes("MissingKey"));
  check("nothing went wrong on the page", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
} catch (error) {
  failed = error;
  console.error(error);
  for (const entry of apps) await entry.page.screenshot({ path: join(shots, `failed-${entry.name}.png`) }).catch(() => undefined);
} finally {
  other?.kill();
  for (const entry of apps) {
    await entry.electronApp.evaluate(() => globalThis.__ownPlayer?.kill()).catch(() => undefined);
    await entry.electronApp.close().catch(() => undefined);
  }
  server.kill();
  liveKit.kill();
  await sleep(500);
  for (const dir of [data, fixtures, ...apps.map((entry) => entry.userData)]) rmSync(dir, { recursive: true, force: true });
}

console.log(`\nScreenshots are in ${shots}`);
if (failed || failures.length > 0) {
  console.error(failed ? "It stopped partway." : `${failures.length} checks failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("All sound checks passed.");
process.exit(0);
