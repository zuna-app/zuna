// Runs the iOS app's UI tests (XCUITest) against a real test world, and writes
// a summary that can be read without opening Xcode.
//
//   npm run test:ios:ui [-- --only LaunchAndUnlockTests[/testName]]
//
// 1. Builds the core bundle and the app for testing.
// 2. Starts a fake 7TV and a server, and fills it: desktop clients (the
//    desktop's core in this process) with accounts, a DM and a group.
// 3. Serves those clients to the tests over WebSockets ("peers").
// 4. Runs the tests on the dedicated simulator, recording its log.
// 5. Writes apps/ios/.e2e/<run>/summary.md, with screenshots next to it.

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { WebSocketServer } from "ws";
import { serveCore } from "@zuna/core/rpc";
import { TestApp, TestServer, loadCrypto, waitFor } from "../../../packages/core/test/helpers";
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
const server = new TestServer();
await server.start();

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

// --- 3. Peers ---

const peerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
peerServer.on("connection", (socket, request) => {
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

const deviceLog = spawn("xcrun", ["simctl", "spawn", udid, "log", "stream", "--style", "compact", "--level", "debug", "--predicate", 'subsystem == "chat.zuna"'], {
  stdio: ["ignore", "pipe", "ignore"],
});
deviceLog.stdout.pipe(createWriteStream(join(runDir, "device.log")));

const resultBundle = join(runDir, "Result.xcresult");
log(`running the UI tests${only ? ` (${only})` : ""}`);
const xcodebuild = spawn(
  "xcodebuild",
  [
    "-project", "Zuna.xcodeproj",
    "-scheme", "Zuna",
    ...destination,
    "-resultBundlePath", resultBundle,
    ...(only ? [`-only-testing:ZunaUITests/${only}`] : []),
    "test-without-building",
  ],
  { cwd: iosDir, env: { ...process.env, TEST_RUNNER_ZUNA_WORLD: JSON.stringify(world) }, stdio: ["ignore", "pipe", "pipe"] },
);
const buildLog = createWriteStream(join(runDir, "xcodebuild.log"));
xcodebuild.stdout.pipe(buildLog);
xcodebuild.stderr.pipe(buildLog);
const exitCode: number = await new Promise((resolve) => xcodebuild.on("exit", (code) => resolve(code ?? 1)));

deviceLog.kill();
for (const peer of Object.values(peers)) peer.client.stop();
peerServer.close();
await server.stop();
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
      if (!ok) failed = true;
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
