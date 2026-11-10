// A proxy in front of a test server that replaces whatever the server says about who
// sent, pinned or deleted a message, or reacted to one, with an account nobody has, in
// every answer and every frame of the socket. With ZUNA_TEST_JUNK_SENDERS set, every
// TestServer stands behind one, so the whole suite shows the apps learn who wrote what
// from what's signed inside, and never from the server.

import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

/** An ID like a real one, of nobody. */
const NOBODY = "0123456789abcdef0123456789abcdef";
const NOBODYS_DEVICE = "fedcba9876543210fedcba9876543210";

const SENDER_FIELDS = ["sender_user", "pinned_by", "pin_by", "deleted_by"];

/** Whether a value is a message as the server describes one, which every answer and frame about a message holds. */
const isMessage = (value: Record<string, unknown>) => Array.isArray(value.reactions) && typeof value.updated_seq === "number" && typeof value.id === "string";

export function junkSenders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(junkSenders);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) out[key] = junkSenders(item);
  if (isMessage(object)) {
    for (const field of SENDER_FIELDS) if (field in out) out[field] = NOBODY;
    if ("sender_device" in out) out.sender_device = NOBODYS_DEVICE;
    out.reactions = (object.reactions as Record<string, unknown>[]).map((reaction) => ({ ...reaction, user_id: NOBODY }));
  }
  // Who's typing, as the socket's frame says.
  if (object.type === "typing" && object.data && typeof object.data === "object") out.data = { ...(object.data as object), user_id: NOBODY };
  return out;
}

function rewrite(text: string): string {
  try {
    return JSON.stringify(junkSenders(JSON.parse(text)));
  } catch {
    return text;
  }
}

/** Starts a proxy to `target` on `port`, and gives a function that stops it. */
export function startJunkProxy(target: string, port: number): Promise<() => Promise<void>> {
  const upstream = new URL(target);
  const server: Server = createServer((incoming, outgoing) => {
    const forwarded = request(
      { host: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url, headers: incoming.headers },
      (answer: IncomingMessage) => {
        const json = (answer.headers["content-type"] ?? "").includes("application/json");
        if (!json) {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
          return;
        }
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => {
          const body = Buffer.from(rewrite(Buffer.concat(chunks).toString("utf8")), "utf8");
          const headers = { ...answer.headers, "content-length": String(body.length) };
          delete headers["transfer-encoding"];
          outgoing.writeHead(answer.statusCode ?? 502, headers);
          outgoing.end(body);
        });
      },
    );
    forwarded.on("error", () => outgoing.destroy());
    incoming.pipe(forwarded);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (incoming, socket, head) => {
    sockets.handleUpgrade(incoming, socket, head, (client) => {
      const backend = new WebSocket(`ws://${upstream.host}${incoming.url}`);
      const waiting: string[] = [];
      backend.on("open", () => waiting.splice(0).forEach((frame) => backend.send(frame)));
      client.on("message", (data) => (backend.readyState === WebSocket.OPEN ? backend.send(data.toString()) : waiting.push(data.toString())));
      backend.on("message", (data) => client.readyState === WebSocket.OPEN && client.send(rewrite(data.toString())));
      const end = (code?: number) => {
        const safe = code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
        if (client.readyState <= WebSocket.OPEN) client.close(safe);
        if (backend.readyState <= WebSocket.OPEN) backend.close(safe);
      };
      client.on("close", (code) => end(code));
      backend.on("close", (code) => end(code));
      client.on("error", () => end());
      backend.on("error", () => end());
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      if (address.port !== port) reject(new Error("the proxy took another port"));
      resolve(
        () =>
          new Promise<void>((done) => {
            for (const client of sockets.clients) client.terminate();
            server.closeAllConnections();
            server.close(() => done());
          }),
      );
    });
  });
}
