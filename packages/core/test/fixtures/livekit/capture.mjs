// Writes signalling.json beside it: every signalling message a real LiveKit and a real SDK
// sent each other in a few calls, which the relay's tests rewrite (voice-relay.test.ts). Run
// it again after LiveKit's version or the SDKs change:
//
//   node packages/core/test/fixtures/livekit/capture.mjs
//
// It runs the LiveKit `deploy/livekit` builds, on this machine's address on its network, as
// Chromium won't send media to loopback, and two people in Chromium with
// livekit-client, once with one peer connection and once with two, publishing a microphone
// and a camera, reconnecting and leaving. Needs `npx playwright-core install chromium`.
//
// Neither this machine's addresses nor anything else of it go into the file: each address in
// a message is replaced with a documentation address (RFC 5737, RFC 3849) and the message
// written again, which is the one change made. Every other message is kept byte for byte.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { JoinRequest, SignalRequest, SignalResponse, WrappedJoinRequest } from "@livekit/protocol";
import { chromium } from "playwright-core";
import { LIVEKIT_CONFIG, ensureLiveKit } from "../../../../../scripts/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..", "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = 30000 + Math.floor(Math.random() * 20000);
const config = `${LIVEKIT_CONFIG}  tcp_port: ${port + 1}\n  udp_port: ${port + 2}\nport: ${port}\n`;
const lan = Object.values(networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
if (!lan) throw new Error("This machine has no address on a network, which Chromium needs to reach LiveKit at.");
const media = spawn(ensureLiveKit(), ["--dev", "--bind", lan, "--bind", "127.0.0.1", "--node-ip", lan, "--config-body", config], { stdio: ["ignore", "pipe", "pipe"] });
let mediaLog = "";
media.stdout.on("data", (chunk) => (mediaLog += chunk));
media.stderr.on("data", (chunk) => (mediaLog += chunk));

/** An access token for LiveKit's development keys. */
function token(identity, room) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = encode({ iss: "devkey", sub: identity, nbf: now - 10, exp: now + 600, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } });
  const head = encode({ alg: "HS256", typ: "JWT" });
  return `${head}.${body}.${createHmac("sha256", "secret").update(`${head}.${body}`).digest("base64url")}`;
}

const client = readFileSync(join(root, "node_modules", "livekit-client", "dist", "livekit-client.esm.mjs"));
const page = `<!doctype html><meta charset="utf-8"><script type="module">
import * as LiveKit from "/livekit-client.esm.mjs";
window.call = async (url, tokens, single) => {
  const rooms = tokens.map(() => new LiveKit.Room({ singlePeerConnection: single, adaptiveStream: true, dynacast: true }));
  await rooms[0].connect(url, tokens[0]);
  await rooms[0].localParticipant.setMicrophoneEnabled(true);
  await rooms[0].localParticipant.setCameraEnabled(true);
  await rooms[1].connect(url, tokens[1]);
  await rooms[1].localParticipant.setMicrophoneEnabled(true);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await rooms[1].simulateScenario("signal-reconnect");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await rooms[0].localParticipant.setCameraEnabled(false);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const room of rooms) await room.disconnect();
};
</script>`;
const site = createServer((request, response) => {
  if (request.url === "/livekit-client.esm.mjs") return response.writeHead(200, { "content-type": "text/javascript" }).end(client);
  response.writeHead(200, { "content-type": "text/html" }).end(page);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));

/**
 * Addresses as documentation addresses: LiveKit's, which is this machine's, as 192.0.2.10, and
 * any other but loopback and none, as the browser's would be, as 192.0.2.1 and 2001:db8::1.
 * Only what reads whole as an address is one, so a certificate's fingerprint, which is hex
 * between colons too, stays as it is.
 */
function scrub(text) {
  return text
    .split(/([\s"\\,]|\\[rn])/)
    .map((token) => {
      if (token === lan) return "192.0.2.10";
      if (isIP(token) === 4 && token !== "127.0.0.1" && token !== "0.0.0.0") return "192.0.2.1";
      if (isIP(token) === 6 && token !== "::1" && token !== "::") return "2001:db8::1";
      return token;
    })
    .join("");
}

function scrubbed(bytes, type) {
  const before = Buffer.from(bytes).toString("latin1");
  if (scrub(before) === before) return Buffer.from(bytes);
  const json = type.fromBinary(bytes).toJsonString();
  return Buffer.from(type.fromJsonString(scrub(json)).toBinary());
}

/** The address the SDK joined by, with the join request it carries scrubbed too, compressed as it came. */
function scrubbedUrl(text) {
  const url = new URL(text.replace(/access_token=[^&]+/, "access_token=…"));
  url.host = url.host.replace(lan, "192.0.2.10");
  const value = url.searchParams.get("join_request");
  if (value) {
    const wrapped = WrappedJoinRequest.fromBinary(Buffer.from(value, "base64url"));
    const plain = wrapped.compression === 1 ? gunzipSync(wrapped.joinRequest) : wrapped.joinRequest;
    const request = JoinRequest.fromJsonString(scrub(JoinRequest.fromBinary(plain).toJsonString())).toBinary();
    wrapped.joinRequest = wrapped.compression === 1 ? gzipSync(request) : request;
    url.searchParams.set("join_request", Buffer.from(wrapped.toBinary()).toString("base64url"));
  }
  return url.toString();
}

const calls = [];
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  for (let waited = 0; !/starting LiveKit server|rtc.portTCP|"portICERange"/.test(mediaLog) && waited < 20000; waited += 200) await sleep(200);
  for (const single of [true, false]) {
    const context = await browser.newContext();
    const tab = await context.newPage();
    const sockets = [];
    tab.on("websocket", (socket) => {
      const entry = { url: scrubbedUrl(socket.url()), messages: [] };
      sockets.push(entry);
      socket.on("framereceived", (frame) => typeof frame.payload !== "string" && entry.messages.push({ from: "livekit", data: scrubbed(Buffer.from(frame.payload), SignalResponse).toString("base64") }));
      socket.on("framesent", (frame) => typeof frame.payload !== "string" && entry.messages.push({ from: "app", data: scrubbed(Buffer.from(frame.payload), SignalRequest).toString("base64") }));
    });
    await tab.goto(`http://127.0.0.1:${site.address().port}/`);
    const room = `capture-${single ? "single" : "dual"}`;
    await tab.evaluate(([url, tokens, single]) => window.call(url, tokens, single), [`ws://${lan}:${port}`, [token("ann", room), token("bob", room)], single]);
    await sleep(500);
    calls.push({ peerConnections: single ? 1 : 2, sockets });
    await context.close();
  }
} finally {
  await browser.close();
  site.close();
  media.kill();
}

const livekit = readFileSync(join(root, "deploy", "livekit", "version"), "utf8").trim().split(/\s+/)[0];
const sdk = JSON.parse(readFileSync(join(root, "node_modules", "livekit-client", "package.json"), "utf8")).version;
writeFileSync(join(here, "signalling.json"), `${JSON.stringify({ livekit, sdk: `livekit-client ${sdk}`, calls }, null, 1)}\n`);
const count = calls.flatMap((call) => call.sockets.flatMap((socket) => socket.messages)).length;
console.log(`Wrote ${count} messages from ${calls.length} calls, LiveKit ${livekit} and livekit-client ${sdk}.`);
