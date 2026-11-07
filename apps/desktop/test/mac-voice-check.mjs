// Voice on macOS: two copies of the native app, each with a tone in place of a microphone
// (ZUNA_FAKE_MIC), in a voice channel on a test server with a LiveKit of its own, each hearing
// the other, as the log of how loud each voice decodes says. Nothing is asked of the system:
// the tone needs no microphone, and playing needs no permission.
//
//   node apps/desktop/test/mac-voice-check.mjs [screenshot-dir]

import { spawn } from "node:child_process";
import { join } from "node:path";
import { build, root, session, sleep, until } from "./mac-session.mjs";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../scripts/lib.mjs";

const { server: serverBinary } = build();
const { check, start, startServer, startApp, finish } = session({ shots: process.argv[2] });

/** A LiveKit of its own on ports nothing else here takes, as the test server's media server. */
function startLiveKit() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const config = `${LIVEKIT_CONFIG}port: ${port}\nrtc:\n  tcp_port: ${port + 1}\n  udp_port: ${port + 2}\n`;
  const media = start(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--config-body", config], process.env, "livekit");
  return { media, url: `ws://127.0.0.1:${port}` };
}

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
  await sleep(800);
  await app.click(640, 698);
}

let apps = [];
try {
  const { media, url: liveKitUrl } = startLiveKit();
  await sleep(1500);
  check("LiveKit starts", media.exitCode === null, media.output.slice(-300));
  const { setupLink } = await startServer(serverBinary, ["--livekit-url", liveKitUrl, "--livekit-key", "devkey", "--livekit-secret", "secret"]);

  const first = await startApp("first", { ZUNA_FAKE_MIC: "1", RUST_LOG: "info,zuna=debug" });
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
  await sleep(800);
  await second.click(640, 698);
  await until(async () => ((await second.core("listServers")).ok ?? []).length > 0, "the guest's account", 60_000);
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
} catch (error) {
  check("the check ran to its end", false, error.message);
} finally {
  for (const app of apps) await app.quit();
  finish();
}
