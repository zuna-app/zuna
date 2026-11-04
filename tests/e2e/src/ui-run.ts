// Runs the iOS app's UI tests (XCUITest) against a real test world, and writes
// a summary that can be read without opening Xcode.
//
//   npm run test:ios:ui [-- --only LaunchAndUnlockTests[/testName][,OtherTests...]]
//
// 1. Builds the core bundle and the app for testing.
// 2. Starts a fake 7TV and a server, and fills it: desktop clients (the
//    desktop's core in this process) with accounts, a DM and a group. A
//    second server waits to be set up.
// 3. Serves those clients to the tests over WebSockets ("peers").
// 4. Runs the tests on the dedicated simulator, recording its log.
// 5. Writes apps/ios/.e2e/<run>/summary.md, with screenshots next to it.

import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { WebSocketServer } from "ws";
import { serveCore } from "@zuna/core/rpc";
import { SOUND_RATE, writeWav } from "@zuna/core/sounds";
import { TestApp, TestServer, loadCrypto, png, waitFor } from "../../../packages/core/test/helpers";
import { startFake7TV } from "./fake7tv";
import { root } from "./paths";
import { BUNDLE_ID, boot, simulatorId } from "./simulator";
import { decodeWire, encodeWire } from "./wire";

const PASSWORD = "correct horse battery";
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const iosDir = join(root, "apps", "ios");
const derivedData = join(iosDir, "build", "DerivedData");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(iosDir, ".e2e", runId);
mkdirSync(runDir, { recursive: true });
const latest = join(iosDir, ".e2e", "latest");
rmSync(latest, { force: true });
symlinkSync(runId, latest);

const log = (message: string) => console.log(`[ui-run] ${message}`);

// --- 1. Build ---

log("building the core bundle and the app");
execFileSync(process.execPath, [join(iosDir, "core-bundle", "build.mjs")], { stdio: "inherit" });
execFileSync("xcodegen", ["generate", "--spec", "project.yml", "--quiet"], { cwd: iosDir, stdio: "inherit" });
const udid = simulatorId();
const destination = ["-destination", `id=${udid}`, "-derivedDataPath", derivedData];
execFileSync("xcodebuild", ["-project", "Zuna.xcodeproj", "-scheme", "Zuna", ...destination, "-quiet", "build-for-testing"], {
  cwd: iosDir,
  stdio: ["ignore", "ignore", "inherit"],
});

// --- 2. The world ---

log("starting the server and the desktop clients");
loadCrypto();
const fake7tv = await startFake7TV();
process.env.ZUNA_7TV_API = fake7tv.api;
process.env.ZUNA_7TV_CDN = fake7tv.cdn;
// A stand-in for zuna-push: it hands pushes to the simulator, as APNs would.
// Each registration gets a new handle, and older ones are gone, as after an
// app is reinstalled, so a test's fresh device is the only one notified.
const relay = { registrations: 0, pushes: 0, silent: 0, latest: "" };
const relayServer = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const json = JSON.parse(body || "{}");
    if (request.url === "/v1/register") {
      relay.registrations += 1;
      relay.latest = `test-${relay.registrations}-${json.token}`;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ handle: relay.latest }));
      return;
    }
    if (request.url === "/v1/push") {
      if (json.handle !== relay.latest) {
        response.statusCode = 410;
        response.end(JSON.stringify({ error: "gone" }));
        return;
      }
      relay.pushes += 1;
      if (json.type === "background") relay.silent += 1;
      const file = join(runDir, `push-${Date.now()}-${relay.pushes}.json`);
      // As the relay's: a call without a VoIP token, as in test builds, rings as an alert.
      const aps =
        json.type === "background"
          ? { "content-available": 1 }
          : json.type === "call"
            ? { alert: { title: "Zuna", body: "Incoming call" }, "mutable-content": 1, sound: "default", category: "call" }
            : { alert: { title: "Zuna", body: "New message" }, "mutable-content": 1, sound: "default", category: "message" };
      writeFileSync(file, JSON.stringify({ aps, zuna: json.data }));
      execFile("xcrun", ["simctl", "push", udid, BUNDLE_ID, file], () => undefined);
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
});
await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

// A media server for voice channels, under the keys TestServer gives its own.
const liveKitPort = 17950 + Math.floor(Math.random() * 40);
const liveKitBinary = execFileSync(process.execPath, ["-e", "import('./scripts/lib.mjs').then((lib) => console.log(lib.ensureLiveKit()))"], { cwd: root, encoding: "utf8" }).trim().split("\n").at(-1)!;
const liveKitConfig = execFileSync(process.execPath, ["-e", "import('./scripts/lib.mjs').then((lib) => process.stdout.write(lib.LIVEKIT_CONFIG))"], { cwd: root, encoding: "utf8" });
const liveKit = spawn(liveKitBinary, ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1", "--port", String(liveKitPort), "--keys", "key: a-long-enough-secret-for-signing-tokens", "--config-body", liveKitConfig], { stdio: ["ignore", "pipe", "pipe"] });
const liveKitLog = createWriteStream(join(runDir, "livekit-server.log"));
liveKit.stdout.pipe(liveKitLog);
liveKit.stderr.pipe(liveKitLog);

const server = new TestServer({ pushRelays: [relayUrl], liveKit: `ws://127.0.0.1:${liveKitPort}` });
await server.start();
// Servers nobody has set up yet: for the owner's flow, the iPad's list of servers, and choosing a server to share to.
const spare = new TestServer();
await spare.start();
const padSpare = new TestServer();
await padSpare.start();
const shareSpare = new TestServer();
await shareSpare.start();

const alice = await new TestApp("alice-laptop").open();
await alice.register(server.setupLink, "alice", PASSWORD);
const invite = await alice.session.createInvite(0, 0);
const bobLaptop = await new TestApp("bob-laptop").open();
await bobLaptop.register(invite, "bob", PASSWORD);
const carol = await new TestApp("carol-laptop").open();
await carol.register(invite, "carol", PASSWORD);
const peers: Record<string, TestApp> = { alice, carol, bobLaptop };
await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");

alice.session.sendMessage(`user:${bobLaptop.userId}`, { text: "Welcome to Zuna, Bob!" });
const weekend = await alice.session.createGroup("Weekend", [bobLaptop.userId, carol.userId], true);
alice.session.sendMessage(`group:${weekend}`, { text: "Who's up for a hike on Saturday?" });
await waitFor(() => carol.texts(`group:${weekend}`).length > 0, "the group to be ready");
carol.session.sendMessage(`group:${weekend}`, { text: "Count me in" });

// Channels, as a server usually has them: a busy #general, a quiet #links and a voice channel.
const general = await alice.session.createChannel({ type: "text", name: "general", topic: "Anything goes" });
await alice.session.createChannel({ type: "text", name: "links", topic: "Things worth a look" });
await alice.session.createChannel({ type: "voice", name: "Lounge" });
const inGeneral = (app: TestApp, text: string) => async () =>
  (await app.session.loadMessages(general)).messages.some((item) => item.text === text && item.status === "sent");
await waitFor(() => [carol, bobLaptop].every((app) => !!app.session.getChannels().find((item) => item.id === general)?.conversation?.ready), "everyone to come into #general");
const welcome = await alice.session.sendMessage(`group:${general}`, { text: "Welcome to the server, everyone 👋" });
await waitFor(inGeneral(carol, "Welcome to the server, everyone 👋"), "carol to read #general");
await carol.session.sendMessage(`group:${general}`, { text: "Glad to be here", replyTo: welcome.id });
await carol.session.toggleReaction(general, welcome.id, "👍");
await alice.session.sendMessage(`group:${general}`, { text: "Everyone on the server can read this, and the server itself can't." });
await waitFor(inGeneral(bobLaptop, "Everyone on the server can read this, and the server itself can't."), "bob's laptop to read #general");

// A sound on the soundboard: three seconds of a tone that falls, long enough to be seen playing.
const horn = Int16Array.from({ length: SOUND_RATE * 3 }, (_, index) => Math.round(Math.sin((2 * Math.PI * (660 - (index / SOUND_RATE) * 120) * index) / SOUND_RATE) * 8000));
await alice.session.addSound(new Blob([writeWav(horn)], { type: "audio/wav" }), "Airhorn", "📯");

// A website for link previews: any page is an article with a picture.
const site = createServer((request, response) => {
  if (request.url?.endsWith(".png")) {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(png(1200, 630));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<html><head><meta property="og:site_name" content="Harbour Guide"><meta property="og:title" content="The quiet harbour">
    <meta property="og:description" content="Where the boats come in at dawn, and the best place to watch them."><meta property="og:image" content="/harbour.png"></head></html>`);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

// --- 3. Peers ---

const peerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
// Things a test needs done in the world itself, over the same RPC protocol as the peers.
const extraDevices: TestApp[] = [];
const worldMethods: Record<string, (...args: any[]) => Promise<unknown>> = {
  /** Looks at the simulator's Face ID with an enrolled face, or another one. */
  async faceId(match: boolean) {
    execFileSync("xcrun", ["simctl", "spawn", udid, "notifyutil", "-p", `com.apple.BiometricKit_Sim.pearl.${match ? "match" : "nomatch"}`]);
    return true;
  },
  /** How many times the app registered with the relay, and how many pushes the relay passed on. */
  async relayCounts() {
    return { registrations: relay.registrations, pushes: relay.pushes, silent: relay.silent };
  },
  /** Delivers a push to the app as APNs would, with the payload a relay sends. */
  async push(payload: unknown) {
    const file = join(runDir, `push-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(payload));
    execFileSync("xcrun", ["simctl", "push", udid, BUNDLE_ID, file]);
    return true;
  },
  /** A file as a peer decrypts it, as bytes, since a blob can't cross as it is. */
  async download(name: string, attachment: unknown) {
    const blob = await peers[name]!.session.downloadFile(attachment as Parameters<TestApp["session"]["downloadFile"]>[0]);
    return new Uint8Array(await blob.arrayBuffer());
  },
  /** The sounds from the soundboard a peer has heard someone play, as its core told it. */
  async soundsHeard(name: string) {
    return peers[name]!.events.flatMap((event) => (event.type === "sound" ? [{ userId: event.userId, soundId: event.soundId }] : []));
  },
  /** Signs in to an account on another new device, as if on a new laptop. */
  async newDevice(name: string, password: string = PASSWORD) {
    const app = await new TestApp(`${name}-device-${extraDevices.length + 1}`).open();
    extraDevices.push(app);
    await app.login(server.url, name, password);
    return app.userId;
  },
};

peerServer.on("connection", (socket, request) => {
  if (request.url === "/world") {
    socket.on("message", async (data) => {
      const message = decodeWire(String(data)) as { id: number; method: string; args: unknown[] };
      try {
        const value = await worldMethods[message.method]!(...message.args);
        socket.send(encodeWire({ kind: "reply", id: message.id, ok: true, value }));
      } catch (error) {
        socket.send(encodeWire({ kind: "reply", id: message.id, ok: false, error: { name: "Error", message: String(error) } }));
      }
    });
    return;
  }
  const peer = peers[(request.url ?? "").slice(1)];
  if (!peer) {
    socket.close();
    return;
  }
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: unknown) => socket.send(encodeWire(message)),
  };
  serveCore(port, () => peer.client);
  socket.on("message", (data) => port.onmessage?.({ data: decodeWire(String(data)) } as MessageEvent));
});
await new Promise((resolve) => peerServer.once("listening", resolve));
const peersUrl = `ws://127.0.0.1:${(peerServer.address() as AddressInfo).port}`;

const account = (name: string, app: TestApp) => ({ username: name, password: PASSWORD, userId: app.userId, serverId: app.serverId });
const world = {
  serverUrl: server.url,
  serverName: (await alice.client.serverInfo(server.url)).name,
  invite,
  setupLink: spare.setupLink,
  padSetupLink: padSpare.setupLink,
  shareSetupLink: shareSpare.setupLink,
  pushRelay: relayUrl,
  siteUrl,
  peersUrl,
  accounts: { alice: account("alice", alice), bob: account("bob", bobLaptop), bobLaptop: account("bob", bobLaptop), carol: account("carol", carol) },
};
writeFileSync(join(runDir, "world.json"), JSON.stringify(world, null, 2));

// --- 4. Run the tests ---

log("preparing the simulator");
boot(udid);
try {
  execFileSync("xcrun", ["simctl", "uninstall", udid, BUNDLE_ID]);
} catch {
  // Not installed.
}
execFileSync("xcrun", ["simctl", "keychain", udid, "reset"]);
// Calls come in with the microphone, which a fake one stands in for, without the system's question.
execFileSync("xcrun", ["simctl", "privacy", udid, "grant", "microphone", BUNDLE_ID]);
// A face enrolled for Face ID, so App lock can be tested; tests look with it through /world.
execFileSync("xcrun", ["simctl", "spawn", udid, "notifyutil", "-s", "com.apple.BiometricKit.enrollmentChanged", "1"]);
execFileSync("xcrun", ["simctl", "spawn", udid, "notifyutil", "-p", "com.apple.BiometricKit.enrollmentChanged"]);

const deviceLog = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", "debug", "--predicate", 'subsystem == "chat.zuna"'], {
  stdio: ["ignore", "pipe", "ignore"],
});
deviceLog.stdout.pipe(createWriteStream(join(runDir, "device.log")));
// LiveKit's SDK in the app, apart from the app's own log, which it would drown.
const sdkLog = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", "info", "--predicate", 'subsystem == "io.livekit.sdk"'], {
  stdio: ["ignore", "pipe", "ignore"],
});
sdkLog.stdout.pipe(createWriteStream(join(runDir, "livekit.log")));

const resultBundle = join(runDir, "Result.xcresult");
log(`running the UI tests${only ? ` (${only})` : ""}`);
const xcodebuild = spawn(
  "xcodebuild",
  [
    "-project", "Zuna.xcodeproj",
    "-scheme", "Zuna",
    ...destination,
    "-resultBundlePath", resultBundle,
    // Otherwise a failure makes xcodebuild gather diagnostics for minutes.
    "-collect-test-diagnostics", "never",
    ...(only ? only.split(",").map((name) => `-only-testing:ZunaUITests/${name}`) : []),
    "test-without-building",
  ],
  { cwd: iosDir, env: { ...process.env, TEST_RUNNER_ZUNA_WORLD: JSON.stringify(world) }, stdio: ["ignore", "pipe", "pipe"] },
);
const buildLog = createWriteStream(join(runDir, "xcodebuild.log"));
xcodebuild.stdout.pipe(buildLog);
xcodebuild.stderr.pipe(buildLog);
const exitCode: number = await new Promise((resolve) => xcodebuild.on("exit", (code) => resolve(code ?? 1)));

deviceLog.kill();
sdkLog.kill();
for (const peer of [...Object.values(peers), ...extraDevices]) peer.client.stop();
peerServer.close();
await server.stop();
await spare.stop();
await padSpare.stop();
await shareSpare.stop();
liveKit.kill();
relayServer.close();
site.close();
await fake7tv.close();

// --- 5. Summary ---

interface TestNode {
  name: string;
  nodeType: string;
  result?: string;
  duration?: string;
  children?: TestNode[];
}

const lines: string[] = [`# iOS UI tests: ${runId}`, ""];
let failed = exitCode !== 0;
if (existsSync(resultBundle)) {
  const tests = JSON.parse(execFileSync("xcrun", ["xcresulttool", "get", "test-results", "tests", "--path", resultBundle], { encoding: "utf8" }));
  const rows: string[] = [];
  const walk = (node: TestNode, suite: string) => {
    if (node.nodeType === "Test Case") {
      const ok = node.result === "Passed";
      // A test that only runs on the other device kind skips itself.
      if (!ok && node.result !== "Skipped") failed = true;
      rows.push(`- ${ok ? "PASS" : node.result?.toUpperCase() ?? "?"} ${suite}/${node.name} (${node.duration ?? ""})`);
      for (const child of node.children ?? []) {
        if (child.nodeType === "Failure Message") rows.push(`  - ${child.name}`);
      }
      return;
    }
    for (const child of node.children ?? []) walk(child, node.nodeType === "Test Suite" ? node.name : suite);
  };
  for (const node of tests.testNodes ?? []) walk(node, "");
  lines.push("## Tests", "", ...rows, "");

  const attachments = join(runDir, "screens");
  execFileSync("xcrun", ["xcresulttool", "export", "attachments", "--path", resultBundle, "--output-path", attachments]);
  const manifestPath = join(attachments, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { attachments: { exportedFileName: string; suggestedHumanReadableName?: string }[] }[];
    // Screenshots the tests took, plus what XCTest saved about failures; not its per-query debug dumps.
    const files = manifest
      .flatMap((test) => test.attachments)
      .filter((item) => !/^(Debug description|UI Snapshot)/.test(item.suggestedHumanReadableName ?? ""))
      .map((item) => `- ${item.suggestedHumanReadableName ?? item.exportedFileName}: ${relative(runDir, join(attachments, item.exportedFileName))}`);
    if (files.length) lines.push("## Screenshots", "", ...files, "");
  }
} else {
  lines.push("No result bundle was written; see xcodebuild.log.", "");
}

const tail = (file: string, count: number) => (existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").slice(-count) : []);
if (failed) {
  lines.push("## xcodebuild (last lines)", "", "```", ...tail(join(runDir, "xcodebuild.log"), 30), "```", "");
  lines.push("## Device log (last lines)", "", "```", ...tail(join(runDir, "device.log"), 40), "```", "");
}
lines.push(`Result: ${failed ? "FAILED" : "PASSED"}`);
writeFileSync(join(runDir, "summary.md"), `${lines.join("\n")}\n`);
log(`summary: ${relative(root, join(runDir, "summary.md"))}`);
console.log(readFileSync(join(runDir, "summary.md"), "utf8"));
process.exit(failed ? 1 : 0);
