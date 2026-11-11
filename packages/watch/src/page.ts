// watch.html's script: the player for the native apps, which load the page into their system's
// web view (WKWebView on iPhone, iPad and macOS, WebView2 on Windows, WebKitGTK on Linux) with
// a base address of their own, which is the Referer YouTube's player is given. The app and the
// page say only the few things below to each other, as JSON, and each checks what it's told.

import { WatchController, type WatchStatus } from "./index";
import type { WatchIntent } from "./sync";

interface Bridge {
  ipc?: { postMessage(text: string): void };
  webkit?: { messageHandlers?: { zuna?: { postMessage(text: string): void } } };
  chrome?: { webview?: { postMessage(text: string): void } };
}

/** What the app says to the page. */
export type ToPage =
  | { type: "start"; host?: string; muted?: boolean; fullscreen?: boolean }
  | { type: "apply"; video: string | null; playing: boolean; position: number; age: number; rate: number }
  | { type: "volume"; level: number }
  | { type: "muted"; muted: boolean }
  | { type: "hold"; held: boolean };

/** What the page says to the app. */
export type FromPage =
  | { type: "ready" }
  | { type: "intent"; change: WatchIntent }
  | { type: "status"; status: WatchStatus }
  | { type: "volume"; level: number; muted: boolean }
  | { type: "blocked" };

const bridge = window as unknown as Bridge;

function send(message: FromPage): void {
  const text = JSON.stringify(message);
  if (bridge.ipc) bridge.ipc.postMessage(text);
  else if (bridge.webkit?.messageHandlers?.zuna) bridge.webkit.messageHandlers.zuna.postMessage(text);
  else if (bridge.chrome?.webview) bridge.chrome.webview.postMessage(text);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
let controller: WatchController | null = null;

function receive(raw: unknown): void {
  let message: Partial<ToPage> & Record<string, unknown>;
  try {
    message = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof message);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "start": {
      if (controller) return;
      const holder = document.getElementById("player")!;
      controller = new WatchController(
        holder,
        {
          intent: (change) => send({ type: "intent", change }),
          status: (status) => send({ type: "status", status }),
          volume: ({ level, muted }) => send({ type: "volume", level, muted }),
          blocked: () => send({ type: "blocked" }),
        },
        {
          host: typeof message.host === "string" && /^https?:\/\/[^/]+$/.test(message.host) ? message.host : undefined,
          muted: message.muted === true,
          fullscreen: message.fullscreen !== false,
        },
      );
      break;
    }
    case "apply":
      if (!controller || !finite(message.position) || !finite(message.age) || !finite(message.rate)) return;
      controller.apply({
        video: typeof message.video === "string" ? message.video : null,
        playing: message.playing === true,
        position: message.position,
        age: message.age,
        rate: message.rate,
      });
      break;
    case "volume":
      if (finite(message.level)) controller?.setVolume(Math.min(1, Math.max(0, message.level)));
      break;
    case "muted":
      controller?.setMuted(message.muted === true);
      break;
    case "hold":
      controller?.hold(message.held === true);
      break;
  }
}

(window as unknown as { zunaWatch: { receive: typeof receive } }).zunaWatch = { receive };
send({ type: "ready" });
