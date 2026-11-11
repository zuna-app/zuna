// Voice on macOS: two copies of the native app, each with a tone in place of a microphone
// (ZUNA_FAKE_MIC), in a voice channel on a test server with a LiveKit of its own, each hearing
// the other, as the log of how loud each voice decodes says. Nothing is asked of the system:
// the tone needs no microphone, and playing needs no permission.
//
//   node apps/desktop/test/mac-voice-check.mjs [screenshot-dir]
//
// It also shares a screen, with moving bars in place of one past macOS's picker, which the
// guest decodes with VideoToolbox and draws from the GPU, and sends voice and video messages
// from the desktop's fixtures, which the owner reads and plays through the media library. Last,
// a client in Node signs in as the owner's second device (second-device.ts) and says it's in
// the voice channel, where the app asks before it comes in and takes that device out.

import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { build, here, root, session, sleep, until } from "./mac-session.mjs";
import { LIVEKIT_CONFIG, ensureLiveKit, viteNodeArgs } from "../../../scripts/lib.mjs";

const { server: serverBinary } = build();
const { work, check, start, startServer, startApp, finish } = session({ shots: process.argv[2] });

/** A LiveKit of its own on ports nothing else here takes, as the test server's media server. */
function startLiveKit() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const config = `${LIVEKIT_CONFIG}port: ${port}\nrtc:\n  tcp_port: ${port + 1}\n  udp_port: ${port + 2}\n`;
  const media = start(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--config-body", config], process.env, "livekit");
  return { media, url: `ws://127.0.0.1:${port}` };
}

/** Where the question about a new device has its answers, and after No, Change password, in the window's points. */
const NEW_DEVICE_YES = [780, 482];
const NEW_DEVICE_NO = [660, 482];
const NEW_DEVICE_SECURE = [775, 482];

/** Onboarding as the server's owner, from the welcome screen. */
async function owner(app, setupLink) {
  await app.click(640, 502);
  await sleep(600);
  await app.type(setupLink);
  await app.key("enter");
  await sleep(2500);
  await app.shot("owner-form");
  await app.click(640, 278);
  await app.type("Mac Owner");
  await app.click(640, 355);
  await app.key("cmd-a");
  await app.type("owner");
  await app.click(614, 454);
  await app.type("mac-voice-check-owner");
  await app.click(614, 552);
  await app.type("mac-voice-check-owner");
  await createAccount(app);
}

/** Presses "Agree and create account" until the account exists: it comes on once the password's strength is worked out. */
async function createAccount(app) {
  return until(async () => {
    const servers = (await app.core("listServers")).ok ?? [];
    if (servers.length) return servers;
    await app.click(640, 698);
    await sleep(1500);
    return null;
  }, "the account to be made", 90_000);
}

let apps = [];
try {
  const { media, url: liveKitUrl } = startLiveKit();
  await sleep(1500);
  check("LiveKit starts", media.exitCode === null, media.output.slice(-300));
  const { setupLink, url: serverUrl } = await startServer(serverBinary, ["--livekit-url", liveKitUrl, "--livekit-key", "devkey", "--livekit-secret", "secret"]);

  // Moving bars in place of a screen, past macOS's picker, which nobody's here to click.
  const first = await startApp("first", { ZUNA_FAKE_MIC: "1", ZUNA_FAKE_SCREEN: "1", RUST_LOG: "info,zuna=debug" });
  apps.push(first);
  await sleep(2000);
  await first.shot("welcome");
  await owner(first, setupLink);
  const servers = await until(async () => {
    const listed = (await first.core("listServers")).ok ?? [];
    return listed.length > 0 ? listed : null;
  }, "the owner's account", 60_000);
  const serverId = servers[0].id;
  await first.shot("recovery");
  await first.click(480, 548);
  await first.click(640, 594);
  await sleep(1000);
  await first.click(640, 456);
  await first.type("Mac Voice");
  await first.click(640, 510);
  await sleep(2500);
  const channel = await first.core("createChannel", [{ type: "voice", name: "Lounge" }], serverId);
  check("the owner makes a voice channel", !!channel.ok, JSON.stringify(channel));
  const invite = (await first.core("createInvite", [10, 3600], serverId)).ok;
  check("the owner makes an invite", typeof invite === "string", String(invite));

  // --- The other person, joining through the invite ---
  const second = await startApp("second", { ZUNA_FAKE_MIC: "1", RUST_LOG: "info,zuna=debug" });
  apps.push(second);
  await sleep(2000);
  await second.click(640, 502);
  await sleep(600);
  await second.type(invite);
  await second.key("enter");
  await sleep(2500);
  await second.click(640, 278);
  await second.type("Mac Guest");
  await second.click(640, 355);
  await second.key("cmd-a");
  await second.type("guest");
  await second.click(614, 454);
  await second.type("mac-voice-check-guest");
  await second.click(614, 552);
  await second.type("mac-voice-check-guest");
  await createAccount(second);
  await sleep(1000);
  await second.click(480, 548);
  await second.click(640, 594);
  await sleep(2500);
  await first.shot("ready");
  await second.shot("ready");

  // --- Both in the voice channel, each hearing the other's tone ---
  await first.click(134, 221);
  await second.click(134, 221);
  /** The loudest a voice decoded at, from the app's log, once it's heard. */
  const loudest = (app) => Math.max(0, ...[...app.log().matchAll(/voice: \S+ peaks at ([0-9.]+)/g)].map((match) => Number(match[1])));
  const heard = await until(() => loudest(first) > 0.1 && loudest(second) > 0.1, "each to hear the other", 45_000).catch(() => false);
  check("in a voice channel, each hears the other's tone", heard, `owner ${loudest(first)}, guest ${loudest(second)}`);
  await first.shot("voice");
  await second.shot("voice");

  // --- Sharing a screen: bars from the owner, captured and encoded on the GPU, drawn as the guest decodes them ---
  await first.click(855, 795);
  await sleep(1200);
  await first.shot("screen-picker");
  await first.click(906, 625);
  const shared = await until(() => /screen share publishing from this connection/.test(first.log()), "the owner's share to go out", 30_000).catch(() => false);
  check("a screen is shared from the app's own connection", shared, first.log().split("\n").filter((line) => /screen/i.test(line)).slice(-3).join(" | "));
  const onGpu = await until(() => /video: decoded on the GPU at (\d+)×(\d+)/.exec(second.log()), "the guest to decode the share", 30_000).catch(() => null);
  check("the guest decodes the share with VideoToolbox and draws it from the GPU", !!onGpu, second.log().split("\n").filter((line) => /video|screen/i.test(line)).slice(-3).join(" | "));
  await sleep(1500);
  await second.shot("watching-share");
  await first.shot("sharing");
  // Stopping, from the same button.
  await first.click(855, 795);
  await sleep(1500);

  // --- Leaving, and the devices Core Audio lists ---
  await first.click(1017, 795);
  await second.click(1017, 795);
  await sleep(1500);
  await first.key("cmd-,");
  await sleep(600);
  await first.click(99, 206);
  await sleep(800);
  await first.shot("voice-settings");
  await first.click(1247, 63);
  await sleep(600);
  await first.shot("left");

  // --- A call in a direct message ---
  const heardBefore = { first: first.log().length, second: second.log().length };
  await first.click(168, 279);
  await sleep(1500);
  await first.click(1117, 57);
  await sleep(3000);
  await first.shot("calling");
  await second.shot("ringing");
  await second.click(796, 81);
  const since = (app, from) => Math.max(0, ...[...app.log().slice(from).matchAll(/voice: \S+ peaks at ([0-9.]+)/g)].map((match) => Number(match[1])));
  const talking = await until(() => since(first, heardBefore.first) > 0.1 && since(second, heardBefore.second) > 0.1, "each to hear the other in the call", 45_000).catch(() => false);
  check("a call is answered, and each hears the other", talking, `owner ${since(first, heardBefore.first)}, guest ${since(second, heardBefore.second)}`);
  await first.shot("in-call");
  await first.click(991, 418);
  await sleep(2000);
  await second.shot("call-ended");

  // --- Voice and video messages, read and played through FFmpeg from the media library ---
  const ownerId = servers[0].userId;
  // Each client has its own ID for the same server.
  const guestServerId = ((await second.core("listServers")).ok ?? [])[0]?.id;
  // Copied out of the checkout first: macOS asks the person before an app reads anything in
  // Desktop or Documents, where a checkout often is, and the read waits for the answer.
  const fixtures = join(root, "apps", "ios", "ZunaKit", "Tests", "ZunaHostTests", "Fixtures");
  const file = (name, mime) => {
    copyFileSync(join(fixtures, name), join(work, name));
    return { $file: { path: join(work, name), type: mime } };
  };
  const voice = await second.core("sendWithAttachments", [`user:${ownerId}`, [{ blob: file("chromium-opus.m4a", "audio/mp4"), name: "Voice message.m4a", mime: "audio/mp4", duration: 3, voice: true }], {}], guestServerId);
  check("the guest sends a voice message", !!voice.ok, JSON.stringify(voice).slice(0, 200));
  const round = await second.core("sendWithAttachments", [`user:${ownerId}`, [{ blob: file("chromium-round.mp4", "video/mp4"), name: "Video message.mp4", mime: "video/mp4", width: 480, height: 480, duration: 3, round: true }], {}], guestServerId);
  check("the guest sends a video message", !!round.ok, JSON.stringify(round).slice(0, 200));
  await sleep(4000);
  await first.shot("messages");
  // Playing the voice message: decoded by FFmpeg in the media library, played through Core Audio.
  await first.click(430, 460);
  await sleep(1800);
  await first.shot("voice-playing");

  // --- Coming into voice while another of the owner's devices is in it asks first ---
  const ownDevice = (await first.core("getSelf", [], serverId)).ok?.deviceId;
  const laptop = start(...viteNodeArgs(join(here, "second-device.ts"), serverUrl, "owner", "mac-voice-check-owner"), process.env, "second device", join(root, "packages", "core"));
  /** The owner's devices in voice, as the app has heard. */
  const ownerIn = async () => ((await first.core("getVoiceMembers", [], serverId)).ok ?? []).filter((member) => member.userId === ownerId).map((member) => member.deviceId);
  await until(() => /"ready"/.test(laptop.output), "the owner's second device to sign in", 90_000);
  // The app asks whether that was the owner, over everything, until they answer.
  const laptopId = JSON.parse(laptop.output.split("\n").find((line) => line.includes('"ready"'))).deviceId;
  const asked = async () => ((await first.core("getNewDevices", [], serverId)).ok ?? []).map((device) => device.id);
  await until(async () => (await asked()).includes(laptopId), "the app to ask about the second device", 30_000);
  await sleep(1200);
  await first.shot("new-device");
  await first.key("escape");
  await first.click(60, 60);
  await sleep(800);
  await first.shot("new-device-kept");
  check("a device signing in to the account is asked about, and Escape or a click outside doesn't send it away", (await asked()).includes(laptopId));
  await first.click(NEW_DEVICE_YES[0], NEW_DEVICE_YES[1]);
  const answered = await until(async () => (await asked()).length === 0, "Yes, it was me to answer it", 10_000).then(() => true, () => false);
  check("Yes, it was me answers it, and keeps the device", answered && ((await first.core("getDevices", [], serverId)).ok ?? []).some((device) => device.id === laptopId));
  if (!answered) await first.core("answerNewDevice", [laptopId, true], serverId);
  await sleep(800);
  laptop.stdin.write(`${JSON.stringify({ voice: channel.ok })}\n`);
  await until(async () => (await ownerIn()).length === 1, "the app to hear the second device is in the channel", 20_000);
  await sleep(500);
  await first.click(134, 221);
  await sleep(1200);
  await first.shot("voice-elsewhere");
  // Escape says no, and so does Cancel.
  await first.key("escape");
  await sleep(800);
  await first.shot("voice-elsewhere-escaped");
  await first.click(134, 221);
  await sleep(1000);
  await first.click(696, 465);
  await sleep(1500);
  const stayed = await ownerIn();
  check("coming into voice while another device is in it asks first, and Escape or Cancel changes nothing", stayed.length === 1 && stayed[0] !== ownDevice && !/"ended"/.test(laptop.output), `in voice: ${stayed.join(" ")}, this device: ${ownDevice}`);
  // Join here.
  await first.click(134, 221);
  await sleep(1000);
  await first.click(785, 465);
  const moved = await until(async () => {
    const now = await ownerIn();
    return now.length === 1 && now[0] === ownDevice && /"ended":"elsewhere"/.test(laptop.output);
  }, "the app to take the second device's place", 30_000).catch(() => false);
  check("Join here comes in, and takes the other device out", moved, laptop.output.trim().split("\n").slice(-2).join(" | "));
  await first.shot("voice-moved");
  await first.click(1017, 795);
  await sleep(1000);

  // --- Someone else signing in as the owner: No removes their device, and asks for a new password ---
  const thief = start(...viteNodeArgs(join(here, "second-device.ts"), serverUrl, "owner", "mac-voice-check-owner"), process.env, "someone else", join(root, "packages", "core"));
  await until(() => /"ready"/.test(thief.output), "someone else to sign in as the owner", 90_000);
  const thiefId = JSON.parse(thief.output.split("\n").find((line) => line.includes('"ready"'))).deviceId;
  await until(async () => (await asked()).includes(thiefId), "the app to ask about it", 30_000);
  await sleep(1200);
  await first.click(NEW_DEVICE_NO[0], NEW_DEVICE_NO[1]);
  const removed = await until(async () => !((await first.core("getDevices", [], serverId)).ok ?? []).some((device) => device.id === thiefId), "No, remove it to remove it", 20_000).then(() => true, () => false);
  await sleep(1000);
  await first.shot("new-device-removed");
  check("No, remove it removes the device", removed && (await asked()).length === 0);
  await first.click(NEW_DEVICE_SECURE[0], NEW_DEVICE_SECURE[1]);
  await sleep(1500);
  await first.shot("new-device-security");
  thief.kill();
} catch (error) {
  check("the check ran to its end", false, error.message);
} finally {
  for (const app of apps) await app.quit();
  finish();
}
