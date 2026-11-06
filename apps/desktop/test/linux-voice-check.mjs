// Checks voice in the native app on Linux: a voice channel, and calls each way in a direct
// message, with the Electron app as the other person, on a real LiveKit behind TLS, in a KWin
// of its own. The native app's microphone and
// speakers are PipeWire devices of the check's own, which nobody hears: spoken words go into
// the microphone, and what it plays is recorded. The Electron app's microphone is Chromium's
// fake device, and what reaches it is measured in its page, as voice-check.mjs does. The
// native app's camera is a v4l2loopback device, fed FFmpeg's test pattern in YUYV, or in the
// pixel format `ZUNA_CHECK_CAMERA_FORMAT` names.
//
//   npm run build -w @zuna/desktop-electron-legacy && node apps/desktop/test/linux-voice-check.mjs [screenshot-dir]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { _electron as electron } from "playwright-core";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../scripts/lib.mjs";
import { appBinary, inside, outside, root, sleep, until } from "./linux-session.mjs";

outside(import.meta.url);
const { work, session, check, start, shot, quietSpeakers, loudestOn, startServer, startKeyring, startDriver, core, finish } = await inside({ shots: process.argv[2] });

/** The first v4l2loopback device, which the person loads once, as it needs root. */
function loopbackCamera() {
  const listed = spawnSync("v4l2-ctl", ["--list-devices"], { encoding: "utf8" }).stdout ?? "";
  return listed.split("\n\n").find((device) => device.includes("v4l2loopback"))?.match(/\/dev\/video\d+/)?.[0];
}

/** How much a part of a screenshot varies, from 0 for one color. */
function spreadIn(file, [x, y, width, height]) {
  return Number(execFileSync("magick", [file, "-crop", `${width}x${height}+${x}+${y}`, "+repage", "-colorspace", "Gray", "-format", "%[fx:standard_deviation]", "info:"], { encoding: "utf8" }));
}

/** The share of a part of two screenshots that differs, from 0 to 1. */
function changedIn(first, second, [x, y, width, height]) {
  const compared = spawnSync("magick", [first, second, "-crop", `${width}x${height}+${x}+${y}`, "+repage", "-fuzz", "3%", "-metric", "AE", "-compare", "-format", "%[distortion]", "info:"], { encoding: "utf8" });
  return Number(compared.stdout.trim());
}

/** How many frames a second of others' video the Electron app decodes, and how much its pictures vary, from 0 for one color. */
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

/** How loud what's arriving at the Electron app really is, listening to its tracks. */
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

let electronApp;
let failed;
try {
  // --- Sounds: spoken words for each side ---
  const sounds = mkdtempSync(join(tmpdir(), "zuna-linux-voice-sounds-"));
  const nativeSpeech = join(sounds, "native.wav");
  const electronSpeech = join(sounds, "electron.wav");
  execFileSync("espeak-ng", ["-w", nativeSpeech, Array(6).fill("This is the native app on Linux, speaking into its own microphone. One two three four five.").join(" ")], { stdio: "ignore" });
  execFileSync("espeak-ng", ["-w", electronSpeech, "This is the Electron app, talking to the native one. Can you hear me? Six seven eight nine ten."], { stdio: "ignore" });

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
  start(appBinary, [], { ...session, ZUNA_DATA_DIR: appData, RUST_LOG: "warn,zuna=info", ...trust }, "app");
  const first = await until(windowOf, "the app's window", 30_000);
  await drive({ do: "click", x: first.x + 300, y: first.y + 16, count: 2 });
  await sleep(2500);
  await shot("01-native-ready");

  // --- The Electron app, the other person ---
  electronApp = await electron.launch({
    args: [join(root, "apps", "desktop-electron-legacy"), `--user-data-dir=${join(work, "electron")}`, "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${electronSpeech}`, "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors", "--mute-audio", "--ozone-platform=wayland"],
    env: { ...session, ELECTRON_RENDERER_URL: "", ...trust },
  });
  const page = await electronApp.firstWindow();
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
  // The Electron app's window out of the way, as the two share the KWin and activating one
  // doesn't raise it. Its page goes on as before.
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await drive({ do: "activate", appId: "zuna-native" });
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
  check("what's said into the native app's microphone, through PipeWire, reaches the Electron app", heard.peak > 0.01, `peak ${heard.peak.toFixed(3)} from ${heard.receivers} tracks`);

  // What the native app plays, recorded from its speakers.
  const played = await loudestOn(speakers, 5);
  check("what the Electron app says plays out of the native app's speakers, through PipeWire", played > 0.01, `peak ${played.toFixed(3)}`);
  await shot("04-both-talking");

  // --- Cameras both ways ---
  // The tiles' insides, clear of their names and borders: the Electron app's, then the native app's.
  const [electronTile, nativeTile] = [[430, 340, 420, 200], [930, 340, 420, 200]];
  if (!camera) check("a v4l2loopback device to stand in for a camera", false, "load v4l2loopback");
  else {
    await drive({ do: "click", x: 146, y: 843 });
    await sleep(4000);
    const seen = await videoIn(page);
    check("the native app's camera, read through V4L2, reaches the Electron app", seen.fps > 5 && seen.spread > 0.1, `${seen.fps.toFixed(1)} frames/s decoded, spread ${seen.spread.toFixed(3)}`);
    const own = await shot("04b-native-camera");
    // An avatar's tile spreads to about 0.08.
    check("and the native app shows it on its own tile", spreadIn(own, nativeTile) > 0.15, `spread ${spreadIn(own, nativeTile).toFixed(3)}`);
  }
  await page.getByRole("button", { name: "Turn on camera" }).first().click();
  await sleep(4000);
  const earlier = await shot("04c-both-cameras");
  await sleep(1000);
  const moved = changedIn(earlier, await shot("04d-both-cameras-later"), electronTile);
  // Chromium's fake camera only turns a shape and counts, where an avatar's tile doesn't change at all.
  check("the Electron app's camera plays in the native app", moved > 0.003, `${(moved * 100).toFixed(1)}% of it changed in a second`);
  await page.getByRole("button", { name: "Turn off camera" }).first().click();
  if (camera) await drive({ do: "click", x: 146, y: 843 });
  await sleep(1500);

  // --- A call in their direct message, from the Electron app ---
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
  check("in the call, what's said into the native app reaches the Electron app", heardInCall.peak > 0.01, `peak ${heardInCall.peak.toFixed(3)} from ${heardInCall.receivers} tracks`);
  const playedInCall = await loudestOn(speakers, 4);
  check("and what the Electron app says plays out of the native app", playedInCall > 0.01, `peak ${playedInCall.toFixed(3)}`);
  await drive({ do: "click", x: 360, y: 802 });
  const hungUp = await page.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 }).then(() => true).catch(() => false);
  check("hanging up in the native app ends the call for both", hungUp);
  await sleep(1500);
  await shot("07-after-call");

  // --- A call from the native app, from the call button in its chat's header ---
  const ringingElectron = page.locator(".incoming-call", { hasText: "Linux Owner" });
  await drive({ do: "click", x: 1238, y: 58 });
  check("a call from the native app rings the Electron app", await ringingElectron.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false));
  const ringingOut = await loudestOn(speakers, 3);
  check("and rings out of the native app's own speakers while it waits", ringingOut > 0.01, `peak ${ringingOut.toFixed(3)}`);
  await shot("08-calling");
  await ringingElectron.getByRole("button", { name: "Answer", exact: true }).click();
  const connected = await page.locator(".voice-panel-status.is-connected", { hasText: "Call connected" }).waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
  check("the Electron app answers it", connected);
  await sleep(3000);
  const toNative = await loudestOn(speakers, 3);
  check("and is heard in the native app", toNative > 0.01, `peak ${toNative.toFixed(3)}`);
  await page.locator(".voice-controls").getByRole("button", { name: "Disconnect" }).click();
  // After the tones for the other leaving and for the call ending, the Electron app's speech,
  // which goes on, is no longer heard.
  await sleep(5000);
  await shot("09-other-hung-up");
  const afterHangUp = await loudestOn(speakers, 3);
  check("the call ends in the native app when the other hangs up", afterHangUp < 0.005, `peak ${afterHangUp.toFixed(3)}`);

  // Declined: the native app stops ringing.
  await drive({ do: "click", x: 1238, y: 58 });
  await ringingElectron.waitFor({ timeout: 20_000 });
  await sleep(1000);
  await ringingElectron.getByRole("button", { name: "Decline" }).click();
  await sleep(1500);
  await shot("10-declined");
  const afterDecline = await loudestOn(speakers, 3);
  check("declining in the Electron app stops the native app ringing", afterDecline < 0.005, `peak ${afterDecline.toFixed(3)}`);

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
  // By its scrollbar, as KWin's fake wheel has no steps, which GPUI waits for from a wheel.
  await drive({ do: "drag", from: [1395, 300], to: [1395, 880] });
  await sleep(1000);
  await shot("14-camera-settings");
} catch (caught) {
  failed = caught;
}
await electronApp?.close().catch(() => undefined);
await finish(failed);
