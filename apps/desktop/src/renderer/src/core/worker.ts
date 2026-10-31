// The client core's home: a dedicated worker that owns all keys and the database.

import { ZunaClient, type CoreEvent, type WebAdapter } from "@zuna/core";
import { serveCore } from "@zuna/core/rpc";
import { initCrypto } from "@zuna/crypto";
import wasmUrl from "@zuna/crypto/wasm?url";
import { openSqliteProvider } from "./sqlite";

interface BootMessage {
  kind: "boot";
  deviceKey: Uint8Array;
  deviceName: string;
}

let resolveClient: (client: ZunaClient) => void;
const clientReady = new Promise<ZunaClient>((resolve) => {
  resolveClient = resolve;
});

let emit: (event: CoreEvent) => void = () => undefined;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Link previews: a worker can't read other sites, so pages come through the
// main process (zuna-web:), and pictures are shrunk here.
const web: WebAdapter = {
  async fetch(url, maxBytes) {
    const response = await fetch(`zuna-web://fetch/?url=${encodeURIComponent(url)}&max=${maxBytes}`);
    if (!response.ok) throw new Error("The page isn't available.");
    return {
      url: response.headers.get("x-zuna-url") ?? url,
      type: response.headers.get("content-type") ?? "",
      body: new Uint8Array(await response.arrayBuffer()),
    };
  },
  async shrinkImage(body, maxSize) {
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
  },
};

const port = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null };
emit = serveCore(port, () => clientReady);
const serve = port.onmessage!;

port.onmessage = async (event: MessageEvent) => {
  const data = event.data as BootMessage | { kind: string };
  if (data.kind !== "boot") {
    void serve.call(port as never, event);
    return;
  }
  const boot = data as BootMessage;
  try {
    await initCrypto({ module_or_path: wasmUrl });
    const db = await openSqliteProvider();
    const client = new ZunaClient({
      db,
      deviceKey: boot.deviceKey,
      deviceName: boot.deviceName,
      onEvent: (coreEvent) => emit(coreEvent),
      web,
    });
    await client.open();
    resolveClient(client);
    port.postMessage({ kind: "booted" });
  } catch (error) {
    console.error("[zuna] the client core failed to start", error);
    port.postMessage({ kind: "boot_failed", message: (error as Error).message });
  }
};
