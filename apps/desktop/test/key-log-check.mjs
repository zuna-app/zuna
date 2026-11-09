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
// a room of its own, and otherwise runs its own. ZUNA_SHARE_CODEC=av1 shares in AV1.

import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { liveKitOn7880, prepare, runShareCheck } from "./share-run.mjs";

if (process.platform !== "win32" && process.platform !== "linux") {
  console.error("The app captures screens itself on Windows and Linux only.");
  process.exit(2);
}

const key = "stand-in-for-a-key-from-mls-exporter";
const salt = "LKFrameEncryptionKey";

let stopLiveKit;
try {
  stopLiveKit = await liveKitOn7880();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
await prepare();
const room = `key-log-check-${randomBytes(4).toString("hex")}`;
const { code, output } = await runShareCheck(room, [key, "6", ...process.argv.slice(2, 3)], { ZUNA_WEBRTC_LOG: "1", RUST_LOG: "trace" });
stopLiveKit();

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
const ready = lines.map((line) => line.trim()).filter((line) => line.startsWith('{"ready"')).map((line) => JSON.parse(line))[0];

console.log(`${lines.length} lines of log, ${webrtcLines} from libwebrtc, ${cryptorLines.length} about the frame cryptor`);
for (const line of cryptorLines.slice(0, 12)) console.log(`  ${line.slice(0, 200)}`);
console.log(`Key digest, to tell runs apart: ${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`);
console.log(leaks.length ? `FOUND IN THE LOG: ${leaks.join(", ")}` : "Not found in the log in any form looked for.");
if (ready) console.log(`Shared in ${ready.codec}: ${ready.ready.replace(/^.* on /, "on ")}`);
console.log(result ? `The watcher decoded ${result.decoded} frames at ${result.width}x${result.height}, and the share ${result.stopped ? "stopped when asked" : "didn't stop"}.` : `The share didn't finish (exit ${code}):\n${lines.slice(-20).join("\n")}`);
process.exit(leaks.length || code !== 0 ? 1 : 0);
