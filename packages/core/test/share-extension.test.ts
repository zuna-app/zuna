// Two processes on one device's data, as the iOS app and its share extension
// are: the app suspends, the extension sends with a core of its own, and the
// app reads everything again before going on, its MLS groups above all.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZunaClient } from "../src/client";
import { loadCrypto, MemoryDbProvider, png, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let dir: string;
let phone: TestApp;
let bob: TestApp;

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  dir = mkdtempSync(join(tmpdir(), "zuna-share-"));
  phone = await new TestApp("phone", dir).open();
  await phone.register(server.setupLink, "pat");
  bob = await new TestApp("bob").open();
  await bob.register(await phone.session.createInvite(0, 0), "bob");
  await waitFor(() => phone.session.getUsers().length === 2, "pat to see bob");
  phone.session.sendMessage(`user:${bob.userId}`, { text: "before" });
  await waitFor(() => bob.texts(`user:${phone.userId}`).includes("before"), "bob to get the first message");
});

afterAll(async () => {
  for (const app of [phone, bob]) app?.client.stop();
  await server?.stop();
  try {
    if (dir) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold a database file open for a moment longer.
  }
});

const dmId = () => bob.session.getConversations().find((item) => item.key === `user:${phone.userId}`)!.groupId!;
const epochOf = (app: TestApp) => (app.session as any).mlsEpoch(dmId()) as number;

/** Moves the DM to a new epoch with a commit of the session's own. */
async function newEpoch(session: any): Promise<void> {
  await session.withLock(dmId(), () => session.commitWithRetry(dmId(), async () => ({ kind: "update" })));
}

/** The share extension: another client on the same databases and device key. */
async function shareExtension(): Promise<ZunaClient> {
  const client = new ZunaClient({ db: new MemoryDbProvider(dir), deviceKey: phone.deviceKey, deviceName: "phone", onEvent: () => {}, channels: true, calls: true });
  await client.open();
  await waitFor(() => client.session(phone.serverId).connectionState === "online", "the share extension to come online");
  return client;
}

describe("a share extension beside the app", () => {
  it("sends while the app is suspended, and the app carries on after reading everything again", async () => {
    phone.client.suspend();
    const share = await shareExtension();
    // This device moves the group on, as when its epoch is a week old, and only the share extension
    // knows. Coming across its own commit later, the app would have to rejoin to catch up.
    await newEpoch(share.session(phone.serverId));
    const epoch = (share.session(phone.serverId) as any).mlsEpoch(dmId()) as number;
    await share.session(phone.serverId).sendNow(`user:${bob.userId}`, [{ blob: new Blob([new Uint8Array(png(40, 30))], { type: "image/png" }), name: "photo.png", mime: "image/png", width: 40, height: 30 }], {
      text: "from the share sheet",
    });
    share.suspend();
    share.stop();
    await waitFor(() => bob.texts(`user:${phone.userId}`).includes("from the share sheet"), "bob to get what was shared");

    await phone.client.reload();
    await phone.online();
    expect(phone.texts(`user:${bob.userId}`)).toContain("from the share sheet");
    phone.session.sendMessage(`user:${bob.userId}`, { text: "after" });
    await waitFor(() => bob.texts(`user:${phone.userId}`).includes("after"), "bob to get the app's next message");
    expect(epochOf(phone)).toBe(epoch);
    expect(epochOf(bob)).toBe(epoch);

    // Both are still in step with the group from here on.
    await newEpoch(bob.session);
    bob.session.sendMessage(`user:${phone.userId}`, { text: "still in step" });
    await waitFor(() => phone.texts(`user:${bob.userId}`).includes("still in step"), "pat to read bob's next message");
  });

  it("writes nothing while suspended, and reads everything again on resuming if something tried", async () => {
    phone.client.suspend();
    expect(() => phone.session.sendMessage(`user:${bob.userId}`, { text: "too soon" })).toThrow(/busy right now/);
    expect(await phone.client.resume()).toBe(true);
    await phone.online();
    phone.session.sendMessage(`user:${bob.userId}`, { text: "once awake" });
    await waitFor(() => bob.texts(`user:${phone.userId}`).includes("once awake"), "bob to get it");
    expect(bob.texts(`user:${phone.userId}`)).not.toContain("too soon");

    // With nothing refused, resuming is only reconnecting.
    phone.client.suspend();
    expect(await phone.client.resume()).toBe(false);
    await phone.online();
  });
});
