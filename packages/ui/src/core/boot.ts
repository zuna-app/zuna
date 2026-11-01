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

export function connectWorker(worker: Worker, device: DeviceInfo, onEvent: (event: CoreEvent) => void): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    // The message box finds links here, and the core fetches them in the worker.
    allowLocalLinks(device.localLinks);
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
