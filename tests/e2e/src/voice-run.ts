// The iPhone app in a voice channel with the desktop app, through a real server and
// a real LiveKit, checking what actually reaches each of them: the phone hears the
// desktop and is heard, sees its camera and its shared screen, and sends its own
// camera and screen, all under keys from the channel's MLS group, also once someone
// new has changed them; and an admin's mute holds.
//
//   npm run build -w @zuna/desktop && npm run test:ios:voice [-- screenshot-dir]
//
// The phone's microphone is a tone, and its camera and its screen moving bars
// (VoiceTesting.swift), since the simulator has no camera, and nothing can answer
// the system's picker for a screen. The desktop's are Chromium's fake devices,
// with speech from `say` for its gate to let through, and its shared screen is
// drawn on a canvas, since macOS's own picker can't be driven.

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";
import { HostApp } from "./host";
import { root } from "./paths";
import { BUNDLE_ID, boot, buildApp, installFresh, simulatorId } from "./simulator";

const shots = process.argv.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? mkdtempSync(join(tmpdir(), "zuna-ios-voice-"));
mkdirSync(shots, { recursive: true });
const failures: string[] = [];
function check(name: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}
const log = (message: string) => console.log(`[voice-run] ${message}`);

// --- The phone ---

log("building the core bundle and the app");
execFileSync(process.execPath, [join(root, "apps", "ios", "core-bundle", "build.mjs")], { stdio: "inherit" });
buildApp();
const udid = simulatorId();
boot(udid);
installFresh(udid);
// No system questions in the way: the tone and the bars stand in for what they'd allow.
for (const service of ["microphone", "camera"]) {
  try {
    execFileSync("xcrun", ["simctl", "privacy", udid, "grant", service, BUNDLE_ID], { stdio: "ignore" });
  } catch {
    log(`the simulator wouldn't grant ${service}`);
  }
}

// --- A server and a media server ---

const fixtures = mkdtempSync(join(tmpdir(), "zuna-ios-voice-sounds-"));
const speech = join(fixtures, "speech.wav");
execFileSync("say", ["-o", speech, "--data-format=LEI16@48000", "Testing the voice channel from the desktop. Can the phone hear me? One two three four five. The quick brown fox jumps over the lazy dog, again and again, until someone answers."]);

const liveKitBinary = execFileSync(process.execPath, ["-e", "import('./scripts/lib.mjs').then((lib) => console.log(lib.ensureLiveKit()))"], { cwd: root, encoding: "utf8" }).trim();
const liveKitConfig = execFileSync(process.execPath, ["-e", "import('./scripts/lib.mjs').then((lib) => process.stdout.write(lib.LIVEKIT_CONFIG))"], { cwd: root, encoding: "utf8" });
const liveKitPort = 17900 + Math.floor(Math.random() * 50);
const liveKit = spawn(liveKitBinary, ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort), "--keys", "key: a-long-enough-secret-for-signing-tokens", "--config-body", liveKitConfig], { stdio: ["ignore", "pipe", "pipe"] });
const liveKitLog = createWriteStream(join(shots, "livekit-server.log"));
liveKit.stdout.pipe(liveKitLog);
liveKit.stderr.pipe(liveKitLog);
// The app's own log and LiveKit's in it, with everything LiveKit says (-ZunaVoiceLog).
const phoneLog = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", "debug", "--predicate", 'subsystem == "chat.zuna" OR subsystem == "io.livekit.sdk"'], { stdio: ["ignore", "pipe", "ignore"] });
phoneLog.stdout.pipe(createWriteStream(join(shots, "phone.log")));

loadCrypto();
const server = new TestServer({ liveKit: `ws://127.0.0.1:${liveKitPort}` });
await server.start();

let desktop: { app: ElectronApplication; page: Page } | null = null;
let phone: HostApp | null = null;
const others: TestApp[] = [];

/** What arrived at the phone from each participant, once decrypted and decoded. */
interface Reading {
  key: string;
  frames?: number;
  width?: number;
  height?: number;
  level?: number;
  samples?: number;
  packets?: number;
  /** What the frame cryptor last said about the track, "ok" once a frame opened with its sender's key. */
  cryption?: string;
  failures?: number;
}

try {
  const alice = await new TestApp("alice-laptop").open();
  others.push(alice);
  await alice.register(server.setupLink, "alice");
  const lounge = await alice.session.createChannel({ type: "voice", name: "Lounge" });
  const invite = await alice.session.createInvite(0, 0);

  // --- The desktop app ---
  log("starting the desktop app");
  const userData = mkdtempSync(join(tmpdir(), "zuna-ios-voice-desktop-"));
  // Without the sandbox, as macOS's keeps the audio service from opening the speech, and the fake device sends silence.
  const app = await electron.launch({
    args: [join(root, "apps", "desktop"), `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${speech}`, "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  const page = await app.firstWindow();
  desktop = { app, page };
  page.on("console", (message) => {
    if (message.text().includes("[zuna]") || message.type() === "error" || process.env.VOICE_DEBUG) console.log(`  [desktop] ${message.type()}: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __connections: RTCPeerConnection[] };
    const Original = window.RTCPeerConnection;
    w.__connections = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        w.__connections.push(this);
      }
    } as typeof RTCPeerConnection;
    // A screen to share without macOS's picker: a canvas with something moving on it.
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d")!;
      let frame = 0;
      setInterval(() => {
        frame++;
        context.fillStyle = "#123";
        context.fillRect(0, 0, 1280, 720);
        context.fillStyle = "#0f0";
        context.fillRect((frame * 8) % 1200, 300, 80, 80);
        context.fillStyle = "#fff";
        context.font = "48px sans-serif";
        context.fillText(`Shared screen ${frame}`, 40, 80);
      }, 33);
      return canvas.captureStream(30);
    };
  });
  await page.reload();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 832));
  await page.getByLabel("Invite link").fill(invite, { timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Dana", { timeout: 15_000 });
  await page.getByPlaceholder(/username/i).fill("dana").catch(() => undefined);
  await page.locator('input[type="password"]').fill("voice-check-Pass-Dana-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".server-title").waitFor({ timeout: 20_000 });
  const loungeRow = page.locator(".channel-row", { hasText: "Lounge" });
  await loungeRow.waitFor({ timeout: 30_000 });

  // --- The phone ---
  log("starting the app in the simulator");
  phone = await new HostApp("bob-iphone", { target: "simulator", args: ["-ZunaFakeMicrophone", "YES", "-ZunaFakeCamera", "YES", "-ZunaFakeScreen", "YES", "-ZunaVoiceLog", "YES", "-ZunaAskForNotifications", "NO", "-ZunaPushRelay", ""] }).open();
  await phone.register(invite, "bob");
  const bobId = await phone.userId();
  await waitFor(async () => (await phone!.session.getChannels()).some((channel) => channel.id === lounge && channel.conversation?.ready), "the phone to come into the Lounge's group", 30_000);
  const danaId = alice.session.getUsers().find((user) => user.displayName === "Dana")?.id ?? "";

  /** A command for the app, which fails rather than waits for ever if the app has gone or stopped answering. */
  const command = (name: string, fields: Record<string, unknown> = {}): Promise<string> =>
    Promise.race([
      phone!.hostCommand(name, fields),
      phone!.waitUntilGone().then(() => Promise.reject(new Error(`the app went away during ${name}`))),
      sleep(60_000).then(() => Promise.reject(new Error(`the app didn't answer ${name} within a minute`))),
    ]);
  const voiceState = async () => JSON.parse(await command("voiceState")) as { status: string; serverMuted: boolean; camera: boolean; screen: boolean; epoch: number | null; focus: string | null; videos: { id: string; source: string; userId: string; local: boolean }[] };
  const report = async () => JSON.parse(await command("voiceReport")) as Reading[];
  const fromDana = async (source: string) => (await report()).find((reading) => reading.key.startsWith(`${danaId}.`) && reading.key.endsWith(`/${source}`));
  /**
   * Whether the desktop's sound reaches the phone and opens there, with what both ends say about it: so a quiet
   * phone can be told from a quiet desktop, and sound that doesn't arrive from sound that doesn't decrypt.
   */
  const phoneHears = async (since = 0) => {
    const reading = await fromDana("microphone");
    const packets = reading?.packets ?? 0;
    const sent = await desktopSends();
    const sending = `the desktop's microphone at ${sent.level.toFixed(4)}, ${sent.bytes} bytes sent`;
    if (!reading) return { ok: false, packets, detail: `nothing from the desktop; ${sending}` };
    const level = reading.level ?? 0;
    return {
      ok: level > 0.005,
      packets,
      detail: `level ${level.toFixed(4)} over ${reading.samples ?? 0} samples, ${packets - since} packets, decryption ${reading.cryption ?? "not reported"}, ${reading.failures ?? 0} frames that didn't open; ${sending}`,
    };
  };
  /** How loud the desktop's own microphone is as it goes out, and how much sound it has sent. */
  const desktopSends = () =>
    page.evaluate(async () => {
      let level = 0;
      let bytes = 0;
      for (const connection of (window as unknown as { __connections: RTCPeerConnection[] }).__connections) {
        if (connection.connectionState === "closed") continue;
        (await connection.getStats()).forEach((entry) => {
          if (entry.type === "media-source" && entry.kind === "audio") level = Math.max(level, entry.audioLevel ?? 0);
          if (entry.type === "outbound-rtp" && entry.kind === "audio") bytes += entry.bytesSent ?? 0;
        });
      }
      return { level, bytes };
    });
  const phoneShot = (name: string) => execFileSync("xcrun", ["simctl", "io", udid, "screenshot", join(shots, `${name}.png`)], { stdio: "ignore" });
  const desktopShot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

  /** How loud what's arriving at the desktop is, listening to the tracks themselves. */
  const desktopHears = (seconds = 3) =>
    page.evaluate(async (seconds) => {
      const context = new AudioContext();
      await context.resume();
      const analysers: AnalyserNode[] = [];
      for (const connection of (window as unknown as { __connections: RTCPeerConnection[] }).__connections) {
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

  /**
   * Video frames the desktop decodes each second, from everything it receives, or only what's taller than it's
   * wide: the phone's screen, as its camera is landscape.
   */
  const desktopFrames = async (seconds = 2, upright = false) => {
    const read = () =>
      page.evaluate(async (upright) => {
        let frames = 0;
        for (const connection of (window as unknown as { __connections: RTCPeerConnection[] }).__connections) {
          if (connection.connectionState === "closed") continue;
          (await connection.getStats()).forEach((entry) => {
            if (entry.type !== "inbound-rtp" || entry.kind !== "video") return;
            if (upright && !((entry.frameHeight ?? 0) > (entry.frameWidth ?? 0))) return;
            frames += entry.framesDecoded ?? 0;
          });
        }
        return frames;
      }, upright);
    const before = await read();
    await sleep(seconds * 1000);
    return ((await read()) - before) / seconds;
  };

  // --- Coming in ---
  await loungeRow.click();
  await page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  const joined = await command("voiceJoin", { channel: lounge });
  check("the phone comes into the voice channel", joined === "connected", joined);
  await waitFor(() => alice.session.getVoiceMembers().filter((member) => member.channelId === lounge).length === 2, "everyone to see both in the channel", 15_000)
    .then(() => check("everyone on the server sees the phone in the channel", true))
    .catch(() => check("everyone on the server sees the phone in the channel", false));
  await page.locator(".voice-tile", { hasText: "bob" }).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await sleep(4000);

  // --- Sound, both ways ---
  let heard = await phoneHears();
  for (let i = 0; i < 10 && !heard.ok; i++) {
    await sleep(500);
    heard = await phoneHears();
  }
  check("the phone hears the desktop, decrypted", heard.ok, heard.detail);
  const desktopPeak = await desktopHears();
  check("the desktop hears the phone, decrypted", desktopPeak > 0.02, `peak ${desktopPeak.toFixed(3)}`);

  // --- The desktop's camera on the phone ---
  await page.getByRole("button", { name: "Turn on camera" }).first().click();
  await sleep(4000);
  const camera1 = await fromDana("camera");
  await sleep(2000);
  const camera2 = await fromDana("camera");
  const cameraFrames = (camera2?.frames ?? 0) - (camera1?.frames ?? 0);
  check("the desktop's camera reaches the phone and decodes", cameraFrames > 10 && (camera2?.width ?? 0) > 0, camera2 ? `${cameraFrames} frames in 2 s at ${camera2.width}x${camera2.height}` : "none");

  // --- The phone's camera on the desktop ---
  const turnedOn = await command("voiceCamera", { on: true });
  check("the phone turns its camera on", turnedOn === "on", turnedOn);
  await sleep(4000);
  const phoneVideo = await page.locator(".voice-tile", { hasText: "bob" }).locator("video").count();
  check("the desktop shows the phone's camera on its tile", phoneVideo > 0);
  const decoded = await desktopFrames();
  check("the phone's camera reaches the desktop and decodes", decoded > 10, `${decoded.toFixed(0)} frames/s decoded, both cameras together`);
  phoneShot("01-phone-cameras");
  await desktopShot("02-desktop-cameras");

  // --- The desktop's screen on the phone ---
  await page.getByRole("button", { name: "Share your screen" }).first().click();
  const source = page.locator(".screen-source").first();
  if (await source.isVisible({ timeout: 5000 }).catch(() => false)) await source.click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await sleep(5000);
  const screen = await fromDana("screenShareVideo");
  check("the desktop's shared screen reaches the phone and decodes", (screen?.frames ?? 0) > 10, screen ? `${screen.frames} frames at ${screen.width}x${screen.height}` : "none");
  const state = await voiceState();
  check("a screen someone starts sharing fills the phone's stage", state.videos.some((video) => video.source === "screen" && video.id === state.focus));
  phoneShot("03-phone-screen");

  // --- The phone's stream stats: the first reading starts them, and the third says what's moved since the second ---
  await command("voiceStats");
  await sleep(2000);
  await command("voiceStats");
  await sleep(2000);
  const stats = await command("voiceStats");
  writeFileSync(join(shots, "phone-stream-stats.txt"), stats);
  const section = (title: RegExp) => stats.split("\n\n").find((part) => title.test(part.split("\n")[0])) ?? "";
  const rate = (part: string, label: string) => Number(new RegExp(`^${label}: ([\\d.]+) fps`, "m").exec(part)?.[1] ?? 0);
  const ownCamera = section(/^# Your camera$/);
  check("the phone's stream stats count its camera's frames going out", rate(ownCamera, "sent") > 0, /^sent: .*$/m.exec(ownCamera)?.[0] ?? "no section");
  for (const [kind, what] of [["camera", "camera"], ["screen", "shared screen"]]) {
    const theirs = section(new RegExp(`^# (?!Your ).+'s ${kind}$`));
    check(`the phone's stream stats count the desktop's ${what} decoding`, rate(theirs, "decoded") > 0 && /^Decoder: /m.test(theirs) && /^Bitrate: \d/m.test(theirs), [/^decoded: .*$/m.exec(theirs)?.[0] ?? "no section", /^Bitrate: .*$/m.exec(theirs)?.[0]].filter(Boolean).join(", "));
  }
  check("the phone's stream stats read the desktop's microphone", /^Codec: opus/m.test(section(/^# (?!Your ).+'s microphone$/)));
  check("the phone's stream stats read its own microphone", /^Codec: opus/m.test(section(/^# Your microphone$/)));
  check("the phone's stream stats say which key the call is under", /^Encryption: End to end, key \d+ from epoch \d+$/m.test(section(/^# Connection$/)));

  // --- The phone's screen on the desktop ---
  const sharing = await command("voiceScreen", { on: true });
  check("the phone shares its screen", sharing === "on", sharing);
  await waitFor(() => alice.session.getVoiceMembers().some((member) => member.userId === bobId && member.screen), "everyone to see the phone sharing", 10_000)
    .then(() => check("everyone on the server sees the phone sharing its screen", true))
    .catch(() => check("everyone on the server sees the phone sharing its screen", false));
  await sleep(4000);
  const phoneScreenTile = page.locator(".voice-tile.is-screen", { hasText: "bob's screen" });
  check("the desktop shows the phone's screen", (await phoneScreenTile.count()) > 0 && (await phoneScreenTile.locator("video").count()) > 0);
  const screenDecoded = await desktopFrames(2, true);
  check("the phone's screen reaches the desktop and decodes", screenDecoded > 10, `${screenDecoded.toFixed(0)} frames/s decoded`);
  check("the phone shows its own screen on its stage", (await voiceState()).videos.some((video) => video.source === "screen" && video.local));
  phoneShot("04-phone-sharing");
  await desktopShot("05-desktop-phone-screen");
  const stopped = await command("voiceScreen", { on: false });
  check("the phone stops sharing", stopped === "off", stopped);
  await waitFor(() => !alice.session.getVoiceMembers().some((member) => member.userId === bobId && member.screen), "everyone to see the phone stop sharing", 10_000)
    .then(() => check("everyone on the server sees the phone stop sharing", true))
    .catch(() => check("everyone on the server sees the phone stop sharing", false));
  await phoneScreenTile.first().waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  check("the desktop no longer shows the phone's screen", (await phoneScreenTile.count()) === 0);

  // --- A new key when someone new comes in ---
  const epochBefore = state.epoch;
  const carol = await new TestApp("carol-laptop").open();
  others.push(carol);
  await carol.register(invite, "carol");
  await waitFor(async () => (await voiceState()).epoch !== epochBefore, "the phone to move to the channel's new key", 30_000)
    .then(() => check("the phone moves to a new key when someone new comes into the channel", true))
    .catch(() => check("the phone moves to a new key when someone new comes into the channel", false));
  await sleep(4000);
  const afterKey = await phoneHears(heard.packets);
  check("the phone still hears the desktop after the key changed", afterKey.ok, afterKey.detail);
  const desktopAfterKey = await desktopHears();
  check("the desktop still hears the phone after the key changed", desktopAfterKey > 0.02, `peak ${desktopAfterKey.toFixed(3)}`);

  // --- An admin's mute ---
  await alice.session.voiceMute(lounge, bobId, true);
  await waitFor(async () => (await voiceState()).serverMuted, "the phone to hear it was muted", 10_000).catch(() => undefined);
  check("the phone knows an admin muted it", (await voiceState()).serverMuted);
  await sleep(2000);
  const whileMuted = await desktopHears(2);
  check("an admin's mute stops the phone's sound", whileMuted < 0.001, `peak ${whileMuted.toFixed(4)}`);
  await alice.session.voiceMute(lounge, bobId, false);
  await waitFor(async () => !(await voiceState()).serverMuted, "the phone to be let talk", 10_000).catch(() => undefined);
  await sleep(3000);
  const unmuted = await desktopHears();
  check("the phone is heard again once an admin lets it talk", unmuted > 0.02, `peak ${unmuted.toFixed(3)}`);

  // --- Leaving ---
  await command("voiceLeave");
  await waitFor(() => !alice.session.getVoiceMembers().some((member) => member.userId === bobId), "everyone to see the phone leave", 10_000)
    .then(() => check("leaving is seen by everyone", true))
    .catch(() => check("leaving is seen by everyone", false));
} catch (error) {
  console.error(error);
  failures.push(`the run stopped: ${(error as Error).message}`);
  // Where each app was when it stopped.
  await desktop?.page.screenshot({ path: join(shots, "stopped-desktop.png") }).catch(() => undefined);
  try {
    execFileSync("xcrun", ["simctl", "io", udid, "screenshot", join(shots, "stopped-phone.png")], { stdio: "ignore" });
  } catch {
    // The simulator may be gone too.
  }
} finally {
  await phone?.close();
  await desktop?.app.close().catch(() => undefined);
  for (const app of others) app.client.stop();
  await server.stop();
  liveKit.kill();
  phoneLog.kill();
  rmSync(fixtures, { recursive: true, force: true });
}

console.log(`\nScreenshots and logs: ${shots}`);
if (failures.length) {
  console.log(`${failures.length} failed:\n${failures.map((name) => `  - ${name}`).join("\n")}`);
  process.exit(1);
}
console.log("All passed.");
process.exit(0);
