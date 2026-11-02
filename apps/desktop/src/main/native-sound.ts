// The computer's sound for a screen share on Linux, which Chromium can't capture there.
// The native screen capture program takes it from PipeWire: everything playing apart
// from Zuna, so that nobody in the call hears themselves back, or one app's. Its samples
// go to the renderer over a MessagePort, straight to the audio thread that plays them
// into the published track. docs/SCREEN_SHARE.md has more.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { MessageChannelMain, type WebContents } from "electron";
import { nativeScreenPath } from "./native-screen";

/** How long PipeWire gets to answer. */
const START_TIMEOUT_MS = 10_000;
/** Two 32-bit floats. */
const FRAME_BYTES = 8;

export interface SoundApp {
  /** What the program calls it, to capture it by. */
  id: string;
  name: string;
}

/** Whether this build can capture the computer's sound itself. */
export function nativeSoundAvailable(): boolean {
  return process.platform === "linux" && !!nativeScreenPath();
}

/** Zuna's own sound is never taken: Chromium plays it from a process under this one. */
const excludeArgs = (): string[] => ["--exclude-pid", String(process.pid)];

/** The apps playing sound now, apart from Zuna. */
export function listSoundApps(): Promise<SoundApp[]> {
  const path = nativeScreenPath();
  if (!path || process.platform !== "linux") return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn(path, ["--sound-apps", ...excludeArgs()], { stdio: ["ignore", "pipe", "ignore"], timeout: START_TIMEOUT_MS });
    let output = "";
    child.stdout!.setEncoding("utf8").on("data", (text: string) => (output += text));
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      try {
        const apps = (JSON.parse(output) as { apps?: unknown }).apps;
        resolve(Array.isArray(apps) ? apps.filter((app): app is SoundApp => typeof app?.id === "string" && typeof app?.name === "string") : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export interface NativeSound {
  stop(): void;
}

/**
 * Starts capturing everything but Zuna, or one app, and hands the renderer a port its
 * samples come over once it's listening.
 */
export function startNativeSound(app: string | null, renderer: WebContents, onEnded: (problem: string | null) => void): { sound: NativeSound; ready: Promise<void> } {
  const path = nativeScreenPath();
  if (!path || process.platform !== "linux") throw new Error("This build can't capture your computer's sound.");
  const args = [...(app ? ["--sound-from", app] : ["--sound"]), ...excludeArgs()];
  const child: ChildProcess = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"] });
  const { port1, port2 } = new MessageChannelMain();
  const said: string[] = [];
  let stopping = false;
  let settled = false;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopping = true;
      child.kill();
      reject(new Error("Your computer's sound took too long to start."));
    }, START_TIMEOUT_MS);
    // One line saying it's listening, and only sound after that.
    let header = "";
    let rest: Buffer = Buffer.alloc(0);
    child.stdout!.on("data", (data: Buffer) => {
      if (!settled) {
        header += data.toString("latin1");
        const end = header.indexOf("\n");
        if (end < 0) return;
        settled = true;
        clearTimeout(timer);
        if (!renderer.isDestroyed()) renderer.postMessage("zuna:native-sound-port", null, [port2]);
        resolve();
        data = Buffer.from(header.slice(end + 1), "latin1");
      }
      const bytes = rest.length ? Buffer.concat([rest, data]) : data;
      const whole = bytes.length - (bytes.length % FRAME_BYTES);
      rest = Buffer.from(bytes.subarray(whole));
      if (whole === 0) return;
      // A copy of its own, since what Node reads into can be part of something larger.
      const samples = new Float32Array(whole / 4);
      new Uint8Array(samples.buffer).set(bytes.subarray(0, whole));
      port1.postMessage(samples);
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (line.trim()) said.push(line.trim());
      if (said.length > 20) said.shift();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      port1.close();
      const problem = said.at(-1)?.slice(0, 200) ?? "It stopped by itself.";
      if (!settled) {
        settled = true;
        reject(new Error(problem));
        return;
      }
      onEnded(stopping || code === 0 ? null : problem);
    });
  });

  return {
    ready,
    sound: {
      stop() {
        stopping = true;
        if (child.stdin?.writable) child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
        setTimeout(() => child.kill(), 2000).unref();
      },
    },
  };
}
