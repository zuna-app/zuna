// The client core's home: a dedicated worker that owns all keys and the database.

import { ZunaClient, type CoreEvent } from "@zuna/core";
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
    });
    await client.open();
    resolveClient(client);
    port.postMessage({ kind: "booted" });
  } catch (error) {
    console.error("[zuna] the client core failed to start", error);
    port.postMessage({ kind: "boot_failed", message: (error as Error).message });
  }
};
