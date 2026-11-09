// What the checks that run examples/share-check.rs share: a LiveKit to share through, tokens
// for it, and running the example. key-log-check.mjs and codec-check.mjs use it.

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureFfmpeg, nativeAppDeps } from "../../../scripts/ffmpeg.mjs";
import { ensureWebrtcSys } from "../../../scripts/webrtc-sys.mjs";
import { bundleCore, ensureLiveKit, env, msvcToolchain, root } from "../../../scripts/lib.mjs";

export const isWindows = process.platform === "win32";

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
export function token(identity, room, publish) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "devkey", sub: identity, nbf: now - 10, exp: now + 600, video: { room, roomJoin: true, canPublish: publish, canSubscribe: !publish } };
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}`;
  return `${unsigned}.${createHmac("sha256", "secret").update(unsigned).digest("base64url")}`;
}

/**
 * The LiveKit on 7880 if there is one, as the test server's is, and otherwise one of its own.
 * Says how to stop what it started.
 */
export async function liveKitOn7880() {
  if (await listening(7880)) return () => {};
  const liveKit = spawn(ensureLiveKit(), ["--dev", "--bind", "127.0.0.1", "--node-ip", "127.0.0.1"], { stdio: "ignore" });
  // Until LiveKit takes connections, rather than for a time that may be too short.
  for (let waited = 0; !(await listening(7880)); waited += 100) {
    if (waited > 20_000 || liveKit.exitCode !== null) {
      liveKit.kill();
      throw new Error("LiveKit didn't start.");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return () => liveKit.kill();
}

/** What the example needs built first: the core's bundle, FFmpeg and LiveKit's patched webrtc-sys. */
export async function prepare() {
  bundleCore();
  await ensureFfmpeg(nativeAppDeps);
  await ensureWebrtcSys(nativeAppDeps);
}

const target = isWindows ? join(process.env.LOCALAPPDATA, "zuna-windows-target") : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");

/**
 * Runs examples/share-check.rs with these arguments after the URL and tokens, and this in its
 * environment, and gives back how it exited, all it wrote, and each JSON line it printed. A
 * release build measures what the app would do, where a debug build's own Rust is slower.
 */
export async function runShareCheck(room, args, extraEnv = {}, { release = false } = {}) {
  const cargo = [
    ...(isWindows ? [`+${msvcToolchain()}`] : []),
    "run",
    "--quiet",
    ...(release ? ["--release"] : []),
    "--example",
    "share-check",
    "--features",
    "share-check",
    "--",
    "ws://127.0.0.1:7880",
    token("sharer", room, true),
    token("watcher", room, false),
    ...args,
  ];
  let output = "";
  const run = spawn("cargo", cargo, { cwd: join(root, "apps", "desktop"), env: { ...env, CARGO_TARGET_DIR: target, ...extraEnv } });
  run.stdout.on("data", (data) => (output += data));
  run.stderr.on("data", (data) => (output += data));
  const code = await new Promise((resolve) => run.on("exit", resolve));
  const lines = output.split("\n");
  const json = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return { code, output, lines, json };
}
