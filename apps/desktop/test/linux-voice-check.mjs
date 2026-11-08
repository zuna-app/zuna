// Checks voice in the native app on Linux: a voice channel, and calls each way in a direct
// message, with the web app in Chromium as the other person, on a real LiveKit behind TLS, in
// a KWin of its own. The native app's microphone and
// speakers are PipeWire devices of the check's own, which nobody hears: spoken words go into
// the microphone, and what it plays is recorded. The web app's microphone is Chromium's fake
// device, and what reaches it is measured in its page. The native app's camera is a
// v4l2loopback device, fed FFmpeg's test pattern in YUYV, or in the pixel format
// `ZUNA_CHECK_CAMERA_FORMAT` names.
//
//   npm run build -w @zuna/web && node apps/desktop/test/linux-voice-check.mjs [screenshot-dir]
//
// Needs Playwright's Chromium: npx playwright-core install chromium

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { chromium } from "playwright-core";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../scripts/lib.mjs";
import { appBinary, inside, outside, sleep, until } from "./linux-session.mjs";

await outside(import.meta.url);
// KWin's own global shortcuts, which the portal's push to talk goes through.
const { work, session, check, start, shot, clipboard, quietSpeakers, loudestOn, startServer, startWebHost, startKeyring, startDriver, core, finish } = await inside({ shots: process.argv[2], globalShortcuts: true });

/** The first v4l2loopback device, which the person loads once, as it needs root. */
function loopbackCamera() {
  const listed = spawnSync("v4l2-ctl", ["--list-devices"], { encoding: "utf8" }).stdout ?? "";
  return listed.split("\n\n").find((device) => device.includes("v4l2loopback"))?.match(/\/dev\/video\d+/)?.[0];
}

/** How much a part of a screenshot varies, from 0 for one color. */
function spreadIn(file, [x, y, width, height]) {
  return Number(execFileSync("magick", [file, "-crop", `${width}x${height}+${x}+${y}`, "+repage", "-colorspace", "Gray", "-format", "%[fx:standard_deviation]", "info:"], { encoding: "utf8" }));
}

/** The size of what isn't the stage's background in a part of a screenshot, as a share's black tile shows against it. */
function tileIn(file, [x, y, width, height]) {
  const box = execFileSync("magick", [file, "-crop", `${width}x${height}+${x}+${y}`, "+repage", "-alpha", "off", "-fuzz", "1.5%", "-fill", "#ff00ff", "-opaque", "#0f0f11", "-fuzz", "0", "-fill", "white", "+opaque", "#ff00ff", "-fill", "black", "-opaque", "#ff00ff", "-format", "%@", "info:"], { encoding: "utf8" });
  const [, tileWidth, tileHeight] = box.match(/^(\d+)x(\d+)/) ?? [];
  return { width: Number(tileWidth ?? 0), height: Number(tileHeight ?? 0) };
}

/** The share of a part of two screenshots that differs, from 0 to 1. */
function changedIn(first, second, [x, y, width, height]) {
  const compared = spawnSync("magick", [first, second, "-crop", `${width}x${height}+${x}+${y}`, "+repage", "-fuzz", "3%", "-metric", "AE", "-compare", "-format", "%[distortion]", "info:"], { encoding: "utf8" });
  return Number(compared.stdout.trim());
}

/** How many frames a second of others' video the web app decodes, and how much its pictures vary, from 0 for one color. */
async function videoIn(page, seconds = 2) {
  return page.evaluate(async (seconds) => {
    const decoded = async () => {
      let frames = 0;
      for (const connection of window.__connections) {
        if (connection.connectionState === "closed") continue;
        (await connection.getStats()).forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") frames += report.framesDecoded ?? 0;
        });
      }
      return frames;
    };
    const before = await decoded();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const fps = ((await decoded()) - before) / seconds;
    let spread = 0;
    for (const video of document.querySelectorAll("video")) {
      if (!video.videoWidth) continue;
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [64, 36];
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, 64, 36);
      const { data } = context.getImageData(0, 0, 64, 36);
      let [sum, squares] = [0, 0];
      for (let at = 0; at < data.length; at += 4) {
        const luma = (data[at] + data[at + 1] + data[at + 2]) / 765;
        sum += luma;
        squares += luma * luma;
      }
      const count = data.length / 4;
      spread = Math.max(spread, Math.sqrt(squares / count - (sum / count) ** 2));
    }
    return { fps, spread };
  }, seconds);
}

/** How many frames a second of its own video the web app sends. */
async function videoOut(page, seconds = 2) {
  return page.evaluate(async (seconds) => {
    const sent = async () => {
      let frames = 0;
      for (const connection of window.__connections) {
        if (connection.connectionState === "closed") continue;
        (await connection.getStats()).forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") frames = Math.max(frames, report.framesSent ?? 0);
        });
      }
      return frames;
    };
    const before = await sent();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return ((await sent()) - before) / seconds;
  }, seconds);
}

/** The next thing the web app plays after `before` things: how loud it is, how long, how far it got, its picture's width and how much that varies. */
async function playedIn(page, before, seconds = 2) {
  return page.evaluate(
    async ({ before, seconds }) => {
      const until = performance.now() + 20_000;
      while (window.__played.length <= before && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      const element = window.__played[before];
      if (!element) return { error: "nothing played" };
      const context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaElementSource(element).connect(analyser);
      let peak = 0;
      const samples = new Float32Array(2048);
      const end = performance.now() + seconds * 1000;
      while (performance.now() < end) {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      let spread = 0;
      if (element.videoWidth) {
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [48, 48];
        const drawing = canvas.getContext("2d");
        drawing.drawImage(element, 0, 0, 48, 48);
        const { data } = drawing.getImageData(0, 0, 48, 48);
        let [sum, squares] = [0, 0];
        for (let at = 0; at < data.length; at += 4) {
          const luma = (data[at] + data[at + 1] + data[at + 2]) / 765;
          sum += luma;
          squares += luma * luma;
        }
        spread = Math.sqrt(squares / (data.length / 4) - (sum / (data.length / 4)) ** 2);
      }
      await context.close();
      return { peak, duration: element.duration, at: element.currentTime, width: element.videoWidth ?? 0, spread, error: element.error?.message ?? null };
    },
    { before, seconds },
  );
}

/** How loud what's arriving at the web app really is, listening to its tracks. */
async function loudness(page, seconds = 3) {
  return page.evaluate(async (seconds) => {
    const context = new AudioContext();
    await context.resume();
    const incoming = [];
    for (const connection of window.__connections) {
      if (connection.connectionState === "closed") continue;
      for (const receiver of connection.getReceivers()) {
        if (receiver.track.kind !== "audio" || receiver.track.readyState !== "live") continue;
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(new MediaStream([receiver.track])).connect(analyser);
        incoming.push(analyser);
      }
    }
    let peak = 0;
    const samples = new Float32Array(2048);
    const until = performance.now() + seconds * 1000;
    while (performance.now() < until) {
      for (const analyser of incoming) {
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await context.close();
    return { peak, receivers: incoming.length };
  }, seconds);
}

let browser;
let failed;
try {
  // --- Sounds: spoken words for each side ---
  const sounds = mkdtempSync(join(tmpdir(), "zuna-linux-voice-sounds-"));
  const nativeSpeech = join(sounds, "native.wav");
  const webSpeech = join(sounds, "web.wav");
  execFileSync("espeak-ng", ["-w", nativeSpeech, Array(6).fill("This is the native app on Linux, speaking into its own microphone. One two three four five.").join(" ")], { stdio: "ignore" });
  execFileSync("espeak-ng", ["-w", webSpeech, "This is the web app, talking to the native one. Can you hear me? Six seven eight nine ten."], { stdio: "ignore" });

  // --- LiveKit, behind TLS as a real server's media server is ---
  const liveKitPort = 17880 + Math.floor(Math.random() * 1000);
  start(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort), "--config-body", LIVEKIT_CONFIG], process.env, "livekit");
  const certificates = mkdtempSync(join(work, "tls-"));
  const run = (...args) => execFileSync("openssl", args, { cwd: certificates, stdio: "ignore" });
  const key = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  run("req", "-x509", ...key, "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Zuna Linux voice check");
  run("req", ...key, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
  writeFileSync(join(certificates, "leaf.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "2", "-extfile", "leaf.ext");
  const tlsFront = createTlsServer({ key: readFileSync(join(certificates, "leaf.key")), cert: readFileSync(join(certificates, "leaf.crt")) }, (client) => {
    const upstream = createConnection(liveKitPort, "127.0.0.1");
    for (const socket of [client, upstream]) socket.on("error", () => undefined);
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve) => tlsFront.listen(0, "127.0.0.1", resolve));
  const mediaUrl = `wss://localhost:${tlsFront.address().port}`;
  const trust = { SSL_CERT_FILE: join(certificates, "ca.crt") };
  const { setupLink } = await startServer(["--livekit-url", mediaUrl, "--livekit-internal-url", `http://127.0.0.1:${liveKitPort}`, "--livekit-key", "devkey", "--livekit-secret", "secret"]);
  check("the check's own keyring holds the Secret Service's name", await startKeyring());

  // --- Sound devices of the check's own, on the person's PipeWire, which nobody hears ---
  const speakers = quietSpeakers("speakers");
  const microphone = `zuna_check_microphone_${process.pid}`;
  const feed = `zuna_check_feed_${process.pid}`;
  // --- The camera: FFmpeg's test pattern into v4l2loopback ---
  const camera = loopbackCamera();
  if (camera) start("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-pix_fmt", process.env.ZUNA_CHECK_CAMERA_FORMAT ?? "yuyv422", "-f", "v4l2", camera], process.env, "camera");
  const cameraName = camera ? readFileSync(`/sys/class/video4linux/${camera.slice(5)}/name`, "utf8").trim() : "";
  start("pw-loopback", ["-m", "[ MONO ]", `--capture-props=media.class=Audio/Sink node.name=${feed} node.description=Zuna_check_feed`, `--playback-props=media.class=Audio/Source node.name=${microphone} node.description=Zuna_check_microphone`], process.env, "microphone");
  await sleep(1000);

  // --- The native app, the server's owner, with a voice channel ---
  const appData = join(work, "app");
  const preview = core(appData, ["previewInvite", setupLink]);
  const { serverId } = core(appData, ["register", JSON.stringify(preview), "owner", `linux-voice-${process.pid}-owner`, JSON.stringify({ displayName: "Linux Owner" })]);
  core(appData, ["createChannel", JSON.stringify({ type: "voice", name: "Lounge" })], { ZUNA_CHECK_SERVER: serverId });
  const invite = core(appData, ["createInvite", "0", "86400"], { ZUNA_CHECK_SERVER: serverId });
  // Its own devices, as Settings would keep them.
  writeFileSync(join(appData, "voice-settings.json"), JSON.stringify({ inputDevice: microphone, outputDevice: speakers, cameraDevice: cameraName }));

  const { drive, windowOf } = await startDriver();
  // The system's default devices too, for messages recorded and played, are the check's own.
  start(appBinary, [], { ...session, ZUNA_DATA_DIR: appData, RUST_LOG: "warn,zuna=info", ZUNA_CHECK_SPEAKERS: speakers, ZUNA_CHECK_MICROPHONE: microphone, ...trust }, "app");
  const first = await until(windowOf, "the app's window", 30_000);
  // Maximized, so where things are is the same each run, by a double click on the title bar,
  // again until it takes, as a window that's only just appeared may not have drawn it yet.
  await until(async () => {
    await drive({ do: "click", x: first.x + 300, y: first.y + 16, count: 2 });
    await sleep(800);
    return (await windowOf())?.maximized;
  }, "the window to be maximized", 20_000);
  await sleep(1700);
  await shot("01-native-ready");

  // --- The web app, the other person ---
  const web = await startWebHost();
  browser = await chromium.launchPersistentContext(join(work, "chromium"), {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${webSpeech}`, "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--mute-audio", "--ozone-platform=wayland", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"],
    env: { ...session, ...trust },
  });
  await browser.grantPermissions(["microphone", "camera"], { origin: web.url.slice(0, -1) });
  const page = browser.pages()[0] ?? (await browser.newPage());
  /** The browser's window in KWin, which is whichever isn't the native app's. */
  const browserAppId = async () => (await until(async () => (await drive({ do: "windows" })).windows?.find((window) => window.appId !== "zuna"), "the browser's window", 15_000)).appId;
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    window.__connections = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) {
        super(...args);
        window.__connections.push(this);
      }
    };
    // What plays, a voice message's detached Audio too, to measure it.
    window.__played = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__played.push(this);
      return play.call(this);
    };
  });
  await page.goto(web.url);
  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(invite);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Robin", { timeout: 15_000 });
  await page.getByPlaceholder(/username/i).fill("robin").catch(() => undefined);
  await page.locator('input[type="password"]').first().fill("linux-voice-check-Robin-9182");
  await page.getByLabel("Confirm password").fill("linux-voice-check-Robin-9182");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  const lounge = page.locator(".channel-row", { hasText: "Lounge" });
  await lounge.waitFor({ timeout: 20_000 });
  await shot("02-native-with-channel");

  // --- Both in the voice channel ---
  await lounge.click();
  await page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  // The browser's window out of the way, as the two share the KWin and activating one
  // doesn't raise it. Its page goes on as before.
  await drive({ do: "minimize", appId: await browserAppId() });
  await drive({ do: "activate", appId: "zuna" });
  await sleep(800);
  await drive({ do: "click", x: 134, y: 221 });
  const native = await page.locator(".voice-occupant", { hasText: "Linux Owner" }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  check("clicking the voice channel in the native app joins it", native);
  await sleep(3000);
  await shot("03-native-in-voice");

  // Spoken words into the native app's microphone.
  start("pw-play", ["--target", feed, nativeSpeech], process.env, "speaking");
  await sleep(2000);
  const heard = await loudness(page);
  check("what's said into the native app's microphone, through PipeWire, reaches the web app", heard.peak > 0.01, `peak ${heard.peak.toFixed(3)} from ${heard.receivers} tracks`);

  // What the native app plays, recorded from its speakers.
  const played = await loudestOn(speakers, 5);
  check("what the web app says plays out of the native app's speakers, through PipeWire", played > 0.01, `peak ${played.toFixed(3)}`);
  await shot("04-both-talking");

  // --- The web app's share, filling the stage, and the channel come back to ---
  // KDE's chooser for the browser: the KWin's one screen. The share fills the stage as it
  // starts, and a stage made again on coming back from another chat drew it at the least size.
  await page.getByRole("button", { name: "Share your screen" }).first().click();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await sleep(3000);
  await drive({ do: "click", x: 700, y: 290 });
  await page.getByRole("button", { name: "Stop sharing" }).first().waitFor({ timeout: 30_000 });
  await sleep(4000);
  // Between the stage's header and the strip below a share that fills it.
  const stageArea = [386, 90, 1014, 620];
  const filled = tileIn(await shot("04-their-share"), stageArea);
  await drive({ do: "click", x: 190, y: 397 });
  await sleep(1000);
  await drive({ do: "click", x: 134, y: 221 });
  const again = tileIn(await shot("04-their-share-again"), stageArea);
  check("someone's share fills the stage as it starts, and again coming back to the channel from another chat", filled.width > 900 && again.width === filled.width && again.height === filled.height, `${filled.width}x${filled.height}, then ${again.width}x${again.height}`);
  await page.getByRole("button", { name: "Stop sharing" }).first().click();
  await sleep(2000);

  // --- The channel's chat beside the stage ---
  // Without the member list a channel's chat has elsewhere, which took 240 of its 400 px.
  await drive({ do: "click", x: 1020, y: 863 });
  await sleep(800);
  const beside = await shot("04-chat-beside");
  check("the channel's chat opens beside the stage without the member list", spreadIn(beside, [1176, 84, 200, 70]) < 0.02 && spreadIn(beside, [1130, 836, 250, 36]) > 0.05, `spread ${spreadIn(beside, [1176, 84, 200, 70]).toFixed(3)} where the list was`);
  await drive({ do: "click", x: 1150, y: 853 });
  await drive({ do: "type", text: "Hello from beside the call" });
  await drive({ do: "key", key: "enter" });
  await page.getByRole("button", { name: "Show chat" }).first().click();
  const arrived = await page.getByText("Hello from beside the call").first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  check("and what's sent from it reaches the web app", arrived);
  await page.getByRole("button", { name: "Hide chat" }).first().click();
  // Its ×, at the end of its header.
  await drive({ do: "click", x: 1374, y: 56 });
  await sleep(800);
  check("and its × hides it", spreadIn(await shot("04-chat-hidden"), [1130, 836, 250, 36]) < 0.02);

  // --- Stream stats, with both microphones muted, copied with the mouse alone ---
  await page.getByRole("button", { name: "Mute", exact: true }).first().click();
  await drive({ do: "click", x: 704, y: 863 });
  // Another app's copy, as Klipper holds one: no key has been pressed in the native app, and
  // KWin drops a selection older than the one it holds.
  spawn("wl-copy", ["Copied in another app"], { env: session, stdio: "ignore" });
  await page.getByRole("button", { name: "Stream stats" }).first().click();
  await sleep(3000);
  await drive({ do: "click", x: 1373, y: 58 });
  await sleep(2500);
  await drive({ do: "move", x: 1336, y: 111 });
  await drive({ do: "click", x: 1336, y: 111 });
  await sleep(800);
  await shot("04a-stream-stats");
  const stats = clipboard();
  check("Copy all of it puts the stream stats on Wayland's clipboard, with a click after another app copied something", stats.startsWith("# Connection") && stats.includes("# Robin's microphone"), stats.split("\n")[0]);
  const theirs = stats.split("\n\n").find((section) => section.startsWith("# Robin's microphone")) ?? "";
  const madeUp = theirs.split("\n").find((line) => line.startsWith("Made up to hide gaps"));
  check("the web app's muted microphone shows as muted in the native app, and what's made up over its silence isn't flagged", theirs.includes("Muted: Yes") && !madeUp?.endsWith("(!)"), `${madeUp}, ${theirs.split("\n").find((line) => line.startsWith("Bitrate"))}`);
  // And the native app's, in the web app's own panel.
  const desktop = await page.evaluate(() => {
    const section = [...document.querySelectorAll(".stream-stats-section")].find((element) => element.querySelector("summary")?.textContent === "Linux Owner's microphone");
    return [...(section?.querySelectorAll(".stream-stats-rows > div") ?? [])].map((row) => ({ label: row.querySelector("dt")?.textContent, value: row.querySelector("dd")?.textContent, warn: row.classList.contains("is-warn") }));
  });
  const desktopMadeUp = desktop.find((row) => row.label === "Made up to hide gaps");
  check("and the native app's in the web app's", desktop.some((row) => row.label === "Muted" && row.value === "Yes") && !desktopMadeUp?.warn, JSON.stringify(desktopMadeUp));
  // Closed by their ×es.
  await drive({ do: "click", x: 1369, y: 111 });
  await page.getByRole("button", { name: "Close stream stats" }).click();
  await page.getByRole("button", { name: "Unmute", exact: true }).first().click();
  await drive({ do: "click", x: 704, y: 863 });
  await sleep(1000);

  // --- Cameras both ways ---
  // The tiles' insides, clear of their names and their speaking borders: the web app's, then the native app's.
  const [webTile, nativeTile] = [[401, 326, 482, 230], [930, 340, 420, 200]];
  if (!camera) check("a v4l2loopback device to stand in for a camera", false, "load v4l2loopback");
  else {
    await drive({ do: "click", x: 146, y: 843 });
    await sleep(4000);
    const seen = await videoIn(page);
    check("the native app's camera, read through V4L2, reaches the web app", seen.fps > 5 && seen.spread > 0.1, `${seen.fps.toFixed(1)} frames/s decoded, spread ${seen.spread.toFixed(3)}`);
    const own = await shot("04b-native-camera");
    // An avatar's tile spreads to about 0.08.
    check("and the native app shows it on its own tile", spreadIn(own, nativeTile) > 0.15, `spread ${spreadIn(own, nativeTile).toFixed(3)}`);
  }
  await page.getByRole("button", { name: "Turn on camera" }).first().click();
  await sleep(4000);
  const earlier = await shot("04c-both-cameras");
  const sending = await videoOut(page, 1);
  const moved = changedIn(earlier, await shot("04d-both-cameras-later"), webTile);
  // Chromium's fake camera only turns a shape and counts, where an avatar's tile doesn't change at all.
  check("the web app's camera plays in the native app", moved > 0.003, `${(moved * 100).toFixed(1)}% of it changed in a second, while it sent ${sending.toFixed(0)} frames/s`);
  await page.getByRole("button", { name: "Turn off camera" }).first().click();
  if (camera) await drive({ do: "click", x: 146, y: 843 });
  await sleep(1500);

  // --- A call in their direct message, from the web app ---
  await drive({ do: "click", x: 360, y: 802 });
  const left = await page.locator(".voice-occupant", { hasText: "Linux Owner" }).waitFor({ state: "detached", timeout: 15_000 }).then(() => true).catch(() => false);
  check("leaving the voice channel in the native app takes it out", left);
  await page.getByRole("button", { name: "Disconnect from voice" }).click();
  await page.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 });
  await page.locator(".conv-row", { hasText: "Linux Owner" }).first().click();
  await page.getByRole("button", { name: "Start a voice call" }).click();
  await sleep(1500);
  await shot("05-ringing");
  const ring = await loudestOn(speakers, 3);
  check("a call rings out of the native app's speakers", ring > 0.01, `peak ${ring.toFixed(3)}`);
  // The card's Answer, at the right of a card 380 px wide centered at the top.
  await drive({ do: "click", x: 858, y: 81 });
  const answered = await page.locator(".voice-tile.is-ringing").waitFor({ state: "detached", timeout: 20_000 }).then(() => true).catch(() => false);
  check("answering the call's card in the native app joins the call", answered);
  await sleep(3000);
  await shot("06-in-call");
  start("pw-play", ["--target", feed, nativeSpeech], process.env, "speaking in the call");
  await sleep(2000);
  const heardInCall = await loudness(page);
  check("in the call, what's said into the native app reaches the web app", heardInCall.peak > 0.01, `peak ${heardInCall.peak.toFixed(3)} from ${heardInCall.receivers} tracks`);
  const playedInCall = await loudestOn(speakers, 4);
  check("and what the web app says plays out of the native app", playedInCall > 0.01, `peak ${playedInCall.toFixed(3)}`);
  await drive({ do: "click", x: 360, y: 802 });
  const hungUp = await page.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 }).then(() => true).catch(() => false);
  check("hanging up in the native app ends the call for both", hungUp);
  await sleep(1500);
  await shot("07-after-call");

  // --- A call from the native app, from the call button in its chat's header ---
  const ringingWeb = page.locator(".incoming-call", { hasText: "Linux Owner" });
  await drive({ do: "click", x: 1238, y: 58 });
  check("a call from the native app rings the web app", await ringingWeb.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false));
  const ringingOut = await loudestOn(speakers, 3);
  check("and rings out of the native app's own speakers while it waits", ringingOut > 0.01, `peak ${ringingOut.toFixed(3)}`);
  await shot("08-calling");
  await ringingWeb.getByRole("button", { name: "Answer", exact: true }).click();
  const connected = await page.locator(".voice-panel-status.is-connected", { hasText: "Call connected" }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  check("the web app answers it", connected);
  await sleep(3000);
  const toNative = await loudestOn(speakers, 3);
  check("and is heard in the native app", toNative > 0.01, `peak ${toNative.toFixed(3)}`);
  await page.locator(".voice-controls").getByRole("button", { name: "Disconnect" }).click();
  // After the tones for the other leaving and for the call ending, the web app's speech,
  // which goes on, is no longer heard.
  await sleep(5000);
  await shot("09-other-hung-up");
  const afterHangUp = await loudestOn(speakers, 3);
  check("the call ends in the native app when the other hangs up", afterHangUp < 0.005, `peak ${afterHangUp.toFixed(3)}`);

  // Declined: the native app stops ringing.
  await drive({ do: "click", x: 1238, y: 58 });
  await ringingWeb.waitFor({ timeout: 20_000 });
  await sleep(1000);
  await ringingWeb.getByRole("button", { name: "Decline" }).click();
  await sleep(1500);
  await shot("10-declined");
  const afterDecline = await loudestOn(speakers, 3);
  check("declining in the web app stops the native app ringing", afterDecline < 0.005, `peak ${afterDecline.toFixed(3)}`);

  // --- Voice and video messages, recorded here and played in the web app ---
  // The message box's microphone, recording what's said into the check's own.
  await drive({ do: "click", x: 1373, y: 875 });
  start("pw-play", ["--target", feed, nativeSpeech], process.env, "speaking a voice message");
  await sleep(4000);
  await shot("10b-recording-voice");
  // Its send button, where the microphone's was.
  await drive({ do: "click", x: 1373, y: 875 });
  let before = await page.evaluate(() => window.__played.length);
  await page.locator("button.voice-play").last().click({ timeout: 30_000 });
  const voiceMessage = await playedIn(page, before);
  check("a voice message recorded here, AAC in MP4, plays in the web app", !voiceMessage.error && voiceMessage.duration > 2 && voiceMessage.at > 0.5 && voiceMessage.peak > 0.05, JSON.stringify(voiceMessage));
  // The message box's camera, recording a video message from the check's camera and microphone.
  await drive({ do: "click", x: 1339, y: 875 });
  start("pw-play", ["--target", feed, nativeSpeech], process.env, "speaking a video message");
  await sleep(4000);
  await shot("10c-recording-round");
  await drive({ do: "click", x: 1373, y: 875 });
  before = await page.evaluate(() => window.__played.length);
  await page.locator("button.round").last().click({ timeout: 30_000 });
  const round = await playedIn(page, before);
  check("a video message recorded here, H.264 and AAC in MP4, plays in the web app", !round.error && round.width === 480 && round.at > 0.5 && round.spread > 0.1, JSON.stringify(round));
  await sleep(1000);
  await shot("10d-messages-sent");

  // --- And the other way: what the web app records, Opus in MP4 as Chromium writes it, played here ---
  await page.getByRole("button", { name: "Record a voice message" }).click();
  await sleep(3500);
  await page.getByRole("button", { name: "Send voice message" }).click();
  await sleep(4000);
  await shot("10e-voice-received");
  let listening = loudestOn(speakers, 8);
  await sleep(300);
  // The play button of the newest message, from the other side, at the bottom left, pointed
  // at first, as a hand would: the message list only takes a click where the pointer has been.
  await drive({ do: "move", x: 430, y: 789 });
  await sleep(400);
  await drive({ do: "click", x: 430, y: 789 });
  await sleep(3000);
  await shot("10f-voice-playing");
  const voiceHere = await listening;
  check("a voice message the web app recorded plays here, through PipeWire", voiceHere > 0.05, `peak ${voiceHere.toFixed(3)}`);
  await page.getByRole("button", { name: "Record a video message" }).click();
  await sleep(3500);
  await page.getByRole("button", { name: "Send video message" }).click();
  await sleep(5000);
  await shot("10g-round-received");
  // A click on a video message plays it from the start with its sound.
  listening = loudestOn(speakers, 8);
  await sleep(300);
  await drive({ do: "move", x: 520, y: 715 });
  await sleep(400);
  await drive({ do: "click", x: 520, y: 715 });
  await sleep(3000);
  await shot("10h-round-playing");
  const roundHere = await listening;
  check("a video message the web app recorded plays here with its sound", roundHere > 0.05, `peak ${roundHere.toFixed(3)}`);

  // --- Settings' Voice and video page, with the devices it lists ---
  await drive({ do: "click", x: 32, y: 834 });
  await sleep(1000);
  await drive({ do: "click", x: 100, y: 205 });
  await sleep(1500);
  await shot("11-voice-settings");
  for (const [y, name] of [[195, "12-microphones"], [327, "13-speakers"]]) {
    await drive({ do: "click", x: 809, y });
    await sleep(700);
    await shot(name);
    await drive({ do: "key", key: "escape" });
    await sleep(400);
  }

  // --- Push to talk, through the global shortcuts portal ---
  await drive({ do: "click", x: 707, y: 537 });
  await sleep(800);
  await shot("14-push-to-talk");
  // The key, chosen by pressing it in the window.
  await drive({ do: "click", x: 997, y: 596 });
  await sleep(400);
  await drive({ do: "key", key: "f8" });
  await sleep(800);
  await shot("15-key-chosen");
  const chosen = JSON.parse(readFileSync(join(appData, "voice-settings.json"), "utf8"));
  check("push to talk's key is chosen by pressing it in the window", chosen.inputMode === "ptt" && chosen.pttKey === "F8", `${chosen.inputMode}, ${chosen.pttKey}`);
  // By its scrollbar, as KWin's fake wheel has no steps, which GPUI waits for from a wheel.
  await drive({ do: "drag", from: [1395, 300], to: [1395, 880] });
  await sleep(1000);
  await shot("16-camera-settings");
  await drive({ do: "click", x: 1368, y: 64 });
  await sleep(800);

  // Both back in the voice channel, where the portal binds the key, asking first in KDE's dialog.
  await page.locator(".channel-row", { hasText: "Lounge" }).click();
  await page.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
  await drive({ do: "click", x: 134, y: 221 });
  await page.locator(".voice-occupant", { hasText: "Linux Owner" }).waitFor({ timeout: 30_000 });
  await sleep(2500);
  await shot("17-asked-for-the-key");
  await drive({ do: "click", x: 811, y: 708 });
  await sleep(1500);
  await shot("18-key-bound");
  // The browser's window in front, so that the key is held in another window.
  await drive({ do: "activate", appId: await browserAppId() });
  await sleep(1000);
  start("pw-play", ["--target", feed, nativeSpeech], process.env, "speaking with push to talk");
  await sleep(1500);
  const unheld = await loudness(page, 2);
  check("with push to talk, nothing goes out until the key is held", unheld.peak < 0.01, `peak ${unheld.peak.toFixed(3)}`);
  await drive({ do: "key", key: "f8", state: "down" });
  const held = await loudness(page, 3);
  await shot("19-key-held-elsewhere");
  await drive({ do: "key", key: "f8", state: "up" });
  check("holding the key while another window is in front sends what's said", held.peak > 0.01, `peak ${held.peak.toFixed(3)}`);
  await sleep(1500);
  const released = await loudness(page, 2);
  check("and letting it go stops it", released.peak < 0.01, `peak ${released.peak.toFixed(3)}`);

  // --- Sharing the screen, picked in the portal's own dialog ---
  await drive({ do: "minimize", appId: await browserAppId() });
  await drive({ do: "activate", appId: "zuna" });
  await sleep(800);
  await drive({ do: "click", x: 302, y: 843 });
  await sleep(1500);
  await shot("20-picker");
  // A tone for the share's sound to carry, played where nobody hears it.
  const tone = join(sounds, "tone.wav");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=660:duration=30", "-y", tone]);
  await drive({ do: "click", x: 965, y: 758 });
  await sleep(3000);
  await shot("21-portal-screen-chooser");
  // KDE's chooser: the KWin's one screen.
  await drive({ do: "click", x: 700, y: 290 });
  const screenIn = await until(async () => {
    const seen = await videoIn(page, 1);
    return seen.fps > 0 ? seen : null;
  }, "the shared screen to arrive", 30_000).catch(() => null);
  check("a screen picked in the portal's dialog reaches the web app", !!screenIn && screenIn.spread > 0.03, screenIn ? `${screenIn.fps.toFixed(1)} frames/s, spread ${screenIn.spread.toFixed(3)}` : "nothing decoded");
  start("pw-play", ["--target", speakers, tone], process.env, "playing a tone");
  await sleep(3000);
  const carried = await loudness(page, 2);
  check("and the computer's sound goes with it", carried.peak > 0.01, `peak ${carried.peak.toFixed(3)}`);
  await shot("22-sharing-screen");
  await drive({ do: "click", x: 302, y: 843 });
  await sleep(3000);
  const afterStop = await videoIn(page, 2);
  check("stopping the share ends it for the web app", afterStop.fps === 0, `${afterStop.fps.toFixed(1)} frames/s`);

  // --- Sharing a window, picked in the portal's dialog too ---
  await drive({ do: "click", x: 302, y: 843 });
  await sleep(1500);
  await drive({ do: "click", x: 519, y: 179 });
  await sleep(600);
  await shot("23-picker-window");
  await drive({ do: "click", x: 965, y: 758 });
  await sleep(3000);
  await shot("24-portal-window-chooser");
  // KDE's chooser: the first of the two windows, both called Zuna.
  await drive({ do: "click", x: 517, y: 255 });
  const windowIn = await until(async () => {
    const seen = await videoIn(page, 1);
    return seen.fps > 0 ? seen : null;
  }, "the shared window to arrive", 30_000).catch(() => null);
  check("a window picked in the portal's dialog reaches the web app", !!windowIn && windowIn.spread > 0.03, windowIn ? `${windowIn.fps.toFixed(1)} frames/s, spread ${windowIn.spread.toFixed(3)}` : "nothing decoded");
  await shot("25-sharing-window");
  await drive({ do: "click", x: 302, y: 843 });
  await sleep(3000);
  check("and stopping that ends it too", (await videoIn(page, 2)).fps === 0);
} catch (caught) {
  failed = caught;
}
await browser?.close().catch(() => undefined);
await finish(failed);
