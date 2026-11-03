// The iOS app's copy of the client core. The host loads this bundle into
// JavaScriptCore, calls __zunaBoot once, then passes RPC messages from each of
// its channels to __zunaReceive. It plays the part of the desktop's Worker
// (packages/ui/src/core/serve.ts).

import "./polyfills";
import { ZunaClient, previewPush, type CoreEvent } from "@zuna/core";
import { allowLocalLinks } from "@zuna/core/links";
import { serveCore } from "@zuna/core/rpc";
import { nativeDbProvider } from "./db";
import { nativeFiles } from "./files";
import { nativeWeb } from "./web";
import { decodeWire, encodeWire } from "./wire";

const g = globalThis as any;

let client: ZunaClient | null = null;
let resolveClient: (client: ZunaClient) => void;
const clientReady = new Promise<ZunaClient>((resolve) => {
  resolveClient = resolve;
});

// --- Accounts, for the app's device lock ---
//
// The iOS app keeps its device key sealed with each account's password
// (DeviceLock.swift), so it needs to hear about every sign-in, password change
// and sign-out, whichever channel caused it. The password goes to the host
// and nowhere else.

interface Account {
  url: string;
  username: string;
  name: string;
}

const accounts = new Map<string, Account>();
const accountCalls = new Map<number, { method: string; serverId: string | null; args: unknown[] }>();
const ACCOUNT_METHODS = new Set(["register", "login", "recover", "leaveServer"]);

function rememberAccounts(): void {
  for (const server of client?.listServers() ?? []) {
    accounts.set(server.id, { url: server.url, username: server.username, name: server.name });
  }
}

function reportAccount(type: "signedIn" | "passwordChanged" | "signedOut", account: Account | undefined, password?: unknown): void {
  if (!account) return;
  __zunaHost.accountEvent(
    JSON.stringify({ type, serverUrl: account.url, username: account.username, serverName: account.name, password: typeof password === "string" ? password : undefined }),
  );
}

function afterAccountCall(call: { method: string; serverId: string | null; args: unknown[] }, value: any): void {
  if (call.method === "leaveServer") {
    const serverId = call.args[0] as string;
    reportAccount("signedOut", accounts.get(serverId));
    accounts.delete(serverId);
    return;
  }
  const serverId = call.method === "register" ? value?.serverId : call.method === "changePassword" ? call.serverId : value;
  rememberAccounts();
  const account = accounts.get(serverId);
  if (call.method === "register" || call.method === "login") reportAccount("signedIn", account, call.args[2]);
  if (call.method === "recover") reportAccount("signedIn", account, call.args[3]);
  if (call.method === "changePassword") reportAccount("passwordChanged", account, call.args[1]);
}

// --- RPC ---

// Several channels share one core, so call IDs are renumbered on the way in
// and mapped back on the way out. Events go to every channel.
const routes = new Map<number, { channel: number; id: number }>();
let nextCall = 1;

const port = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  postMessage(message: { kind: string; id?: number; ok?: boolean; value?: unknown }) {
    if (message.kind === "reply") {
      const call = accountCalls.get(message.id!);
      if (call) {
        accountCalls.delete(message.id!);
        if (message.ok) afterAccountCall(call, message.value);
      }
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
  const isAccountCall = message.serverId === null ? ACCOUNT_METHODS.has(message.method) : message.method === "changePassword";
  if (isAccountCall) accountCalls.set(id, { method: message.method, serverId: message.serverId, args: message.args });
  port.onmessage?.({ data: { ...message, id } } as MessageEvent);
};

g.__zunaBoot = (deviceKey: Uint8Array, deviceName: string, done: (error: string | null) => void) => {
  const instance = new ZunaClient({
    db: nativeDbProvider,
    deviceKey,
    deviceName,
    files: nativeFiles,
    web: nativeWeb,
    onEvent: emit,
    channels: true,
    calls: true,
  });
  // Only test builds' previews may reach this device, for their test pages.
  allowLocalLinks(!!__zunaHost.testHooks);
  instance.open().then(
    () => {
      client = instance;
      // Test builds can reach the client's internals, as the desktop's tests do.
      if (__zunaHost.testHooks) g.__zunaTest.client = () => client;
      rememberAccounts();
      resolveClient(instance);
      done(null);
    },
    (error: Error) => done(error?.stack ?? String(error)),
  );
};

// --- Notifications ---
//
// The notification extension loads this bundle too, but never boots a client:
// it asks about one pushed message at a time (push.ts in the core).

g.__zunaPreviewPush = (
  deviceKey: Uint8Array,
  serverId: string,
  groupId: string,
  messageId: string,
  pictures: boolean,
  done: (error: string | null, json: string | null) => void,
) => {
  previewPush({ db: nativeDbProvider, deviceKey }, serverId, groupId, messageId, pictures).then(
    (preview) => done(null, JSON.stringify(preview)),
    (error: Error) => done(error?.stack ?? String(error), null),
  );
};
