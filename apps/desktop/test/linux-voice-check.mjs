// Checks voice in the native app on Linux: a voice channel with the Electron app as the other
// person, on a real LiveKit behind TLS, in a KWin of its own. The native app's microphone and
// speakers are PipeWire devices of the check's own, which nobody hears: spoken words go into
// the microphone, and what it plays is recorded. The Electron app's microphone is Chromium's
// fake device, and what reaches it is measured in its page, as voice-check.mjs does.
//
//   npm run build -w @zuna/desktop-electron-legacy && node apps/desktop/test/linux-voice-check.mjs [screenshot-dir]

import { execFileSync } from "node:child_process";
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
  start("pw-loopback", ["-m", "[ MONO ]", `--capture-props=media.class=Audio/Sink node.name=${feed} node.description=Zuna_check_feed`, `--playback-props=media.class=Audio/Source node.name=${microphone} node.description=Zuna_check_microphone`], process.env, "microphone");
  await sleep(1000);

  // --- The native app, the server's owner, with a voice channel ---
  const appData = join(work, "app");
  const preview = core(appData, ["previewInvite", setupLink]);
  const { serverId } = core(appData, ["register", JSON.stringify(preview), "owner", `linux-voice-${process.pid}-owner`, JSON.stringify({ displayName: "Linux Owner" })]);
  core(appData, ["createChannel", JSON.stringify({ type: "voice", name: "Lounge" })], { ZUNA_CHECK_SERVER: serverId });
  const invite = core(appData, ["createInvite", "0", "86400"], { ZUNA_CHECK_SERVER: serverId });
  // Its own devices, as Settings would keep them.
  writeFileSync(join(appData, "voice-settings.json"), JSON.stringify({ inputDevice: microphone, outputDevice: speakers }));

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
} catch (caught) {
  failed = caught;
}
await electronApp?.close().catch(() => undefined);
await finish(failed);
