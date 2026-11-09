// What the security tests share: a server with alice on it, and helpers that make people and
// groups and do what a malicious server would.

import * as wasm from "@zuna/crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { Api } from "../src/api";
import { frameSigned, sealEnvelope } from "../src/crypto";
import { TestApp, TestServer, loadCrypto, waitFor } from "./helpers";

export let server: TestServer;
export let alice: TestApp;
let invite: string;
let counter = 0;

export const open: TestApp[] = [];

export async function person(name: string): Promise<TestApp> {
  const app = await new TestApp(name).open();
  await app.register(invite, `${name}${++counter}`);
  await waitFor(() => alice.session.getUsers().some((user) => user.id === app.userId), "everyone to see them");
  await waitFor(() => app.session.getUsers().some((user) => user.id === alice.userId), "them to see everyone");
  open.push(app);
  return app;
}

/** Someone's connection to the server with everything a real client's calls use. */
export const apiOf = (app: TestApp): Api => (app.session as any).api;

export async function groupWith(owner: TestApp, members: TestApp[], history = false, name = "A group"): Promise<string> {
  const groupId = await owner.session.createGroup(name, members.map((member) => member.userId), history);
  for (const member of members) {
    await waitFor(() => member.session.getConversations().some((item) => item.groupId === groupId && item.ready), "them to join");
    await waitFor(() => (member.session as any).hasMlsGroup(groupId), "their keys");
  }
  return groupId;
}

export const securityEvents = (app: TestApp) => app.events.filter((event) => event.type === "security");

/** An attacker's MLS client holding a real device's public certificate, with keys of its own. */
export function ghostClient(certificate: Uint8Array) {
  const keys = wasm.signingKeygen();
  return new wasm.MlsClient(keys.publicKey, keys.secretKey, certificate, [] as unknown as any[]);
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
  });

  afterAll(async () => {
    for (const app of open) app.client.stop();
    await server?.stop();
  });
}

/** The server's database, for what a malicious server writes for itself. */
export function withServerDatabase<T>(use: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(join((server as any).dir as string, "zuna.db"));
  db.exec("PRAGMA busy_timeout = 10000");
  try {
    return use(db);
  } finally {
    db.close();
  }
}

export const sessionOf = (app: TestApp) => app.session as any;
export const warned = (app: TestApp, text: string) => securityEvents(app).some((event) => (event as { message: string }).message.includes(text));

/** What a malicious server writes to delete a message, with whatever proof it has. */
export function serverDeletes(groupId: string, messageId: string, by: string, deletion: Uint8Array | null): void {
  withServerDatabase((db) => {
    const { seq } = db.prepare("UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq").get(groupId) as { seq: number };
    db.prepare("UPDATE messages SET envelope = NULL, deleted_at = ?, updated_seq = ?, deleted_by = ?, deletion = ? WHERE group_id = ? AND id = ?").run(
      Date.now(),
      seq,
      by,
      deletion,
      groupId,
      messageId,
    );
  });
}

/** A deletion `app`'s device signs, of whichever message it likes. */
export function signedDeletion(app: TestApp, groupId: string, messageId: string): Uint8Array {
  const session = sessionOf(app);
  const epoch = session.mlsEpoch(groupId) as number;
  const { deviceId, deviceSecret } = session.account;
  return frameSigned(deviceId, epoch, sealEnvelope(session.epochKey(groupId, epoch), deviceSecret, "deletion", groupId, messageId, epoch, { by: app.userId }, { userId: app.userId, deviceId }));
}

export async function threeInAGroup() {
  const admin = await person("yara");
  const member = await person("zack");
  const other = await person("abel");
  const groupId = await groupWith(admin, [member, other]);
  return { admin, member, other, groupId };
}

export async function sentAndSeen(from: TestApp, to: TestApp[], groupId: string, text: string): Promise<string> {
  const sent = from.session.sendMessage(`group:${groupId}`, { text });
  for (const app of to) await waitFor(() => app.texts(`group:${groupId}`).includes(text), "delivery");
  return sent.id;
}
