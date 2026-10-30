// Calls from the UI thread into the client core, which runs in a Worker so that
// cryptography and the database can never block scrolling or animation.

import type { ZunaClient } from "./client";
import type { ServerSession } from "./session";
import type { CoreEvent } from "./types";

type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export type RemoteClient = Remote<ZunaClient>;
export type RemoteSession = Remote<ServerSession>;

export interface CoreConnection {
  client: RemoteClient;
  session(serverId: string): RemoteSession;
}

interface CallMessage {
  kind: "call";
  id: number;
  serverId: string | null;
  method: string;
  args: unknown[];
}

interface ReplyMessage {
  kind: "reply";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string; code?: string; status?: number };
}

interface EventMessage {
  kind: "event";
  event: CoreEvent;
}

export interface RpcPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** Runs in the worker: answers calls by invoking methods on the client or a session. */
export function serveCore(port: RpcPort, getClient: () => ZunaClient | Promise<ZunaClient>): (event: CoreEvent) => void {
  port.onmessage = async ({ data }: MessageEvent) => {
    const call = data as CallMessage;
    if (call.kind !== "call") return;
    try {
      const client = await getClient();
      const target: any = call.serverId ? client.session(call.serverId) : client;
      const value = await target[call.method](...call.args);
      port.postMessage({ kind: "reply", id: call.id, ok: true, value } satisfies ReplyMessage);
    } catch (error) {
      const failure = error as Error & { code?: string; status?: number };
      port.postMessage({
        kind: "reply",
        id: call.id,
        ok: false,
        error: { name: failure.name, message: failure.message ?? String(error), code: failure.code, status: failure.status },
      } satisfies ReplyMessage);
    }
  };
  return (event) => port.postMessage({ kind: "event", event } satisfies EventMessage);
}

export class CoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

/** Runs on the UI thread: gives typed, promise-returning proxies of the core. */
export function connectCore(port: RpcPort, onEvent: (event: CoreEvent) => void): CoreConnection {
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  port.onmessage = ({ data }: MessageEvent) => {
    const message = data as ReplyMessage | EventMessage;
    if (message.kind === "event") {
      onEvent(message.event);
    } else if (message.kind === "reply") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.value);
      } else {
        entry.reject(new CoreError(message.error?.message ?? "Something went wrong.", message.error?.code, message.error?.status));
      }
    }
  };

  const proxyFor = <T>(serverId: string | null): T =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          (...args: unknown[]) =>
            new Promise((resolve, reject) => {
              const id = nextId++;
              pending.set(id, { resolve, reject });
              port.postMessage({ kind: "call", id, serverId, method, args } satisfies CallMessage);
            }),
      },
    ) as T;

  const sessions = new Map<string, RemoteSession>();
  return {
    client: proxyFor<RemoteClient>(null),
    session(serverId) {
      let session = sessions.get(serverId);
      if (!session) {
        session = proxyFor<RemoteSession>(serverId);
        sessions.set(serverId, session);
      }
      return session;
    },
  };
}
