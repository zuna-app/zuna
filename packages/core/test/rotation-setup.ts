// What the rotation tests share: a server with alice on it, helpers that make people, second
// devices and groups, and reads of the server's database.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { Api } from "../src/api";
import { TestApp, TestServer, loadCrypto, waitFor } from "./helpers";

export let server: TestServer;
export let alice: TestApp;
export let invite: string;
let counter = 0;
/** A number for a new username, which has to be unique on the server. */
export const nextNumber = (): number => ++counter;

export const open: TestApp[] = [];

export async function person(name: string): Promise<TestApp> {
  const app = await new TestApp(name).open();
  await app.register(invite, `${name}${++counter}`);
  await waitFor(() => alice.session.getUsers().some((user) => user.id === app.userId), "everyone to see them");
  await waitFor(() => app.session.getUsers().some((user) => user.id === alice.userId), "them to see everyone");
  open.push(app);
  return app;
}

export async function secondDevice(of: TestApp, name: string, password = "correct horse battery"): Promise<TestApp> {
  const app = await new TestApp(name).open();
  await app.login(server.url, of.session.getSelf().username, password);
  await waitFor(() => (of.session as any).users.get(of.userId).devices.has(app.session.getSelf().deviceId), "the other device to see it");
  open.push(app);
  return app;
}

export const sessionOf = (app: TestApp) => app.session as any;
export const apiOf = (app: TestApp): Api => sessionOf(app).api;
export const generationOf = (app: TestApp): number => sessionOf(app).account.core.generation;
export const accountKeyOf = (app: TestApp): Uint8Array => sessionOf(app).account.accountKey;
export const securityEvents = (app: TestApp) => app.events.filter((event) => event.type === "security") as { message: string }[];
export const atGeneration = (app: TestApp, generation: number) => waitFor(() => generationOf(app) >= generation, `${app.name} to reach generation ${generation}`);

export async function groupWith(owner: TestApp, members: TestApp[], history = false): Promise<string> {
  const groupId = await owner.session.createGroup("A group", members.map((member) => member.userId), history);
  for (const member of members) {
    await waitFor(() => member.session.getConversations().some((item) => item.groupId === groupId && item.ready), "them to join");
    await waitFor(() => sessionOf(member).hasMlsGroup(groupId), "their keys");
  }
  return groupId;
}

/** The server's database, as a stolen backup would have it, or for a malicious server to change. */
export function serverDatabase(): InstanceType<typeof DatabaseSync> {
  const dir = (server as any).dir as string;
  const db = new DatabaseSync(join(dir, "zuna.db"));
  db.exec("PRAGMA busy_timeout = 10000");
  return db;
}

export function serverVault(userId: string): { id: string; generation: number; data: Uint8Array; seq: number }[] {
  const db = serverDatabase();
  try {
    return db.prepare("SELECT id, seq, generation, data FROM vault_items WHERE user_id = ? ORDER BY seq").all(userId) as never;
  } finally {
    db.close();
  }
}

/** Starts the server these tests share, and what's on it, for the test file that calls this. */
export function startServer(): void {
  beforeAll(async () => {
    loadCrypto();
    server = new TestServer({ sqlite: true });
    await server.start();
    alice = await new TestApp("alice").open();
    await alice.register(server.setupLink, "alice");
    invite = await alice.session.createInvite(0, 0);
    open.push(alice);
  }, 120_000);

  afterAll(async () => {
    for (const app of open) app.client?.stop();
    await server.stop();
  });
}
