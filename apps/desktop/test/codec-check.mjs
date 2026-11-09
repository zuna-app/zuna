// Shares through the native app's capture and LiveKit in H.264 and then in AV1, under end-to-end
// encryption, with a native watcher, and compares the two. For each codec it checks that:
//
//   - a watcher there from the start decrypts and decodes it, and says how long that took
//   - a watcher who comes 3 seconds later does too, which needs the media server to see keyframes
//   - a watcher with another key opens nothing, and one without encryption, as the media server is,
//     nothing of AV1. H.264 leaves its NAL headers out of the encryption, so a decoder without
//     the key makes some frames of what it can't open, which are counted and not held against it
//
// The watcher is a process of its own, so each side's CPU is its own.
//
//   node apps/desktop/test/codec-check.mjs [HWND] [--seconds 20] [--fps 60] [--kbps 20000] [--height 0] [--encoder auto] [--release]
//
// On Windows and Linux, with a graphics card that encodes AV1. It shares the first monitor, or on
// Windows the window given, keeping nothing it captures. A height of 0 is the screen's own size.
// What's on the screen sets the bitrate, so run something that moves, the same for both codecs.

import { randomBytes } from "node:crypto";
import { liveKitOn7880, prepare, runShareCheck } from "./share-run.mjs";

if (process.platform !== "win32" && process.platform !== "linux") {
  console.error("The app captures screens itself on Windows and Linux only.");
  process.exit(2);
}

const args = process.argv.slice(2);
const option = (name, otherwise) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args.splice(at, 2)[1] : otherwise;
};
const seconds = Number(option("seconds", "20"));
const fps = option("fps", "60");
const kbps = option("kbps", "20000");
const height = option("height", "0");
const encoder = option("encoder", "auto");
// A release build, as the app is, for numbers to go by: a debug build's own Rust, h264.rs most, is slower.
const release = args.includes("--release") && Boolean(args.splice(args.indexOf("--release"), 1));
const window = args[0];
const key = randomBytes(16).toString("hex");

let stopLiveKit;
try {
  stopLiveKit = await liveKitOn7880();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
await prepare();

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN);
const fixed = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "-");
const frames = (result) => (!result ? "-" : `${result.decoded} frames`);

/** One run of the share check, in a room of its own. */
async function share(codec, run, extra = {}) {
  const room = `codec-check-${codec}-${run}-${randomBytes(3).toString("hex")}`;
  const runSeconds = run === "watching" ? seconds : 6;
  const { code, json, lines } = await runShareCheck(room, [key, String(runSeconds), ...(window ? [window] : [])], {
    ZUNA_SHARE_CODEC: codec,
    ZUNA_SHARE_FPS: fps,
    ZUNA_SHARE_KBPS: kbps,
    ZUNA_SHARE_HEIGHT: height,
    ZUNA_SHARE_ENCODER: encoder,
    ...extra,
  }, { release });
  const ready = json.find((line) => line.ready);
  const result = json.find((line) => "decoded" in line);
  // The first 5 seconds are the bitrate climbing, which says little.
  const stats = json.filter((line) => line.stats && line.stats.t >= 5).map((line) => line.stats);
  if (!result) console.log(`  ${codec} ${run} didn't finish (exit ${code}):\n${lines.slice(-15).join("\n")}`);
  return { code, ready, result, stats };
}

const codecs = ["h264", "av1"];
const runs = {};
for (const codec of codecs) {
  console.log(`> ${codec}: watching from the start, for ${seconds} s`);
  const watching = await share(codec, "watching");
  console.log(`> ${codec}: a watcher 3 s late, one with another key, and one without encryption`);
  const late = await share(codec, "late", { ZUNA_WATCHER_LATE: "3" });
  const wrongKey = await share(codec, "wrong-key", { ZUNA_WATCHER_KEY: randomBytes(16).toString("hex") });
  const noKey = await share(codec, "no-key", { ZUNA_WATCHER_KEY: "none" });
  runs[codec] = { watching, late, wrongKey, noKey };
}
stopLiveKit();

const rows = [
  ["Encoder", (run) => run.watching.ready?.ready.match(/, (\w+) from/)?.[1] ?? "-"],
  ["Picture", (run) => (run.watching.ready ? `${run.watching.ready.width}x${run.watching.ready.height}` : "-")],
  ["Sent, frames a second", (run) => fixed(mean(run.watching.stats.map((stats) => stats.fps)))],
  ["Bitrate, Mbit/s", (run) => fixed(mean(run.watching.stats.map((stats) => stats.kbps)) / 1000, 2)],
  ["Encode, ms a frame", (run) => fixed(mean(run.watching.stats.map((stats) => stats.encodeMsAvg)), 2)],
  ["Sender's CPU, % of a core", (run) => fixed(mean(run.watching.stats.map((stats) => stats.cpuCores)) * 100)],
  ["Keyframes", (run) => String(run.watching.stats.at(-1)?.allKeys ?? "-")],
  ["Decoded by the watcher", (run) => String(run.watching.result?.decoded ?? "-")],
  ["Watcher's decoder", (run) => run.watching.result?.watcher?.decoder || "-"],
  ["Watcher's decode, ms a frame", (run) => fixed(run.watching.result?.watcher?.decodeMs, 2)],
  ["Watcher's CPU, % of a core", (run) => fixed((run.watching.result?.watcherCpuCores ?? NaN) * 100)],
  ["Watcher's jitter buffer, ms", (run) => fixed(run.watching.result?.watcher?.jitterBufferMs)],
  ["Watcher's freezes", (run) => String(run.watching.result?.watcher?.freezes ?? "-")],
  ["Watcher's keyframe requests", (run) => String((run.watching.result?.watcher?.plis ?? 0) + (run.watching.result?.watcher?.firs ?? 0))],
  ["3 s late, decoded", (run) => String(run.late.result?.decoded ?? "-")],
  ["Another key, decoded", (run) => frames(run.wrongKey.result)],
  ["No encryption, decoded", (run) => frames(run.noKey.result)],
];
const width = Math.max(...rows.map(([name]) => name.length));
console.log(`\n${"".padEnd(width)}  ${codecs.map((codec) => codec.toUpperCase().padEnd(24)).join("")}`);
for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${codecs.map((codec) => value(runs[codec]).padEnd(24)).join("")}`);

// Each check passes by its own exit: decoding where it should, and nothing where it shouldn't.
const failed = codecs.flatMap((codec) =>
  Object.entries(runs[codec])
    .filter(([, run]) => run.code !== 0)
    .map(([name]) => `${codec} ${name}`),
);
console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : "\nEvery check passed.");
process.exit(failed.length ? 1 : 0);
