// Shares a screen through the native app's capture and LiveKit, with every native log turned on,
// while someone else in the room decrypts and decodes it, then looks for the encryption key in
// what came out. The native frame cryptor has been reported to log key material
// (webrtc-sdk/webrtc#308), and logs end up in bug reports. docs/SECURITY_DETAILS.md cites it.
// It also fails if nothing was decoded, so it checks the share itself end to end.
//
//   node apps/desktop/test/key-log-check.mjs [HWND]
//
// On Windows and Linux. It shares the first monitor, or on Windows the window given, and keeps
// nothing it captures. It uses the LiveKit on 7880 if there is one, as the test server's is, in
// a room of its own, and otherwise runs its own.

import { spawn } from "node:child_process";
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureFfmpeg, nativeAppDeps } from "../../../scripts/ffmpeg.mjs";
import { bundleCore, ensureLiveKit, env, msvcToolchain, root } from "../../../scripts/lib.mjs";

if (process.platform !== "win32" && process.platform !== "linux") {
  console.error("The app captures screens itself on Windows and Linux only.");
  process.exit(2);
}
const isWindows = process.platform === "win32";

const key = "stand-in-for-a-key-from-mls-exporter";
const salt = "LKFrameEncryptionKey";

/** Whether something takes a connection on this port. */
const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

/** A LiveKit access token, as `--dev` takes them: devkey, signed with "secret". */
function token(identity, room, publish) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "devkey", sub: identity, nbf: now - 10, exp: now + 600, video: { room, roomJoin: true, canPublish: publish, canSubscribe: !publish } };
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`;
  return `${unsigned}.${createHmac("sha256", "secret").update(unsigned).digest("base64url")}`;
}

let liveKit = null;
if (!(await listening(7880))) {
  liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1"], { stdio: "ignore" });
  // Until LiveKit takes connections, rather than for a time that may be too short.
  for (let waited = 0; !(await listening(7880)); waited += 100) {
    if (waited > 20_000 || liveKit.exitCode !== null) {
      liveKit.kill();
      console.error("LiveKit didn't start.");
      process.exit(2);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

bundleCore();
await ensureFfmpeg(nativeAppDeps);
const target = isWindows ? join(process.env.LOCALAPPDATA, "zuna-windows-target") : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");
const room = `key-log-check-${randomBytes(4).toString("hex")}`;
const args = [
  ...(isWindows ? [`+${msvcToolchain()}`] : []),
  "run",
  "--quiet",
  "--example",
  "share-check",
  "--features",
  "share-check",
  "--",
  "ws://127.0.0.1:7880",
  token("sharer", room, true),
  token("watcher", room, false),
  key,
  "6",
  ...process.argv.slice(2, 3),
];
let output = "";
const run = spawn("cargo", args, { cwd: join(root, "apps", "desktop"), env: { ...env, CARGO_TARGET_DIR: target, ZUNA_WEBRTC_LOG: "1", RUST_LOG: "trace" } });
run.stdout.on("data", (data) => (output += data));
run.stderr.on("data", (data) => (output += data));
const code = await new Promise((resolve) => run.on("exit", resolve));
liveKit?.kill();

const raw = Buffer.from(key);
const derived = Buffer.from(hkdfSync("sha256", raw, Buffer.from(salt), Buffer.alloc(128), 16));
const forms = (name, bytes) => ({
  [`${name} as text`]: bytes.toString("latin1"),
  [`${name} as hex`]: bytes.toString("hex"),
  [`${name} as HEX`]: bytes.toString("hex").toUpperCase(),
  [`${name} as base64`]: bytes.toString("base64"),
  [`${name} as a byte list`]: [...bytes].join(", "),
});
const looksFor = { ...forms("the key", raw), ...forms("the derived key", derived) };

const lines = output.split("\n");
// The key itself is on the command line, which isn't part of the log.
const logged = lines.filter((line) => !line.includes(key) || !line.includes("share-check")).join("\n");
const webrtcLines = lines.filter((line) => line.includes("libwebrtc")).length;
const cryptorLines = lines.filter((line) => /cryptor|FrameCryptor/i.test(line));
const leaks = Object.entries(looksFor)
  .filter(([, form]) => logged.includes(form))
  .map(([name]) => name);
const result = lines.map((line) => line.trim()).filter((line) => line.startsWith('{"decoded"')).map((line) => JSON.parse(line))[0];

console.log(`${lines.length} lines of log, ${webrtcLines} from libwebrtc, ${cryptorLines.length} about the frame cryptor`);
for (const line of cryptorLines.slice(0, 12)) console.log(`  ${line.slice(0, 200)}`);
console.log(`Key digest, to tell runs apart: ${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`);
console.log(leaks.length ? `FOUND IN THE LOG: ${leaks.join(", ")}` : "Not found in the log in any form looked for.");
console.log(result ? `The watcher decoded ${result.decoded} frames at ${result.width}x${result.height}, and the share ${result.stopped ? "stopped when asked" : "didn't stop"}.` : `The share didn't finish (exit ${code}):\n${lines.slice(-20).join("\n")}`);
process.exit(leaks.length || code !== 0 ? 1 : 0);
