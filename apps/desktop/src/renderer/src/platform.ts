// The desktop's side of the interface: everything the Electron shell provides,
// through the bridge the preload script exposes.

import { connectWorker, type DeviceInfo, type Platform } from "@zuna/ui";

export interface DesktopBridge {
  /** Whether the system shows times with AM and PM. */
  hour12: boolean;
  deviceKey(): Promise<DeviceInfo>;
  platform(): Promise<string>;
  /** Whether the operating system lets Zuna record, asking the person the first time. */
  microphone(): Promise<boolean>;
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

/** Outside Electron (UI development only) there's no OS keychain to ask. */
function browserDeviceKey(): DeviceInfo {
  const stored = localStorage.getItem("zuna-dev-device-key");
  const key = stored ? Uint8Array.from(atob(stored), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(32));
  if (!stored) localStorage.setItem("zuna-dev-device-key", btoa(String.fromCharCode(...key)));
  return { key, protected: false, deviceName: "Browser", localLinks: true };
}

export function desktopPlatform(): Platform {
  const desktop = window.zunaDesktop;
  if (!desktop) {
    return {
      hour12: undefined,
      titleBar: false,
      bootCore: (onEvent) => connectWorker(startWorker(), browserDeviceKey(), onEvent),
      openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
      setUnreadCount: () => undefined,
      keyWarning: null,
    };
  }
  return {
    hour12: desktop.hour12,
    titleBar: true,
    os: () => desktop.platform(),
    bootCore: async (onEvent) => connectWorker(startWorker(), await desktop.deviceKey(), onEvent),
    openExternal: (url) => void desktop.openExternal(url),
    setUnreadCount: (count) => void desktop.setBadge(count),
    notify: (payload) => void desktop.notify(payload),
    microphone: () => desktop.microphone(),
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
