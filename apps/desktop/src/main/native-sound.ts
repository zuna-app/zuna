// The computer's sound for a screen share, from the native screen capture program:
// everything playing apart from Zuna, so that nobody in the call hears themselves back, or
// one app's, from PipeWire on Linux, process loopback on Windows and Core Audio's taps on
// macOS. Chromium can't take one app's anywhere, nor anything on Linux or macOS. Its samples
// go to the renderer over a MessagePort, straight to the audio thread that plays them into
// the published track. docs/SCREEN_SHARE.md has more.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { app, MessageChannelMain, type WebContents } from "electron";
import { nativeScreenPath } from "./native-screen";

/** How long the program gets to answer. */
const ASK_TIMEOUT_MS = 10_000;
/** How long it gets to start listening. The first time on macOS, that's while the person is asked whether Zuna may record the computer's sound. */
const START_TIMEOUT_MS = process.platform === "darwin" ? 120_000 : 10_000;
/** Two 32-bit floats. */
const FRAME_BYTES = 8;

export interface SoundApp {
  /** What the program calls it, to capture it by. */
  id: string;
  name: string;
}

export interface WindowSoundApp extends SoundApp {
  playing: boolean;
  covers: string[];
}

/** Whether this build can capture the computer's sound itself. On macOS that's only on Apple silicon, which the program is built for. */
export function nativeSoundAvailable(): boolean {
  const supported = process.platform === "linux" || process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
  return supported && !!nativeScreenPath();
}

/** Zuna's own sound is never taken: Chromium plays it from a process under this one. */
const excludeArgs = (): string[] => ["--exclude-pid", String(process.pid)];

/** Runs the program for one answer, as one line of JSON, or null if there's none. */
function ask(args: string[]): Promise<Record<string, unknown> | null> {
  const path = nativeScreenPath();
  if (!path || !nativeSoundAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(path, [...args, ...excludeArgs()], { stdio: ["ignore", "pipe", "ignore"], timeout: ASK_TIMEOUT_MS, windowsHide: true });
    let output = "";
    child.stdout!.setEncoding("utf8").on("data", (text: string) => (output += text));
    child.on("error", () => resolve(null));
    child.on("exit", () => {
      try {
        resolve(JSON.parse(output) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
  });
}

const isApp = (app: unknown): app is SoundApp => typeof (app as SoundApp)?.id === "string" && typeof (app as SoundApp)?.name === "string";

/** The apps playing sound now, apart from Zuna. */
export async function listSoundApps(): Promise<SoundApp[]> {
  const apps = (await ask(["--sound-apps"]))?.apps;
  return Array.isArray(apps) ? apps.filter(isApp).map(({ id, name }) => ({ id, name })) : [];
}

/**
 * Whether Chromium draws on X11 here, where a window's id is X11's and says which process
 * it belongs to. On Wayland it's the portal's, which doesn't.
 */
export function onX11(): boolean {
  const hint = [app.commandLine.getSwitchValue("ozone-platform"), app.commandLine.getSwitchValue("ozone-platform-hint"), process.env.ELECTRON_OZONE_PLATFORM_HINT];
  return hint.includes("x11") || !process.env.WAYLAND_DISPLAY;
}

/** Which app a window that can be shared belongs to, where the system can tell. */
export async function windowSoundApp(source: string): Promise<WindowSoundApp | null> {
  const window = /^window:(\d+):/.exec(source)?.[1];
  if (!window || (process.platform === "linux" && !onX11())) return null;
  const found = (await ask(["--window-app", window]))?.app as WindowSoundApp | null | undefined;
  if (!isApp(found)) return null;
  return { id: found.id, name: found.name, playing: found.playing === true, covers: Array.isArray(found.covers) ? found.covers.filter((id) => typeof id === "string") : [] };
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
  if (!path || !nativeSoundAvailable()) throw new Error("This build can't capture your computer's sound.");
  const args = [...(app ? ["--sound-from", app] : ["--sound"]), ...excludeArgs()];
  const child: ChildProcess = spawn(path, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
