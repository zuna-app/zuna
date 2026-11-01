// The desktop's side of the interface: everything the Electron shell provides,
// through the bridge the preload script exposes.

import { connectWorker, type DeviceInfo, type DisplaySource, type Platform } from "@zuna/ui";

export interface DesktopBridge {
  /** Whether the system shows times with AM and PM. */
  hour12: boolean;
  deviceKey(): Promise<DeviceInfo>;
  platform(): Promise<string>;
  /** Whether the operating system lets Zuna record, asking the person the first time. */
  microphone(): Promise<boolean>;
  camera(): Promise<boolean>;
  displaySources(): Promise<DisplaySource[]>;
  chooseDisplaySource(id: string, audio: boolean): Promise<void>;
  nativeScreenStart(options: { url: string; token: string; key: Uint8Array; keyIndex: number; fps: number; bitrateKbps: number; source: string }): Promise<void>;
  nativeScreenKey(key: Uint8Array, keyIndex: number): Promise<void>;
  nativeScreenStop(): Promise<void>;
  onNativeScreenEnded(listener: (problem: string | null) => void): () => void;
  watchKey(code: string | null): Promise<boolean>;
  onKey(listener: (down: boolean) => void): () => void;
  notify(payload: { title: string; body: string; route: unknown }): Promise<void>;
  setBadge(count: number): Promise<void>;
  setCloseToTray(enabled: boolean): Promise<void>;
  takeDeepLink(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  onDeepLink(listener: (link: string) => void): () => void;
  onOpenConversation(listener: (route: unknown) => void): () => void;
  onFocus(listener: (focused: boolean) => void): () => void;
  /** "active", "idle" after this many seconds without input anywhere, or "locked". */
  idleState(seconds: number): Promise<"active" | "idle" | "locked" | "unknown">;
  /** The screen locking or the computer sleeping ("away"), and coming back ("back"). */
  onPresence(listener: (state: "away" | "back") => void): () => void;
}

declare global {
  interface Window {
    zunaDesktop?: DesktopBridge;
  }
}

export function desktopPlatform(): Platform {
  // The preload script always provides it. In a browser, use apps/web instead.
  const desktop = window.zunaDesktop!;
  return {
    hour12: desktop.hour12,
    titleBar: true,
    os: () => desktop.platform(),
    bootCore: async (onEvent) => connectWorker(startWorker(), await desktop.deviceKey(), onEvent),
    openExternal: (url) => void desktop.openExternal(url),
    setUnreadCount: (count) => void desktop.setBadge(count),
    notify: (payload) => void desktop.notify(payload),
    microphone: () => desktop.microphone(),
    camera: () => desktop.camera(),
    displaySources: () => desktop.displaySources(),
    chooseDisplaySource: (id, audio) => desktop.chooseDisplaySource(id, audio),
    systemAudio: navigator.userAgent.includes("Windows"),
    nativeScreen: {
      start: (options) => desktop.nativeScreenStart(options),
      setKey: (key, keyIndex) => void desktop.nativeScreenKey(key, keyIndex),
      stop: () => void desktop.nativeScreenStop(),
      onEnded: (listener) => desktop.onNativeScreenEnded(listener),
    },
    watchKey(code, listener) {
      const off = desktop.onKey(listener);
      void desktop.watchKey(code);
      return () => {
        off();
        void desktop.watchKey(null);
      };
    },
    idleState: (seconds) => desktop.idleState(seconds),
    onPresence: (listener) => desktop.onPresence(listener),
    onFocus: (listener) => desktop.onFocus(listener),
    takeDeepLink: () => desktop.takeDeepLink(),
    onDeepLink: (listener) => desktop.onDeepLink(listener),
    onOpenConversation: (listener) => desktop.onOpenConversation(listener),
    setCloseToTray: (enabled) => void desktop.setCloseToTray(enabled),
    keyWarning: "Your system has no keychain available, so Zuna can't lock its local data to your login. Installing a secret service such as GNOME Keyring fixes this.",
  };
}

function startWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "zuna-core" });
}
