// Opens a local test server that's ready to use: an owner account, a name, an
// emote set, an invite link, and people online to talk to. It's set up on the
// first run and kept in .dev-data after that. `npm run dev:clean` starts over.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { devData, devServerRunning, devWorld, devWorldFile, ensureBuilt, env, root, run } from "./lib.mjs";

const URL = "http://localhost:8787";
const serverData = join(devData, "server");
const logPath = join(devData, "server.log");

if (await devServerRunning()) {
  console.log(`The test server is already running at ${URL}.`);
  process.exit(0);
}

ensureBuilt();

// A setup that was cut short leaves nothing worth keeping.
const firstRun = !existsSync(devWorldFile) || !existsSync(join(serverData, "zuna.db"));
if (firstRun) {
  rmSync(serverData, { recursive: true, force: true });
  rmSync(devWorld, { recursive: true, force: true });
}
mkdirSync(devWorld, { recursive: true });
const log = createWriteStream(logPath, { flags: "a" });

const binary = join(devData, "bin", process.platform === "win32" ? "zuna-server.exe" : "zuna-server");
run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], { cwd: join(root, "server") });

const children = [];
let stopping = false;
const stop = (code = 0) => {
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(signal, () => stop());

function fail(message) {
  console.error(`\n${message}\nThe full log is in ${logPath}`);
  stop(1);
}

// The server first, since setting everything up needs its one-time setup link.
const server = spawn(binary, ["--listen", "127.0.0.1:8787", "--data", serverData, "--public-url", URL, "--auth-burst", "1000"], {
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(server);
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
  log.write(chunk);
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
  log.write(chunk);
  if (serverReady) process.stderr.write(chunk);
});
server.on("exit", () => {
  if (!stopping) fail(`The server stopped unexpectedly:\n${serverOutput.slice(-1000)}`);
});

let serverReady = false;
const setupLink = () => serverOutput.match(/http:\/\/\S+\/invite\/\S+/)?.[0];
for (let i = 0; !serverReady; i++) {
  if (i > 150) fail(`The server didn't start:\n${serverOutput.slice(-1000)}`);
  serverReady = (await devServerRunning()) && (!firstRun || !!setupLink());
  if (!serverReady) await new Promise((resolve) => setTimeout(resolve, 100));
}

console.log(firstRun ? "Setting up the server and its people. This only happens once..." : "Bringing everyone back online...");

// vite-node's own command, wherever its version keeps it.
const viteNodeDir = join(root, "node_modules", "vite-node");
const viteNode = join(viteNodeDir, JSON.parse(readFileSync(join(viteNodeDir, "package.json"), "utf8")).bin["vite-node"]);
const bots = spawn(process.execPath, [viteNode, "test/dev-bots.ts"], {
  cwd: join(root, "packages", "core"),
  env: { ...env, ZUNA_DEV_WORLD: devWorld, ZUNA_DEV_SETUP_LINK: setupLink() ?? "" },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(bots);
let botOutput = "";
const ready = new Promise((resolve) => {
  const onData = (chunk) => {
    botOutput += chunk;
    log.write(chunk);
    if (botOutput.includes("Bots are ready")) resolve();
  };
  bots.stdout.on("data", onData);
  bots.stderr.on("data", onData);
});
bots.on("exit", () => {
  if (stopping) return;
  const output = botOutput.slice(-1500);
  if (existsSync(devWorldFile)) console.error(`\nThe test people went offline, but the server is still running:\n${output}`);
  else fail(`Setting up the server failed:\n${output}`);
});

await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 180_000))]);
if (!botOutput.includes("Bots are ready")) fail(`Setting up the server took too long:\n${botOutput.slice(-1500)}`);

const world = JSON.parse(readFileSync(devWorldFile, "utf8"));
console.log(`
  ${world.name} is ready

  Sign in as the owner, with conversations already going:
    Address       ${world.url}
    Username      ${world.username}
    Password      ${world.password}
    Recovery key  ${world.recoveryKey}

  Or create a new account with this invite link:
    ${world.invite}

  ${world.people.join(", ")} are online and reply to direct messages.

  Open the app with:  npm run dev
  Keep this window open. Press Ctrl+C to stop the server.
`);
