// Shares a screen or a window from a program of its own, which captures and encodes on
// the GPU and only uses LiveKit to carry the result. Chromium reads every frame back to
// the CPU and has no supported hardware encoder on Linux, which is what this avoids.
// docs/SCREEN_SHARE.md has the measurements.

import { execFile, spawn, type ChildProcess } from "node:child_process";
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

/** The sources the picker offers where the portal's dialog picks which, once Share is pressed. */
export const PORTAL_SCREEN = "portal:screen";
export const PORTAL_WINDOW = "portal:window";

/** What the portal shares, where it's what picks: screens, windows or both. */
export interface PortalSources {
  screen: boolean;
  window: boolean;
}

let portal: Promise<PortalSources | null> | null = null;

/** Whether the desktop is a Wayland session, whichever way Chromium itself draws. */
export function waylandSession(): boolean {
  return process.env.XDG_SESSION_TYPE === "wayland" || (!process.env.XDG_SESSION_TYPE && !!process.env.WAYLAND_DISPLAY);
}

/**
 * Whether the native program picks what to share itself, through the portal's dialog,
 * and what that offers. That's on Linux under Wayland, where Chromium's list of what
 * there is would only ask the portal too, and a native share would then ask again.
 * Null where the app lists what there is itself, such as under X11.
 */
export function portalSources(): Promise<PortalSources | null> {
  const path = nativeScreenPath();
  if (process.platform !== "linux" || !waylandSession() || !path) return Promise.resolve(null);
  portal ??= new Promise<PortalSources | null>((resolve) => {
    execFile(path, ["--portal-sources"], { timeout: 5000 }, (error, stdout) => {
      try {
        const said = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
        resolve(error ? null : { screen: said.screen === true, window: said.window === true });
      } catch {
        resolve(null);
      }
    });
  }).then((found) => {
    // A portal that wasn't up yet gets asked again next time.
    if (!found) portal = null;
    return found;
  });
  return portal;
}

export interface NativeScreenOptions {
  url: string;
  token: string;
  key: Uint8Array;
  keyIndex: number;
  fps: number;
  bitrateKbps: number;
  /** The tallest the picture may be, or 0 for the screen's own size. */
  height: number;
  /** Draw the pointer into the picture. */
  cursor: boolean;
  /** Which of the system's encoders, or "auto" for whichever goes with the screen's graphics card. */
  encoder: string;
  /** How much work each frame gets. */
  effort: string;
  keyframeSeconds: number;
  /** A point on the screen to share, or nothing for what the system's own dialog picks. */
  at: { x: number; y: number } | null;
  /** Windows: the window to share, by its HWND. */
  window: string | null;
  /** What the system's own dialog offers, where it picks. */
  kind: "screen" | "window";
}

const ENCODERS = new Set(["auto", "h264_nvenc", "h264_amf", "h264_mf", "h264_vaapi"]);
const EFFORTS = new Set(["speed", "balanced", "best"]);
const whole = (value: number, fallback: number): string => String(Number.isFinite(value) && value > 0 ? Math.round(value) : fallback);

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

  const args = [
    "--control",
    "--encoder",
    ENCODERS.has(options.encoder) ? options.encoder : "auto",
    "--quality",
    EFFORTS.has(options.effort) ? options.effort : "balanced",
    "--fps",
    whole(options.fps, 60),
    "--bitrate-kbps",
    whole(options.bitrateKbps, 20_000),
    "--keyframe-seconds",
    whole(options.keyframeSeconds, 10),
  ];
  if (options.height > 0) args.push("--max-height", whole(options.height, 0));
  if (!options.cursor) args.push("--no-cursor");
  if (options.at) args.push("--monitor-at", `${options.at.x},${options.at.y}`);
  if (options.window) args.push("--window", options.window);
  else args.push("--source", options.kind === "window" ? "window" : "screen");

  const child: ChildProcess = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // Once it's gone, writing to it fails with EPIPE, which unheard would stop the app with an error.
  child.stdin?.on("error", () => undefined);
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
