// Shares a screen from a program of its own, which captures and encodes on the GPU
// and only uses LiveKit to carry the result. Chromium reads every frame back to the
// CPU and has no supported hardware encoder on Linux, which is what this avoids.
// docs/SCREEN_SHARE.md has the measurements.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";

/** How long the program gets to start publishing. On Linux the portal's dialog waits for as long as the person takes. */
const START_TIMEOUT_MS = 120_000;
const EXECUTABLE = process.platform === "win32" ? "zuna-screenshare.exe" : "zuna-screenshare";

/** Where this build's program is, if it came with one. */
export function nativeScreenPath(): string | null {
  const candidates = [
    process.env.ZUNA_SCREENSHARE,
    app.isPackaged ? join(process.resourcesPath, "screenshare", EXECUTABLE) : join(app.getAppPath(), "native", "screenshare", "dist", EXECUTABLE),
  ];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

export interface NativeScreenOptions {
  url: string;
  token: string;
  key: Uint8Array;
  keyIndex: number;
  fps: number;
  bitrateKbps: number;
  /** A point on the screen to share, or nothing for what the system's own dialog picks. */
  at: { x: number; y: number } | null;
}

export interface NativeScreen {
  /** What it said once it was publishing. */
  ready: Promise<unknown>;
  setKey(key: Uint8Array, keyIndex: number): void;
  stop(): void;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** What went wrong, in a form worth telling someone, from what the program said last. */
function describeProblem(said: string[]): string {
  const last = said.at(-1);
  return last ? `Your screen share stopped: ${last.slice(0, 200)}` : "Your screen share stopped.";
}

/**
 * Starts the program. Its token and keys go to it over its standard input, since a
 * command line can be read by anything else on the computer.
 */
export function startNativeScreen(options: NativeScreenOptions, onEnded: (problem: string | null) => void, onStats: (stats: unknown) => void): NativeScreen {
  const path = nativeScreenPath();
  if (!path) throw new Error("This build has no native screen capture.");

  const args = ["--control", "--encoder", "auto", "--fps", String(options.fps), "--bitrate-kbps", String(options.bitrateKbps)];
  if (options.at) args.push("--monitor-at", `${options.at.x},${options.at.y}`);

  const child: ChildProcess = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const send = (message: object) => {
    if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const said: string[] = [];
  let stopping = false;
  let settled = false;

  const ready = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopping = true;
      child.kill();
      reject(new Error("The screen share took too long to start."));
    }, START_TIMEOUT_MS);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: { type?: string };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "ready" && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(message);
      } else if (message.type === "stats") {
        onStats(message);
      }
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
      if (!settled) {
        settled = true;
        reject(new Error(describeProblem(said)));
        return;
      }
      onEnded(stopping || code === 0 ? null : describeProblem(said));
    });
  });

  send({ type: "start", url: options.url, token: options.token, key: hex(options.key), key_index: options.keyIndex });

  return {
    ready,
    setKey: (key, keyIndex) => send({ type: "key", key: hex(key), key_index: keyIndex }),
    stop() {
      stopping = true;
      send({ type: "stop" });
      // It usually leaves by itself, which lets it leave the room properly.
      setTimeout(() => child.kill(), 2000).unref();
    },
  };
}
