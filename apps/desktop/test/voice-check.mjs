// Drives two real Electron apps against a real server and a real LiveKit, with a
// text channel, a voice channel and a call in a direct message, and checks what
// actually reaches each of them: audio that decrypts, noise that doesn't get
// through, screens to look over, and a call that rings.
//
//   npm run build -w @zuna/desktop && node apps/desktop/test/voice-check.mjs [screenshot-dir]
//
// Each app's microphone is a sound file Chromium plays as a fake device: spoken words
// on Windows and macOS, and on Linux with eSpeak NG installed, and a tone elsewhere.
//
// VOICE_ENCODER, such as h264_mf, has native shares go through that encoder rather than
// the one that goes with the screen's graphics card.
//
// VOICE_LIVEKIT_DEFAULTS=1 runs LiveKit as a server set up before it took H.264's Baseline,
// so a Mac shares in software and says the server is why.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../scripts/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-voice-"));
mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

// --- Sounds for the fake microphones ---

function wavFrom(samples, rate = 48000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const fixtures = mkdtempSync(join(tmpdir(), "zuna-voice-sounds-"));
const noisePath = join(fixtures, "noise.wav");
const speechPath = join(fixtures, "speech.wav");
{
  // Steady noise, like a fan. It has plenty of energy, and none of it is speech.
  const noise = Float32Array.from({ length: 48000 * 4 }, () => (Math.random() * 2 - 1) * 0.12);
  writeFileSync(noisePath, wavFrom(noise));
}
const spoken = "Testing the voice channel. Can you hear me? One two three four five. The quick brown fox jumps over the lazy dog, again and again, until someone answers.";
try {
  if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${speechPath.replaceAll("\\", "\\\\")}', $f); $s.Speak('${spoken}'); $s.Dispose()`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  } else if (process.platform === "linux") {
    // At eSpeak NG's own 22050 Hz, which Chromium's fake device and the checks below resample.
    execFileSync("espeak-ng", ["-w", speechPath, spoken], { stdio: "ignore" });
  } else if (process.platform === "darwin") {
    execFileSync("say", ["-o", speechPath, "--data-format=LEI16@48000", spoken], { stdio: "ignore" });
  }
} catch (error) {
  console.log(`Couldn't synthesize speech, so a tone stands in: ${error}`);
}
const haveSpeech = existsSync(speechPath);

// --- A server and a media server ---

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const pathEnv = { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) };
const binary = join(tmpdir(), `zuna-voice-server${process.platform === "win32" ? ".exe" : ""}`);
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], { cwd: join(root, "server"), env: pathEnv, stdio: "inherit" });

const liveKitPort = 17880;
const liveKitDefaults = !!process.env.VOICE_LIVEKIT_DEFAULTS;
const liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort), ...(liveKitDefaults ? [] : ["--config-body", LIVEKIT_CONFIG])], { stdio: ["ignore", "pipe", "pipe"] });
let liveKitOutput = "";
liveKit.stdout.on("data", (chunk) => (liveKitOutput += chunk));
liveKit.stderr.on("data", (chunk) => (liveKitOutput += chunk));

// A real server's media server is behind TLS, and everything here goes through the same.
// The native capture has its own TLS and its own certificates to trust, so it can't
// reach one unless it's been built to, which plain ws:// would never show.
const certificates = mkdtempSync(join(tmpdir(), "zuna-voice-tls-"));
{
  const openssl = ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"].find((path) => {
    try {
      execFileSync(path, ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!openssl) throw new Error("This check needs openssl, to make certificates for its media server.");
  const run = (...args) => execFileSync(openssl, args, { cwd: certificates, stdio: "ignore" });
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  run("req", "-x509", ...key, "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Zuna voice check");
  run("req", ...key, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
  writeFileSync(join(certificates, "leaf.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "2", "-extfile", "leaf.ext");
}
const tlsFront = createTlsServer({ key: readFileSync(join(certificates, "leaf.key")), cert: readFileSync(join(certificates, "leaf.crt")) }, (client) => {
  const upstream = createConnection(liveKitPort, "127.0.0.1");
  for (const socket of [client, upstream]) socket.on("error", () => undefined);
  client.pipe(upstream).pipe(client);
});
await new Promise((resolve) => tlsFront.listen(0, "127.0.0.1", resolve));
const mediaUrl = `wss://localhost:${tlsFront.address().port}`;

const data = mkdtempSync(join(tmpdir(), "zuna-voice-data-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--data", data, "--public-url", url, "--auth-burst", "1000", "--livekit-url", mediaUrl, "--livekit-internal-url", `http://127.0.0.1:${liveKitPort}`, "--livekit-key", "devkey", "--livekit-secret", "secret"], { stdio: ["ignore", "pipe", "pipe"] });
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
async function launch(name, soundFile) {
  const userData = mkdtempSync(join(tmpdir(), `zuna-voice-${name}-`));
  // Chromium is told to trust the test's media server here, and the native capture through SSL_CERT_FILE.
  // What arrives is measured in the page, so none of it needs to play out loud.
  const args = [app, `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--mute-audio"];
  if (soundFile) args.push(`--use-file-for-fake-audio-capture=${soundFile}`);
  // On macOS the audio service's sandbox keeps it from opening the file, and the fake device sends silence.
  if (soundFile && process.platform === "darwin") args.push("--no-sandbox");
  const electronApp = await electron.launch({ args, env: { ...process.env, ELECTRON_RENDERER_URL: "", SSL_CERT_FILE: join(certificates, "ca.crt") } });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("WebSocket")) errors.push(`${name}: ${text}`);
    if (text.includes("[zuna]") || process.env.VOICE_DEBUG) console.log(`  [${name}] ${message.type()}: ${text}`);
  });
  await page.addInitScript((standInScreen) => {
    // So that what's really being sent and received can be asked for.
    const Original = window.RTCPeerConnection;
    window.__connections = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args);
        window.__connections.push(this);
      }
    };
    if (!standInScreen) return;
    // macOS's own picker can't be driven, so what's shared is a moving picture at the size and frame
    // rate the app asks for, with a tone for its sound. Capturing a real screen isn't checked there.
    navigator.mediaDevices.getDisplayMedia = async (constraints = {}) => {
      const video = typeof constraints.video === "object" ? constraints.video : {};
      const most = (value, fallback) => (typeof value === "number" ? value : (value?.max ?? value?.exact ?? value?.ideal ?? fallback));
      const fps = most(video.frameRate, 30);
      const canvas = document.createElement("canvas");
      canvas.height = Math.min(1080, most(video.height, 1080));
      canvas.width = Math.round((canvas.height * 16) / 9);
      const context = canvas.getContext("2d");
      const stream = canvas.captureStream(fps);
      const [track] = stream.getVideoTracks();
      let frame = 0;
      const timer = setInterval(() => {
        if (track.readyState === "ended") return clearInterval(timer);
        frame++;
        context.fillStyle = "#123";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#0f0";
        context.fillRect((frame * 8) % (canvas.width - 80), canvas.height / 2, 80, 80);
        context.fillStyle = "#fff";
        context.font = `${Math.round(canvas.height / 15)}px sans-serif`;
        context.fillText(`Shared screen ${frame}`, 40, canvas.height / 8);
      }, 1000 / fps);
      if (constraints.audio) {
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const out = audio.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        stream.addTrack(out.stream.getAudioTracks()[0]);
      }
      return stream;
    };
  }, process.platform === "darwin");
  await page.reload();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1280, 832);
  });
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
  await page.locator('input[type="password"]').fill(`voice-check-Pass-${displayName}-9182`);
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

/** What's going through an app's connections right now, over a second. */
async function audioFlow(page, seconds = 1) {
  const read = () =>
    page.evaluate(async () => {
      const totals = { inEnergy: 0, inBytes: 0, inPackets: 0, outBytes: 0, outPackets: 0, inVideoFrames: 0, outVideoFrames: 0 };
      for (const connection of window.__connections) {
        if (connection.connectionState === "closed") continue;
        const stats = await connection.getStats();
        stats.forEach((entry) => {
          if (entry.type === "inbound-rtp" && entry.kind === "audio") {
            totals.inEnergy += entry.totalAudioEnergy ?? 0;
            totals.inBytes += entry.bytesReceived ?? 0;
            totals.inPackets += entry.packetsReceived ?? 0;
          }
          if (entry.type === "outbound-rtp" && entry.kind === "audio") {
            totals.outBytes += entry.bytesSent ?? 0;
            totals.outPackets += entry.packetsSent ?? 0;
          }
          if (entry.type === "inbound-rtp" && entry.kind === "video") {
            totals.inVideoFrames += entry.framesDecoded ?? 0;
            // The largest being decoded is the share: a camera's stream stays listed after it's gone.
            if ((entry.framesDecoded ?? 0) > 0 && (entry.frameWidth ?? 0) >= (window.__lastVideo?.width ?? 0)) window.__lastVideo = { width: entry.frameWidth, height: entry.frameHeight, codec: stats.get(entry.codecId)?.mimeType, decoder: entry.decoderImplementation };
          }
          if (entry.type === "outbound-rtp" && entry.kind === "video") totals.outVideoFrames += entry.framesSent ?? 0;
        });
      }
      return totals;
    });
  const before = await read();
  await sleep(seconds * 1000);
  const after = await read();
  return Object.fromEntries(Object.keys(after).map((key) => [key, (after[key] - before[key]) / seconds]));
}

/** How loud what's arriving and what's going out really are, listening to the tracks themselves. */
async function loudness(page, seconds = 3) {
  return page.evaluate(async (seconds) => {
    const context = new AudioContext();
    await context.resume();
    const measure = (track) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
      return analyser;
    };
    const incoming = [];
    const outgoing = [];
    for (const connection of window.__connections) {
      if (connection.connectionState === "closed") continue;
      for (const receiver of connection.getReceivers()) if (receiver.track.kind === "audio" && receiver.track.readyState === "live") incoming.push(measure(receiver.track));
      for (const sender of connection.getSenders()) if (sender.track?.kind === "audio") outgoing.push(measure(sender.track));
    }
    const peak = { in: 0, out: 0 };
    const samples = new Float32Array(2048);
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
      for (const [list, key] of [[incoming, "in"], [outgoing, "out"]]) {
        for (const analyser of list) {
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) peak[key] = Math.max(peak[key], Math.abs(sample));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await context.close();
    return { ...peak, receivers: incoming.length, senders: outgoing.length };
  }, seconds);
}

const rowFor = (page, name) => page.locator(".channel-row", { hasText: name });

/** What the stream stats window says now: each section's title, headline and rows. */
const readStats = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".stream-stats-section")].map((section) => ({
      title: section.querySelector("summary").textContent,
      fps: Number.parseFloat(section.querySelector(".stream-stats-fps b")?.textContent ?? ""),
      rows: Object.fromEntries([...section.querySelectorAll(".stream-stats-rows > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent])),
    })),
  );
const fpsIn = (text) => Number.parseFloat(text ?? "");

/** Something moving on the screen, so that a share has a new frame to send at every refresh. */
async function animateTheScreen({ electronApp }) {
  await electronApp.evaluate(async ({ BrowserWindow, screen }) => {
    const { x, y, height } = screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({ x: x + 8, y: y + height - 188, width: 220, height: 180, frame: false, alwaysOnTop: true, focusable: false, title: "Moving", webPreferences: { backgroundThrottling: false } });
    await window.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><title>Moving</title><body style="margin:0;background:#123"><div id=b style="position:absolute;width:40px;height:40px;background:#0f0"></div><script>let n=0;(function f(){n++;b.style.left=n*3%180+"px";b.style.top=n%140+"px";requestAnimationFrame(f)})()</script>`)}`);
  });
}

let failed = null;
try {
  const link = await setupLink();
  const alice = await launch("alice", haveSpeech ? speechPath : null);
  const shot = (who, name) => who.page.screenshot({ path: join(shots, `${name}.png`) });

  await signUp(alice, link, "Alice", true);
  await alice.page.locator(".server-title").click();
  await alice.page.getByRole("menuitem", { name: "Invite people" }).click();
  await alice.page.getByRole("button", { name: "Create invite link" }).click();
  const invite = await alice.page.locator(".invite-link span").first().textContent({ timeout: 10_000 });
  await alice.page.keyboard.press("Escape");

  // --- Making channels ---
  await alice.page.locator(".channel-empty button").click();
  await alice.page.getByPlaceholder("new-channel").fill("General Chat");
  await sleep(100);
  await shot(alice, "01-new-channel");
  check("a text channel's name becomes lowercase with dashes", (await alice.page.getByPlaceholder("new-channel").inputValue()) === "general-chat");
  await alice.page.getByRole("button", { name: "Create channel" }).click();
  await rowFor(alice.page, "general-chat").waitFor({ timeout: 15_000 });
  await alice.page.locator(".chat-title", { hasText: "general-chat" }).waitFor({ timeout: 15_000 });
  await alice.page.locator(".composer-input").fill("first message in the channel");
  await alice.page.keyboard.press("Enter");
  await alice.page.locator(".msg.is-channel", { hasText: "first message in the channel" }).waitFor({ timeout: 10_000 });

  await alice.page.locator(".channel-section-head", { hasText: "Text channels" }).hover();
  await alice.page.getByRole("button", { name: /New channel in Text channels/ }).click();
  await alice.page.getByRole("button", { name: /^Voice/ }).click();
  await alice.page.getByPlaceholder("Lounge").fill("Lounge");
  await alice.page.getByRole("button", { name: "Create channel" }).click();
  await rowFor(alice.page, "Lounge").waitFor({ timeout: 15_000 });
  await sleep(1500);
  await shot(alice, "02-channels");

  const bob = await launch("bob", haveSpeech ? speechPath : null);
  await signUp(bob, invite, "Bob", false);
  await rowFor(bob.page, "general-chat").waitFor({ timeout: 20_000 });
  await rowFor(bob.page, "Lounge").waitFor({ timeout: 20_000 });
  check("someone new sees the channels by themselves", true);

  // --- Text channels ---
  await rowFor(bob.page, "general-chat").click();
  await bob.page.locator(".chat-title", { hasText: "general-chat" }).waitFor({ timeout: 20_000 });
  await bob.page.locator(".msg.is-channel", { hasText: "first message in the channel" }).waitFor({ timeout: 20_000 }).then(() => check("someone new reads what was said before they came", true)).catch(() => check("someone new reads what was said before they came", false));
  await rowFor(alice.page, "general-chat").click();
  await alice.page.locator(".chat-title", { hasText: "general-chat" }).waitFor({ timeout: 10_000 });
  await bob.page.locator(".composer-input").fill("hello from bob");
  await bob.page.keyboard.press("Enter");
  await alice.page.locator(".msg.is-channel", { hasText: "hello from bob" }).waitFor({ timeout: 15_000 });
  check("a channel's messages reach everyone", true);
  await sleep(300);
  await shot(bob, "03-text-channel");

  // --- Voice ---
  await rowFor(alice.page, "Lounge").click();
  await alice.page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  check("clicking a voice channel connects to it", true);
  check("there's no button to press to join", (await alice.page.getByRole("button", { name: /join voice/i }).count()) === 0);
  await alice.page.locator(".voice-occupant", { hasText: "Alice" }).waitFor({ timeout: 10_000 });
  await bob.page.locator(".voice-occupant", { hasText: "Alice" }).waitFor({ timeout: 10_000 });
  check("everyone on the server sees who's in a voice channel", true);
  await shot(bob, "04-someone-in-voice");

  await rowFor(bob.page, "Lounge").click();
  await bob.page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  await alice.page.locator(".voice-occupant", { hasText: "Bob" }).waitFor({ timeout: 10_000 });
  await sleep(4000);

  const toAlice = await audioFlow(alice.page, 2);
  const heardByAlice = await loudness(alice.page);
  const heardByBob = await loudness(bob.page);
  check("audio arrives", toAlice.inPackets > 10, `${toAlice.inPackets.toFixed(0)} packets/s`);
  check("what the microphone sends has sound in it", heardByBob.out > 0.01, `peak ${heardByBob.out.toFixed(3)}`);
  check("audio decrypts into sound on each side", heardByAlice.in > 0.01 && heardByBob.in > 0.01, `alice hears peak ${heardByAlice.in.toFixed(3)}, bob ${heardByBob.in.toFixed(3)}`);
  await shot(alice, "05-voice-stage");
  const pill = await alice.page.evaluate(() => {
    const group = document.querySelector(".voice-control-group");
    const box = group.getBoundingClientRect();
    const first = group.querySelector(".voice-control svg").getBoundingClientRect();
    const last = group.querySelector(".voice-control-more svg").getBoundingClientRect();
    return { left: first.left - box.left, right: box.right - last.right };
  });
  check("the microphone's pill has the same space at each end", Math.abs(pill.left - pill.right) < 1, `${pill.left}px and ${pill.right}px`);
  check("there's only one picture of you beside the sidebar", (await alice.page.locator(".voice-panel .avatar").count()) === 0);

  const e2ee = await alice.page.evaluate(() => {
    let encrypted = false;
    for (const connection of window.__connections) {
      for (const sender of connection.getSenders()) if (sender.transform || sender.createEncodedStreams || sender.lk_e2ee) encrypted = true;
    }
    return encrypted;
  });
  check("media goes through the encryption transform", e2ee);

  if (haveSpeech) {
    const speaking = await alice.page.waitForFunction(() => document.querySelector(".voice-tile.is-speaking, .voice-occupant.is-speaking"), null, { timeout: 15_000 }).then(() => true).catch(() => false);
    check("someone speaking is shown as speaking", speaking);
    await shot(alice, "06-speaking");
  }

  // --- How much noise comes out of speech ---
  if (haveSpeech) {
    const measured = await alice.page.evaluate(
      async ({ speech, noise, worklet }) => {
        const decode = async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          const context = new OfflineAudioContext(1, 48000, 48000);
          return (await context.decodeAudioData(bytes.buffer)).getChannelData(0);
        };
        const clean = await decode(speech);
        const hiss = await decode(noise);
        const length = Math.min(clean.length, 48000 * 8);
        const mixed = new Float32Array(length);
        for (let i = 0; i < length; i++) mixed[i] = clean[i] + hiss[i % hiss.length];
        // As it comes out by default: an offline context doesn't take messages before it renders.
        const run = async () => {
          const context = new OfflineAudioContext(1, length, 48000);
          await context.audioWorklet.addModule(worklet);
          const node = new AudioWorkletNode(context, "zuna-mic", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
          const buffer = context.createBuffer(1, length, 48000);
          buffer.copyToChannel(mixed, 0);
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(node).connect(context.destination);
          source.start();
          return (await context.startRendering()).getChannelData(0);
        };
        // How much of what comes out is the speech, once it's lined up with what went in.
        const snr = (out) => {
          let best = -Infinity;
          for (let delay = 0; delay < 4800; delay += 8) {
            let dot = 0;
            let norm = 0;
            let total = 0;
            for (let i = 0; i + delay < length; i += 4) {
              dot += out[i + delay] * clean[i];
              norm += clean[i] * clean[i];
              total += out[i + delay] * out[i + delay];
            }
            const gain = dot / norm;
            const wanted = gain * gain * norm;
            const value = 10 * Math.log10(wanted / Math.max(1e-9, total - wanted));
            if (value > best) best = value;
          }
          return best;
        };
        return { off: snr(mixed), on: snr(await run()) };
      },
      {
        speech: readFileSync(speechPath).toString("base64"),
        noise: readFileSync(noisePath).toString("base64"),
        worklet: `/assets/${readdirSync(join(app, "out", "renderer", "assets")).find((name) => name.startsWith("mic.worklet"))}`,
      },
    );
    check("noise cancelling clears noise out of speech", measured.on > measured.off + 4, `speech over noise goes from ${measured.off.toFixed(1)} dB to ${measured.on.toFixed(1)} dB`);
  }

  // --- Muting ---
  await alice.page.getByRole("button", { name: "Mute", exact: true }).first().click();
  await sleep(1500);
  const whileMuted = await loudness(bob.page, 2);
  await bob.page.locator(".voice-occupant", { hasText: "Alice" }).locator(".lucide-mic-off").waitFor({ timeout: 5000 });
  check("muting stops the sound going out", whileMuted.in < 0.001, `peak ${whileMuted.in.toFixed(4)}`);
  check("everyone sees someone is muted", true);
  await alice.page.getByRole("button", { name: "Unmute", exact: true }).first().click();

  // --- A new key when someone new comes in ---
  const carol = await launch("carol", noisePath);
  await signUp(carol, invite, "Carol", false);
  await rowFor(carol.page, "Lounge").waitFor({ timeout: 20_000 });
  await rowFor(carol.page, "Lounge").click();
  await carol.page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  await sleep(5000);
  const afterRotate = await loudness(bob.page);
  const toCarol = await loudness(carol.page);
  check("audio keeps flowing after someone new changes the key", afterRotate.in > 0.01, `bob hears peak ${afterRotate.in.toFixed(3)}`);
  check("someone who just came in can hear too", toCarol.in > 0.01, `carol hears peak ${toCarol.in.toFixed(3)}`);

  // --- Noise doesn't get through ---
  // Carol's microphone is nothing but steady noise, which the gate should keep out altogether.
  await bob.page.getByRole("button", { name: "Mute", exact: true }).first().click();
  await alice.page.getByRole("button", { name: "Mute", exact: true }).first().click();
  await sleep(2000);
  const noiseOnly = await loudness(alice.page);
  check("steady noise doesn't open the gate", noiseOnly.in < 0.001, `peak ${noiseOnly.in.toFixed(4)}`);
  const carolOut = await audioFlow(carol.page, 2);
  check("a closed gate costs almost nothing to send", carolOut.outBytes < 2000, `${carolOut.outBytes.toFixed(0)} bytes/s`);
  await carol.page.getByRole("button", { name: "Disconnect from voice" }).click();
  await bob.page.locator(".voice-occupant", { hasText: "Carol" }).waitFor({ state: "detached", timeout: 10_000 });
  check("leaving is seen by everyone", true);
  await alice.page.getByRole("button", { name: "Unmute", exact: true }).first().click();
  await bob.page.getByRole("button", { name: "Unmute", exact: true }).first().click();

  // --- Camera ---
  await alice.page.getByRole("button", { name: "Turn on camera" }).first().click();
  await bob.page.locator(".voice-tile video").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await rowFor(bob.page, "Lounge").click();
  await sleep(4000);
  const video = await audioFlow(bob.page, 2);
  check("a camera's picture reaches others and decrypts", video.inVideoFrames > 5, `${video.inVideoFrames.toFixed(0)} frames/s decoded`);
  await shot(bob, "07-camera");
  await alice.page.getByRole("button", { name: "Turn off camera" }).first().click();

  // --- Sharing a whole screen, natively where this build can ---
  // Shares start with sound, which the checks below ask for only where they mean to.
  for (const who of [alice, bob]) {
    await who.page.getByLabel("Settings", { exact: true }).click();
    await who.page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
    const startWithSound = who.page.getByRole("switch", { name: "Start with sound on" });
    if (await startWithSound.count()) await startWithSound.click();
    if (process.env.VOICE_ENCODER) await who.page.getByRole("combobox", { name: "Encoder" }).selectOption(process.env.VOICE_ENCODER);
    if (process.platform === "darwin" && who === alice) check("a Mac has nothing to set for native capture", (await who.page.getByRole("switch", { name: "Capture on your graphics card" }).count()) === 0);
    await who.page.keyboard.press("Escape");
    await sleep(200);
  }
  /** The picker, with its sources, or saying the system's own picker comes next, as on macOS. */
  const pickerOpen = (page) => page.locator(".screen-source").or(page.getByText("Your browser asks what to share next.")).first().waitFor({ timeout: 10_000 });
  const openPicker = async () => {
    await alice.page.getByRole("button", { name: "Share your screen" }).first().click();
    await pickerOpen(alice.page);
    await sleep(300);
  };
  await openPicker();
  await shot(alice, "08-share-picker");
  const native = await alice.page.locator(".screen-native").isVisible();
  console.log(native ? "  Sharing the screen natively" : "  This build has no native capture, so Chromium shares the screen");
  await alice.page.getByRole("button", { name: "Share", exact: true }).click();
  await alice.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ timeout: 20_000 }).then(() => check("a shared screen reaches others", true)).catch(() => check("a shared screen reaches others", false));
  await sleep(native ? 4000 : 3000);
  const shared = await audioFlow(bob.page, 2);
  const sharedVideo = await bob.page.evaluate(() => window.__lastVideo);
  check("a shared screen decrypts", shared.inVideoFrames > 1, `${shared.inVideoFrames.toFixed(0)} frames/s decoded, ${sharedVideo?.width}x${sharedVideo?.height} ${sharedVideo?.codec} through ${sharedVideo?.decoder}`);
  if (native) {
    check("a native share arrives as H.264", sharedVideo?.codec === "video/H264", sharedVideo?.codec);
    await alice.page.locator(".is-self-share").waitFor({ timeout: 5000 }).catch(() => undefined);
  }
  await shot(bob, "09-screen");
  await shot(alice, "09-sharing");

  // Full screen, which Electron only allows when the app lets it have the permission.
  const screenTile = bob.page.locator(".voice-tile.is-screen").first();
  const fullScreenTile = () => bob.page.evaluate(() => !!document.fullscreenElement?.matches(".voice-tile.is-screen"));
  await screenTile.hover();
  await screenTile.getByRole("button", { name: "Full screen" }).click();
  await bob.page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 }).catch(() => undefined);
  await sleep(1200);
  check("a shared screen goes full screen", await fullScreenTile());
  await shot(bob, "09-full-screen");
  await screenTile.hover();
  await screenTile.getByRole("button", { name: "Exit full screen" }).click();
  await bob.page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 }).catch(() => undefined);
  await sleep(1200);
  check("and comes back from it", !(await fullScreenTile()) && (await screenTile.getByRole("button", { name: "Full screen" }).count()) === 1);

  // Someone's own menu has what the buttons below the call do, not nothing.
  await bob.page.locator(".voice-tile", { hasText: "(you)" }).first().click({ button: "right" });
  const ownMenu = await bob.page.getByRole("menuitem").allTextContents();
  check("someone's own menu in a call isn't empty", ownMenu.some((entry) => entry.includes("Voice settings")) && ownMenu.some((entry) => /deafen/i.test(entry)), ownMenu.join(", "));
  await bob.page.keyboard.press("Escape");

  // --- Stream stats, and whether the frame rate that was asked for is what's happening ---
  await animateTheScreen(alice);
  await alice.page.getByRole("button", { name: "Stream stats" }).click();
  await bob.page.getByRole("button", { name: "Stream stats" }).click();
  await sleep(7000);
  const sharerStats = await readStats(alice.page);
  const viewerStats = await readStats(bob.page);
  await shot(alice, "09-stats-sharing");
  await shot(bob, "09-stats-watching");
  const connection = sharerStats.find((section) => section.title === "Connection");
  check("the stats say where the media goes", connection?.rows["Media server"] === new URL(mediaUrl).host, connection?.rows["Media server"]);
  check("the stats say it's encrypted", connection?.rows.Encryption?.startsWith("End to end"), connection?.rows.Encryption);
  const sharing = sharerStats.find((section) => section.title === "Your screen");
  const watching = viewerStats.find((section) => section.title === "Alice's screen");
  console.log(`  Sharing: ${JSON.stringify(sharing)}`);
  console.log(`  Watching: ${JSON.stringify(watching)}`);
  check("the stats say what a share is doing", !!sharing && !!sharing.rows["Sent through"], sharing?.rows["Sent through"]);
  check("the stats say what's being watched", !!watching && !!watching.rows.Decoding && !!watching.rows.Painting, `${watching?.rows.Decoding} decoded, ${watching?.rows.Painting} painted through ${watching?.rows.Decoder}`);
  check("a share sends the frame rate that was asked for", sharing?.fps > 50, `${sharing?.fps} fps`);
  check("someone watching decodes the frame rate that was asked for", fpsIn(watching?.rows.Decoding) > 50, watching?.rows.Decoding);
  if (native) {
    check("a native share works over TLS", sharing?.rows["Sent through"]?.startsWith("Native") && !sharing?.rows["Why not natively"], sharing?.rows["Sent through"]);
    check("it sends that many really new frames", fpsIn(sharing?.rows["New frames"]) > 50, sharing?.rows["New frames"]);
    check("someone watching can tell how it's being sent", watching?.rows["Sent through"]?.startsWith("Native"), watching?.rows["Sent through"]);
  } else {
    check("capture runs at the frame rate that was asked for", fpsIn(sharing?.rows["Capture agreed to"]) === 60 && fpsIn(sharing?.rows.Capturing) > 50, `agreed to ${sharing?.rows["Capture agreed to"]}, capturing ${sharing?.rows.Capturing}, through ${sharing?.rows.Encoder}`);
  }
  if (process.platform === "darwin") {
    check("a Mac doesn't say why a share isn't native", !sharing?.rows["Why not natively"], sharing?.rows["Why not natively"]);
    if (liveKitDefaults) check("a Mac says the server is why its share is in software", sharing?.rows.Encoder?.startsWith("OpenH264") && !!sharing?.rows["Why in software"], `${sharing?.rows.Encoder}: ${sharing?.rows["Why in software"]}`);
    else check("a Mac encodes its share on the GPU", sharing?.rows.Encoder?.includes("hardware") && !sharing?.rows["Why in software"], `${sharing?.rows.Encoder}, ${sharing?.rows.Codec}`);
  }
  const dragFrom = await alice.page.locator(".stream-stats-head").boundingBox();
  await alice.page.mouse.move(dragFrom.x + 60, dragFrom.y + 12);
  await alice.page.mouse.down();
  await alice.page.mouse.move(dragFrom.x - 140, dragFrom.y + 92, { steps: 4 });
  await alice.page.mouse.up();
  const dragTo = await alice.page.locator(".stream-stats-head").boundingBox();
  check("the stats window can be moved out of the way", Math.abs(dragTo.x - dragFrom.x + 200) < 2 && Math.abs(dragTo.y - dragFrom.y - 80) < 2, `by ${dragTo.x - dragFrom.x}, ${dragTo.y - dragFrom.y}`);
  await alice.page.getByRole("button", { name: "Close stream stats" }).click();
  await bob.page.getByRole("button", { name: "Close stream stats" }).click();
  check("the stats window closes", (await alice.page.locator(".stream-stats").count()) === 0);

  // Someone new changes the key while the screen is being shared.
  const dave = await launch("dave", noisePath);
  await signUp(dave, invite, "Dave", false);
  await rowFor(dave.page, "Lounge").waitFor({ timeout: 20_000 });
  await rowFor(dave.page, "Lounge").click();
  await dave.page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  await sleep(5000);
  const afterRotation = await audioFlow(bob.page, 2);
  check("a shared screen keeps going under a new key", afterRotation.inVideoFrames > 1, `${afterRotation.inVideoFrames.toFixed(0)} frames/s decoded`);
  const newcomer = await audioFlow(dave.page, 2);
  check("someone who came in after can watch it", newcomer.inVideoFrames > 1, `${newcomer.inVideoFrames.toFixed(0)} frames/s decoded`);
  await dave.electronApp.close().catch(() => undefined);
  await alice.page.getByRole("button", { name: "Stop sharing" }).first().click();
  await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ state: "detached", timeout: 15_000 }).then(() => check("stopping a share takes it away from others", true)).catch(() => check("stopping a share takes it away from others", false));

  // --- Sharing a window: natively on Windows, and through Chromium where the app lists windows elsewhere ---
  await openPicker();
  // Where the system's picker chooses, there's no list of windows here.
  const windowTab = alice.page.getByRole("button", { name: "Windows" });
  if (await windowTab.count()) await windowTab.click();
  const windows = await alice.page.locator(".screen-source").count();
  if (windows > 0) {
    // The window moving since the screen was shared, where it's listed, so there's a new frame at every refresh.
    const moving = alice.page.locator(".screen-source", { hasText: "Moving" });
    await ((await moving.count()) ? moving.first() : alice.page.locator(".screen-source").first()).click();
    const nativeWindow = await alice.page.locator(".screen-native").isVisible();
    console.log(nativeWindow ? "  Sharing a window natively" : "  Chromium shares the window");
    await alice.page.getByRole("button", { name: "Share", exact: true }).click();
    await alice.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 20_000 });
    await bob.page.locator(".voice-tile.is-screen video").first().waitFor({ timeout: 15_000 }).then(() => check("a shared window reaches others", true)).catch(() => check("a shared window reaches others", false));
    await sleep(2500);
    if (nativeWindow) {
      await alice.page.getByRole("button", { name: "Stream stats" }).click();
      await sleep(3000);
      const sharingWindow = (await readStats(alice.page)).find((section) => section.title === "Your screen");
      await shot(alice, "09-window-stats");
      await alice.page.getByRole("button", { name: "Close stream stats" }).click();
      check("a window goes natively", sharingWindow?.rows["Sent through"]?.startsWith("Native") && sharingWindow?.rows["Capture and encoder"]?.startsWith("window"), `${sharingWindow?.rows["Sent through"]}: ${sharingWindow?.rows["Capture and encoder"]}`);
      check("a native window sends the frame rate that was asked for", fpsIn(sharingWindow?.rows["New frames"]) > 50, sharingWindow?.rows["New frames"]);
    } else {
      const asked = await alice.page.evaluate(() => {
        for (const connection of window.__connections) {
          for (const sender of connection.getSenders()) if (sender.track?.kind === "video" && sender.track.readyState === "live") return sender.track.getSettings().frameRate;
        }
        return null;
      });
      check("a window is captured at the frame rate that was asked for", asked === 60, `${asked} fps`);
    }
    const window = await audioFlow(bob.page, 2);
    check("a shared window decrypts", window.inVideoFrames >= 0 && (await bob.page.evaluate(() => !!window.__lastVideo)), `${window.inVideoFrames.toFixed(0)} frames/s decoded`);
    await alice.page.getByRole("button", { name: "Stop sharing" }).first().click();
  } else {
    await alice.page.getByRole("button", { name: "Cancel" }).click();
  }

  // --- What a server allows for shares, and what a device chooses ---
  const changeRules = async (change) => {
    await alice.page.locator(".server-title").click();
    await alice.page.getByRole("menuitem", { name: "Server settings" }).click();
    await alice.page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
    await change(alice.page);
    await alice.page.getByRole("button", { name: "Save changes" }).click();
    await sleep(500);
    await alice.page.keyboard.press("Escape");
    await sleep(200);
  };
  const changeOwnSettings = async (who, change) => {
    await who.page.getByLabel("Settings", { exact: true }).click();
    await who.page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
    await change(who.page);
    await who.page.keyboard.press("Escape");
    await sleep(200);
  };
  const pickAndShare = async (who, before) => {
    await who.page.getByRole("button", { name: "Share your screen" }).first().click();
    await pickerOpen(who.page);
    await before?.();
    await who.page.getByRole("button", { name: "Share", exact: true }).click();
  };
  const stopSharing = (who) => who.page.getByRole("button", { name: "Stop sharing" }).first().click();
  const screenOnAlice = alice.page.locator(".voice-tile.is-screen video").first();
  /** What Alice decodes of a screen someone else is sharing. */
  const decodedByAlice = async () => {
    await sleep(4000);
    await alice.page.evaluate(() => {
      window.__lastVideo = null;
    });
    await audioFlow(alice.page, 2);
    return alice.page.evaluate(() => window.__lastVideo);
  };
  await rowFor(alice.page, "Lounge").click();
  await rowFor(bob.page, "Lounge").click();

  await changeRules(async (page) => {
    await page.getByLabel("Largest picture").selectOption("720");
    await page.getByLabel("Highest frame rate").selectOption("30");
    await page.getByLabel("Most a share may send").selectOption("3000");
    await sleep(150);
    await shot(alice, "09-screen-rules");
  });
  await sleep(500);
  await pickAndShare(bob, async () => {
    const said = await bob.page.locator(".modal .screen-held").textContent();
    check("the picker says what the server holds shares to", said.includes("720p") && said.includes("30 fps") && said.includes("3 Mbit/s"), said);
    await sleep(200);
    await shot(bob, "09-picker-with-limits");
  });
  await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await screenOnAlice.waitFor({ timeout: 20_000 });
  const heldNative = await decodedByAlice();
  check("a limit on size holds for a share", heldNative?.height <= 720 && heldNative?.height >= 360, `${heldNative?.width}x${heldNative?.height} through ${heldNative?.decoder}`);
  await bob.page.getByRole("button", { name: "Stream stats" }).click();
  await sleep(4000);
  const heldStats = (await readStats(bob.page)).find((section) => section.title === "Your screen");
  console.log(`  Held to limits: ${JSON.stringify(heldStats)}`);
  // A second's count can take in one frame more than the rate.
  check("a limit on frame rate holds for a share", heldStats?.fps <= 32, `${heldStats?.fps} fps`);
  check("the stats say what the server held it to", heldStats?.rows["Held to the server's limits"]?.includes("720p"), heldStats?.rows["Held to the server's limits"]);
  await bob.page.getByRole("button", { name: "Close stream stats" }).click();
  await stopSharing(bob);
  await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 });

  // The same limits through the browser, along with what a device can choose for it.
  await changeOwnSettings(bob, async (page) => {
    await sleep(150);
    await shot(bob, "09-screen-settings");
    if (native) await page.getByRole("switch", { name: "Capture on your graphics card" }).click();
    await page.getByLabel("Codec").selectOption("vp8");
    await page.getByRole("switch", { name: "Also send a smaller copy" }).click();
    await page.getByRole("button", { name: "Keep it smooth" }).click();
  });
  await pickAndShare(bob);
  await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await screenOnAlice.waitFor({ timeout: 20_000 });
  const heldBrowser = await decodedByAlice();
  const captured = await bob.page.evaluate(() => {
    for (const connection of window.__connections) {
      if (connection.connectionState === "closed") continue;
      for (const sender of connection.getSenders()) {
        if (sender.track?.kind === "video" && sender.track.readyState === "live") return { settings: sender.track.getSettings(), hint: sender.track.contentHint, senders: sender.getParameters().encodings.length, preference: sender.getParameters().degradationPreference };
      }
    }
    return null;
  });
  console.log(`  Through the browser: ${JSON.stringify(captured)}, decoded ${JSON.stringify(heldBrowser)}`);
  check("a limit on size holds through the browser", captured?.settings.height <= 720 && heldBrowser?.height <= 720, `captured ${captured?.settings.width}x${captured?.settings.height}, decoded ${heldBrowser?.width}x${heldBrowser?.height}`);
  check("a limit on size keeps a screen's shape", !!captured && Math.abs(captured.settings.width / captured.settings.height - 16 / 9) < 0.02, `${captured?.settings.width}x${captured?.settings.height}`);
  check("a limit on frame rate holds through the browser", captured?.settings.frameRate <= 30, `${captured?.settings.frameRate} fps`);
  check("a share goes out in the codec that was chosen", heldBrowser?.codec === "video/VP8", heldBrowser?.codec);
  check("a share can send a smaller copy too", captured?.senders > 1, `${captured?.senders} layers`);
  check("what a share is mostly of reaches the browser", captured?.hint === "detail", captured?.hint);
  check("what gives first reaches the browser", captured?.preference === "maintain-framerate", captured?.preference);
  await stopSharing(bob);
  await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 });

  // The other codecs on offer, each of which has to get through the encryption.
  for (const [codec, mime] of [["vp9", "video/VP9"], ["h264", "video/H264"]]) {
    await changeOwnSettings(bob, (page) => page.getByLabel("Codec").selectOption(codec));
    await pickAndShare(bob);
    await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
    await screenOnAlice.waitFor({ timeout: 20_000 });
    const decoded = await decodedByAlice();
    check(`a share can go out as ${mime} and decrypt`, decoded?.codec === mime && decoded?.height <= 720, `${decoded?.width}x${decoded?.height} ${decoded?.codec} through ${decoded?.decoder}`);
    await stopSharing(bob);
    await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 });
  }

  // Sound, which the media server has to allow as well.
  const soundsSent = () =>
    bob.page.evaluate(() => {
      let count = 0;
      for (const connection of window.__connections) {
        if (connection.connectionState === "closed") continue;
        for (const sender of connection.getSenders()) if (sender.track?.kind === "audio" && sender.track.readyState === "live") count++;
      }
      return count;
    });
  // A choice of whose sound where the app can capture one app's, and a switch elsewhere.
  const soundChoice = bob.page.getByRole("combobox", { name: /^Sound/ });
  const turnSoundOn = async () => {
    if (await soundChoice.count()) await soundChoice.selectOption({ label: "Entire system" });
    else await bob.page.getByRole("switch", { name: "Share sound too" }).click();
  };
  const shareWithSound = async (route) => {
    const before = await soundsSent();
    await pickAndShare(bob, turnSoundOn);
    await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
    await screenOnAlice.waitFor({ timeout: 20_000 });
    await sleep(2500);
    check(`sound goes with a share ${route}`, (await soundsSent()) === before + 1 && (await bob.page.locator(".toast", { hasText: "without its sound" }).count()) === 0, `${before} before, ${await soundsSent()} now`);
    // How loud it is, on the share, and in the menu of whoever's sharing it.
    const tile = alice.page.locator(".voice-tile.is-screen").first();
    await tile.hover();
    const slider = tile.getByRole("slider", { name: "Stream volume" });
    const offered = await slider.isVisible().catch(() => false);
    await sleep(200);
    await shot(alice, `09d-stream-volume-${route.replaceAll(" ", "-")}`);
    await tile.getByRole("button", { name: "Mute stream" }).click();
    const silenced = await slider.inputValue();
    const saved = await alice.page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("zuna-voice-stream-volumes") ?? "{}")));
    await tile.getByRole("button", { name: "Unmute stream" }).click();
    const back = await slider.inputValue();
    await tile.click({ button: "right" });
    const inMenu = await alice.page.locator(".member-volume", { hasText: "Stream volume" }).count();
    await alice.page.keyboard.press("Escape");
    check(`a share's sound can be made quieter ${route}`, offered && silenced === "0" && saved.includes(0) && back === "1" && inMenu === 1, `slider ${offered ? "shown" : "missing"}, muted to ${silenced}, saved ${saved}, back to ${back}, ${inMenu} in the menu`);
    await stopSharing(bob);
    await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 });
  };
  // Where the app offers no sound with a share, as on macOS, there's none to check.
  await bob.page.getByRole("button", { name: "Share your screen" }).first().click();
  await pickerOpen(bob.page);
  const offersSound = (await soundChoice.count()) + (await bob.page.getByRole("switch", { name: "Share sound too" }).count()) > 0;
  await bob.page.getByRole("button", { name: "Cancel" }).click();
  if (offersSound) await shareWithSound("through the browser");
  else console.log("  This build offers no sound with a share");
  if (native) {
    await changeOwnSettings(bob, (page) => page.getByRole("switch", { name: "Capture on your graphics card" }).click());
    await shareWithSound("beside a native share");
    await changeOwnSettings(bob, (page) => page.getByRole("switch", { name: "Capture on your graphics card" }).click());
  }
  await changeRules((page) => page.getByRole("switch", { name: "Let sound go with a share" }).click());
  await sleep(500);
  await bob.page.getByRole("button", { name: "Share your screen" }).first().click();
  await pickerOpen(bob.page);
  check("without sound allowed, there's no asking for it", (await bob.page.getByRole("switch", { name: "Share sound too" }).count()) === 0 && (await soundChoice.count()) === 0);
  await bob.page.getByRole("button", { name: "Cancel" }).click();
  await changeRules((page) => page.getByRole("switch", { name: "Let sound go with a share" }).click());

  await changeOwnSettings(bob, async (page) => {
    if (native) await page.getByRole("switch", { name: "Capture on your graphics card" }).click();
    await page.getByLabel("Codec").selectOption("auto");
    await page.getByRole("switch", { name: "Also send a smaller copy" }).click();
    await page.getByRole("button", { name: "Keep it sharp" }).click();
  });

  // Who can share, and an admin stopping someone, which the media server has to carry out.
  await pickAndShare(bob);
  await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await screenOnAlice.waitFor({ timeout: 20_000 });
  await changeRules((page) => page.getByRole("button", { name: "Admins", exact: true }).click());
  await bob.page.locator(".toast", { hasText: "rules changed" }).waitFor({ timeout: 10_000 }).then(() => check("someone hears the rules stopped their share", true)).catch(() => check("someone hears the rules stopped their share", false));
  await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 }).then(() => check("a share the rules no longer allow goes away", true)).catch(() => check("a share the rules no longer allow goes away", false));
  check("someone who can't share can't start to", await bob.page.getByRole("button", { name: "Share your screen" }).first().isDisabled());
  await changeRules((page) => page.getByRole("button", { name: "Everyone", exact: true }).click());
  await sleep(500);

  await pickAndShare(bob);
  await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await screenOnAlice.waitFor({ timeout: 20_000 });
  await alice.page.locator(".voice-tile", { hasText: "Bob" }).filter({ hasNotText: "screen" }).first().click({ button: "right" });
  await alice.page.getByRole("menuitem", { name: "Stop their screen share" }).click();
  await bob.page.getByRole("button", { name: "Share your screen" }).first().waitFor({ timeout: 10_000 }).then(() => check("an admin can stop someone's share", true)).catch(() => check("an admin can stop someone's share", false));
  await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 }).then(() => check("a share an admin stopped goes away", true)).catch(() => check("a share an admin stopped goes away", false));

  // How many can share at once.
  await changeRules((page) => page.getByLabel("Shares at once in a voice channel").fill("1"));
  await pickAndShare(bob);
  await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await pickAndShare(alice);
  await alice.page.locator(".toast", { hasText: "already sharing" }).waitFor({ timeout: 10_000 }).then(() => check("a limit on how many can share holds", true)).catch(() => check("a limit on how many can share holds", false));
  check("someone turned away isn't left sharing", await alice.page.getByRole("button", { name: "Share your screen" }).first().isVisible());
  await stopSharing(bob);
  await sleep(500);
  await pickAndShare(alice);
  await alice.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 }).then(() => check("giving up a place lets someone else share", true)).catch(() => check("giving up a place lets someone else share", false));
  await stopSharing(alice);
  await sleep(500);
  await changeRules(async (page) => {
    await page.getByLabel("Shares at once in a voice channel").fill("0");
    await page.getByLabel("Largest picture").selectOption("0");
    await page.getByLabel("Highest frame rate").selectOption("0");
    await page.getByLabel("Most a share may send").selectOption("0");
  });

  // --- The chat beside a call ---
  await rowFor(bob.page, "Lounge").click();
  await bob.page.getByRole("button", { name: "Show chat" }).click();
  await bob.page.locator(".voice-chat .composer-input").fill("typing while talking");
  await bob.page.keyboard.press("Enter");
  await bob.page.locator(".voice-chat .msg.is-channel", { hasText: "typing while talking" }).waitFor({ timeout: 15_000 });
  check("a voice channel has a chat beside the call", true);
  await alice.page.locator(".voice-control-dot").waitFor({ timeout: 5000 }).then(() => check("someone in the call sees there's something new in its chat", true)).catch(() => check("someone in the call sees there's something new in its chat", false));
  check("a voice channel isn't marked as unread for its chat", (await rowFor(alice.page, "Lounge").getAttribute("class")).includes("is-unread") === false);
  await sleep(300);
  await shot(bob, "10-chat-in-voice");
  await bob.page.getByRole("button", { name: "Hide chat" }).first().click();

  // --- What admins can do, which LiveKit itself has to carry out ---
  await rowFor(alice.page, "Lounge").click();
  const bobTile = alice.page.locator(".voice-tile", { hasText: "Bob" });
  await bobTile.click({ button: "right" });
  await alice.page.locator(".member-volume").waitFor();
  await sleep(150);
  await shot(alice, "11-member-menu");
  await alice.page.getByRole("menuitem", { name: "Mute for everyone" }).click();
  await bob.page.locator(".voice-self-name", { hasText: "Muted by an admin" }).waitFor({ timeout: 10_000 });
  await sleep(2000);
  const whileServerMuted = await loudness(alice.page, 3);
  check("an admin muting someone stops their sound", whileServerMuted.in < 0.001, `peak ${whileServerMuted.in.toFixed(4)}`);
  await bobTile.click({ button: "right" });
  await alice.page.getByRole("menuitem", { name: "Let them talk" }).click();
  await bob.page.locator(".voice-self-name", { hasText: "Voice activity" }).waitFor({ timeout: 10_000 });
  await sleep(2500);
  const afterServerMute = await loudness(alice.page, 5);
  check("an admin unmuting someone lets it back", afterServerMute.in > 0.01, `peak ${afterServerMute.in.toFixed(3)}`);

  // --- Settings ---
  await alice.page.getByRole("button", { name: "Voice settings" }).click();
  await alice.page.getByRole("heading", { name: "Voice and video" }).waitFor();
  await sleep(1500);
  await shot(alice, "10-voice-settings");
  // There are gaps between words, so it's looked at for a while.
  const meter = await alice.page.waitForFunction(() => parseFloat(document.querySelector(".mic-meter-bar")?.style.width ?? "") > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check("the settings show how loud the microphone is", meter);
  await alice.page.keyboard.press("Escape");

  // --- Push to talk ---
  await alice.page.getByRole("button", { name: "Voice settings" }).click();
  await alice.page.getByRole("heading", { name: "Voice and video" }).waitFor();
  await alice.page.getByRole("button", { name: "Push to talk" }).click();
  await alice.page.getByRole("button", { name: "Not set" }).click();
  await alice.page.keyboard.press("F8");
  await alice.page.getByRole("button", { name: "F8" }).waitFor();
  await sleep(200);
  await shot(alice, "12-push-to-talk");
  await alice.page.keyboard.press("Escape");
  await sleep(2000);
  const heldUp = await loudness(bob.page, 2);
  check("with push to talk, nothing goes out until the key is held", heldUp.in < 0.001, `peak ${heldUp.in.toFixed(4)}`);
  await alice.page.keyboard.down("F8");
  const held = await loudness(bob.page, 6);
  await alice.page.keyboard.up("F8");
  check("holding the key lets sound out", held.in > 0.01, `peak ${held.in.toFixed(3)}`);
  await sleep(800);
  const letGo = await loudness(bob.page, 2);
  check("letting go stops it", letGo.in < 0.001, `peak ${letGo.in.toFixed(4)}`);

  // The same with the key held anywhere on the computer, pressed by another program.
  if (process.platform === "win32") {
    const press = (state) =>
      execFileSync(process.execPath, ["-e", `const { uIOhook, UiohookKey } = require("uiohook-napi"); uIOhook.keyToggle(UiohookKey.F8, "${state}");`], { cwd: root, stdio: "ignore" });
    await bob.page.bringToFront();
    await sleep(500);
    press("down");
    const heldElsewhere = await loudness(bob.page, 6);
    press("up");
    check("the key works from outside the window", heldElsewhere.in > 0.01, `peak ${heldElsewhere.in.toFixed(3)}`);
  }

  // --- Leaving ---
  await alice.page.getByRole("button", { name: "Disconnect from voice" }).click();
  await bob.page.locator(".voice-occupant", { hasText: "Alice" }).waitFor({ state: "detached", timeout: 10_000 });
  await alice.page.locator(".voice-panel").waitFor({ state: "detached", timeout: 5000 });
  check("leaving takes away the voice panel", true);
  await alice.page.locator(".chat-title", { hasText: "general-chat" }).waitFor({ timeout: 5000 }).then(() => check("leaving goes back to what was open before", true)).catch(() => check("leaving goes back to what was open before", false));
  await sleep(300);
  await shot(alice, "11-after-leaving");

  // --- Calls in a direct message ---
  // Alice is on push to talk by now, so she holds the key while she's listened to.
  const heardBothWays = async () => {
    const toAlice = await loudness(alice.page, 4);
    await alice.page.keyboard.down("F8");
    const toBob = await loudness(bob.page, 5);
    await alice.page.keyboard.up("F8");
    return { toAlice, toBob };
  };
  await alice.page.locator(".conv-row", { hasText: "Bob" }).first().click();
  await alice.page.getByRole("button", { name: "Start a voice call" }).click();
  const ringingBob = bob.page.locator(".incoming-call", { hasText: "Alice" });
  await ringingBob.waitFor({ timeout: 20_000 }).then(() => check("a call rings the person called", true)).catch(() => check("a call rings the person called", false));
  await alice.page.locator(".voice-tile.is-ringing", { hasText: "Bob" }).waitFor({ timeout: 10_000 }).then(() => check("the one calling sees whom it's ringing", true)).catch(() => check("the one calling sees whom it's ringing", false));
  await sleep(500);
  check("nobody else is rung", (await carol.page.locator(".incoming-call").count()) === 0);
  check("nobody else sees the call", (await carol.page.locator(".conv-preview.is-call").count()) === 0);
  await shot(bob, "13-incoming-call");
  await shot(alice, "13-calling");
  await ringingBob.getByRole("button", { name: "Answer", exact: true }).click();
  await bob.page.locator(".voice-panel-status.is-connected", { hasText: "Call connected" }).waitFor({ timeout: 30_000 });
  await alice.page.locator(".voice-tile.is-ringing").waitFor({ state: "detached", timeout: 20_000 });
  check("answering takes someone out of their voice channel", (await alice.page.locator(".voice-occupant", { hasText: "Bob" }).count()) === 0);
  check("answering opens the call above its chat", (await bob.page.locator(".chat .voice-stage-wrap.is-call").count()) === 1 && (await bob.page.locator(".chat .composer-input").count()) === 1);
  await sleep(4000);
  const call = await heardBothWays();
  check("a call's audio decrypts into sound on each side", call.toAlice.in > 0.01 && call.toBob.in > 0.01, `alice hears peak ${call.toAlice.in.toFixed(3)}, bob ${call.toBob.in.toFixed(3)}`);

  await alice.page.getByRole("button", { name: "Turn on camera" }).first().click();
  await sleep(4000);
  const callCamera = await audioFlow(bob.page, 2);
  check("a camera reaches the other person in a call", callCamera.inVideoFrames > 5, `${callCamera.inVideoFrames.toFixed(0)} frames/s decoded`);
  await alice.page.getByRole("button", { name: "Turn off camera" }).first().click();
  await pickAndShare(bob);
  await bob.page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await screenOnAlice.waitFor({ timeout: 20_000 }).then(() => check("a screen shared in a call reaches the other person", true)).catch(() => check("a screen shared in a call reaches the other person", false));
  await sleep(3000);
  const callScreen = await audioFlow(alice.page, 2);
  check("a screen shared in a call decrypts", callScreen.inVideoFrames > 1, `${callScreen.inVideoFrames.toFixed(0)} frames/s decoded`);
  await shot(alice, "14-call");
  await stopSharing(bob);
  await screenOnAlice.waitFor({ state: "detached", timeout: 15_000 });
  await alice.page.getByRole("button", { name: "Hide the chat" }).click();
  check("a call can take the whole of its chat", !(await alice.page.locator(".chat-scroll").isVisible()));
  await alice.page.getByRole("button", { name: "Show the chat" }).click();

  await bob.page.locator(".voice-controls").getByRole("button", { name: "Disconnect" }).click();
  await alice.page.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 }).then(() => check("hanging up ends a direct message's call for both", true)).catch(() => check("hanging up ends a direct message's call for both", false));

  await alice.page.getByRole("button", { name: "Start a voice call" }).click();
  await ringingBob.getByRole("button", { name: "Decline" }).click({ timeout: 20_000 });
  await alice.page.locator(".toast", { hasText: "declined the call" }).waitFor({ timeout: 10_000 }).then(() => check("declining ends the call for the one calling", true)).catch(() => check("declining ends the call for the one calling", false));
  await alice.page.locator(".voice-panel").waitFor({ state: "detached", timeout: 5000 });
  check("declining stops the ringing", (await bob.page.locator(".incoming-call").count()) === 0);

  // Someone new can't open what others send under the old key for a moment, until they all move on to the new one.
  const realErrors = errors.filter((error) => !error.includes("MissingKey"));
  check("nothing went wrong on the page", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
} catch (error) {
  failed = error;
  console.error(error);
  for (const entry of apps) await entry.page.screenshot({ path: join(shots, `failed-${entry.name}.png`) }).catch(() => undefined);
} finally {
  for (const entry of apps) await entry.electronApp.close().catch(() => undefined);
  server.kill();
  liveKit.kill();
  tlsFront.close();
  await sleep(300);
  for (const dir of [data, fixtures, certificates, ...apps.map((entry) => entry.userData)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a file open for a moment longer.
    }
  }
}

console.log(`\nScreenshots are in ${shots}`);
if (failed || failures.length > 0) {
  console.error(failed ? "It stopped partway." : `${failures.length} checks failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("All voice checks passed.");
process.exit(0);
