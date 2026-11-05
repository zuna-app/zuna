// The client core's home: a dedicated worker that owns all keys and the database.
// Each host's worker calls this, saying how it fetches pages for link previews.

import { ZunaClient, type CoreEvent, type WebAdapter } from "@zuna/core";
import { allowLocalLinks } from "@zuna/core/links";
import { serveCore } from "@zuna/core/rpc";
import { initCrypto } from "@zuna/crypto";
import wasmUrl from "@zuna/crypto/wasm?url";
import { openSqliteProvider } from "./sqlite";

interface BootMessage {
  kind: "boot";
  deviceKey: Uint8Array;
  deviceName: string;
  /** A development build's previews may reach this machine, for its test pages. */
  localLinks: boolean;
  /** The host can trust a server's own certificate by its pin, as only the desktop app can. */
  pinning: boolean;
}

/** The host's answer to trusting a pin, which `connectWorker` sends back. */
interface PinnedMessage {
  kind: "pinned";
  id: number;
  error?: string;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Pictures for link previews are shrunk here, whoever fetched them.
async function shrinkImage(body: Uint8Array, maxSize: number): ReturnType<WebAdapter["shrinkImage"]> {
  try {
    const bitmap = await createImageBitmap(new Blob([body as BlobPart]));
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d")!;
    // JPEG has no transparency; logos are usually drawn for a light page.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    return { data: `data:image/jpeg;base64,${base64(new Uint8Array(await jpeg.arrayBuffer()))}`, width, height };
  } catch {
    return null;
  }
}

/** Serves the core over this worker's messages. Without `fetchPage` there are no link previews. */
export function serveCoreWorker(fetchPage?: WebAdapter["fetch"]): void {
  let resolveClient: (client: ZunaClient) => void;
  const clientReady = new Promise<ZunaClient>((resolve) => {
    resolveClient = resolve;
  });
  const web: WebAdapter | undefined = fetchPage && { fetch: fetchPage, shrinkImage };

  const port = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null };
  const emit: (event: CoreEvent) => void = serveCore(port, () => clientReady);
  const serve = port.onmessage!;
  // Certificates are checked outside the page, so a pin goes to the host through it.
  const pinning = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nextPin = 0;
  const pinServer = (url: string, pin: string) =>
    new Promise<void>((resolve, reject) => {
      const id = nextPin++;
      pinning.set(id, { resolve, reject });
      port.postMessage({ kind: "pin", id, url, pin });
    });

  port.onmessage = async (event: MessageEvent) => {
    const data = event.data as BootMessage | PinnedMessage | { kind: string };
    if (data.kind === "pinned") {
      const { id, error } = data as PinnedMessage;
      const waiting = pinning.get(id);
      pinning.delete(id);
      if (error === undefined) waiting?.resolve();
      else waiting?.reject(new Error(error));
      return;
    }
    if (data.kind !== "boot") {
      void serve.call(port as never, event);
      return;
    }
    const boot = data as BootMessage;
    allowLocalLinks(boot.localLinks);
    try {
      await initCrypto({ module_or_path: wasmUrl });
      const db = await openSqliteProvider();
      const client = new ZunaClient({
        channels: true,
        calls: true,
        db,
        deviceKey: boot.deviceKey,
        deviceName: boot.deviceName,
        onEvent: (coreEvent) => emit(coreEvent),
        web,
        pinServer: boot.pinning ? pinServer : undefined,
      });
      await client.open();
      resolveClient!(client);
      port.postMessage({ kind: "booted" });
    } catch (error) {
      console.error("[zuna] the client core failed to start", error);
      port.postMessage({ kind: "boot_failed", message: (error as Error).message });
    }
  };
}
