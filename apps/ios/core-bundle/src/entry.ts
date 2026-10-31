// The iOS app's copy of the client core. The host loads this bundle into
// JavaScriptCore, calls __zunaBoot once, then passes RPC messages from each of
// its channels to __zunaReceive. It plays the part of the desktop's Worker
// (apps/desktop/src/renderer/src/core/worker.ts).

import "./polyfills";
import { ZunaClient } from "@zuna/core";
import { serveCore } from "@zuna/core/rpc";
import { nativeDbProvider } from "./db";
import { decodeWire, encodeWire } from "./wire";

const g = globalThis as any;

let resolveClient: (client: ZunaClient) => void;
const clientReady = new Promise<ZunaClient>((resolve) => {
  resolveClient = resolve;
});

// Several channels share one core, so call IDs are renumbered on the way in
// and mapped back on the way out. Events go to every channel.
const routes = new Map<number, { channel: number; id: number }>();
let nextCall = 1;

const port = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  postMessage(message: { kind: string; id?: number }) {
    if (message.kind === "reply") {
      const route = routes.get(message.id!);
      if (!route) return;
      routes.delete(message.id!);
      __zunaHost.post(route.channel, encodeWire({ ...message, id: route.id }));
    } else {
      __zunaHost.post(0, encodeWire(message));
    }
  },
};

const emit = serveCore(port, () => clientReady);

g.__zunaReceive = (channel: number, json: string) => {
  const message = decodeWire(json);
  if (message?.kind !== "call") return;
  const id = nextCall++;
  routes.set(id, { channel, id: message.id });
  port.onmessage?.({ data: { ...message, id } } as MessageEvent);
};

g.__zunaBoot = (deviceKey: Uint8Array, deviceName: string, done: (error: string | null) => void) => {
  const client = new ZunaClient({
    db: nativeDbProvider,
    deviceKey,
    deviceName,
    onEvent: (event) => emit(event),
  });
  client.open().then(
    () => {
      resolveClient(client);
      done(null);
    },
    (error: Error) => done(error?.stack ?? String(error)),
  );
};
