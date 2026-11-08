// Publishes a share with every native log turned on, then looks for the encryption key in
// what came out. The native frame cryptor has been reported to log key material
// (webrtc-sdk/webrtc#308), and logs end up in bug reports. docs/SECURITY_DETAILS.md cites it.
//
//   npm run build:screenshare, then node apps/screenshare/test/key-log-check.mjs [monitor]
//
// It runs a LiveKit of its own on 7880, so stop the test server first.

import { spawn } from "node:child_process";
import { createHash, hkdfSync } from "node:crypto";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { ensureLiveKit, root } from "../../../scripts/lib.mjs";

const key = "stand-in-for-a-key-from-mls-exporter";
const salt = "LKFrameEncryptionKey";
const publisher = join(root, "apps", "screenshare", "dist", process.platform === "win32" ? "zuna-screenshare.exe" : "zuna-screenshare");
if (!existsSync(publisher)) {
  console.error(`There's no ${publisher}: npm run build:screenshare first.`);
  process.exit(2);
}

/** Whether something takes a connection on this port. */
const listening = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

if (await listening(7880)) {
  console.error("Something is already on port 7880, such as the test server's LiveKit. Stop it first.");
  process.exit(2);
}
const liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1"], { stdio: "ignore" });
// Until LiveKit takes connections, rather than for a time that may be too short.
for (let waited = 0; !(await listening(7880)); waited += 100) {
  if (waited > 20_000 || liveKit.exitCode !== null) {
    liveKit.kill();
    console.error("LiveKit didn't start.");
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let output = "";
const run = spawn(publisher, ["--e2ee-key", key, "--seconds", "6", "--monitor", process.argv[2] ?? "0"], {
  env: { ...process.env, ZUNA_WEBRTC_LOG: "1", RUST_LOG: "trace" },
});
run.stdout.on("data", (data) => (output += data));
run.stderr.on("data", (data) => (output += data));
await new Promise((resolve) => run.on("exit", resolve));
liveKit.kill();

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
const webrtcLines = lines.filter((line) => line.includes("libwebrtc")).length;
const cryptorLines = lines.filter((line) => /cryptor|FrameCryptor/i.test(line));
const leaks = Object.entries(looksFor)
  .filter(([, form]) => output.includes(form))
  .map(([name]) => name);

console.log(`${lines.length} lines of log, ${webrtcLines} from libwebrtc, ${cryptorLines.length} about the frame cryptor`);
for (const line of cryptorLines.slice(0, 12)) console.log(`  ${line.slice(0, 200)}`);
console.log(`Key digest, to tell runs apart: ${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`);
console.log(leaks.length ? `FOUND IN THE LOG: ${leaks.join(", ")}` : "Not found in the log in any form looked for.");
process.exit(leaks.length ? 1 : 0);
