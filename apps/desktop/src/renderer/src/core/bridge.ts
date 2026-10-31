// Starts the core worker and connects the UI to it.

import { allowLocalLinks } from "@zuna/core/links";
import { connectCore, type CoreConnection } from "@zuna/core/rpc";
import type { CoreEvent } from "@zuna/core";

export interface DesktopBridge {
  deviceKey(): Promise<{ key: Uint8Array; protected: boolean; deviceName: string; localLinks: boolean }>;
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

export const desktop: DesktopBridge | undefined = window.zunaDesktop;

/** Outside Electron (UI development only) there's no OS keychain to ask. */
function browserDeviceKey(): { key: Uint8Array; protected: boolean; deviceName: string; localLinks: boolean } {
  const stored = localStorage.getItem("zuna-dev-device-key");
  const key = stored ? Uint8Array.from(atob(stored), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(32));
  if (!stored) localStorage.setItem("zuna-dev-device-key", btoa(String.fromCharCode(...key)));
  return { key, protected: false, deviceName: "Browser", localLinks: true };
}

export interface BootResult {
  core: CoreConnection;
  keyProtected: boolean;
}

export function bootCore(onEvent: (event: CoreEvent) => void): Promise<BootResult> {
  return new Promise(async (resolve, reject) => {
    const device = desktop ? await desktop.deviceKey() : browserDeviceKey();
    // The message box finds links here, and the core fetches them in the worker.
    allowLocalLinks(device.localLinks);
    const worker =new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "zuna-core" });

    worker.onerror = (event) => reject(new Error(event.message || "The encryption engine failed to start."));
    const core = connectCore(
      {
        postMessage: (message) => worker.postMessage(message),
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          worker.onmessage = (event) => {
            const data = event.data as { kind: string; message?: string };
            if (data.kind === "booted") {
              resolve({ core, keyProtected: device.protected });
            } else if (data.kind === "boot_failed") {
              reject(new Error(data.message ?? "The encryption engine failed to start."));
            } else {
              handler?.(event);
            }
          };
        },
        get onmessage() {
          return null;
        },
      },
      onEvent,
    );
    worker.postMessage({ kind: "boot", deviceKey: device.key, deviceName: device.deviceName, localLinks: device.localLinks });
  });
}
