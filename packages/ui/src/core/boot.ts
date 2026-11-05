// Connects the UI to the core worker a host has started.

import { allowLocalLinks } from "@zuna/core/links";
import { connectCore } from "@zuna/core/rpc";
import type { CoreEvent } from "@zuna/core";
import type { BootResult } from "@/platform";

export interface DeviceInfo {
  key: Uint8Array;
  protected: boolean;
  deviceName: string;
  /** A development build's previews may reach this machine, for its test pages. */
  localLinks: boolean;
}

/**
 * `pinServer` has the host trust a server's own certificate by its pin, for a host
 * that checks certificates itself. Without it, the core can't reach such a server.
 */
export function connectWorker(
  worker: Worker,
  device: DeviceInfo,
  onEvent: (event: CoreEvent) => void,
  pinServer?: (url: string, pin: string) => Promise<void>,
): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    // The message box finds links here, and the core fetches them in the worker.
    allowLocalLinks(device.localLinks);
    worker.onerror = (event) => reject(new Error(event.message || "The encryption engine failed to start."));
    const core = connectCore(
      {
        postMessage: (message) => worker.postMessage(message),
        set onmessage(handler: ((event: MessageEvent) => void) | null) {
          worker.onmessage = (event) => {
            const data = event.data as { kind: string; message?: string; id?: number; url?: string; pin?: string };
            if (data.kind === "pin" && pinServer) {
              pinServer(data.url!, data.pin!).then(
                () => worker.postMessage({ kind: "pinned", id: data.id }),
                (error: Error) => worker.postMessage({ kind: "pinned", id: data.id, error: error.message || "The certificate couldn't be trusted." }),
              );
            } else if (data.kind === "booted") {
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
    worker.postMessage({ kind: "boot", deviceKey: device.key, deviceName: device.deviceName, localLinks: device.localLinks, pinning: !!pinServer });
  });
}
