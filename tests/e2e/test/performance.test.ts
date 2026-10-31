// How fast the core runs inside the iOS host. iOS gives apps no JIT. A plain
// JSContext on macOS turns out to run at interpreter speed too (JSC_useJIT
// changes nothing), so these numbers are a fair stand-in for a device.
// Run with ZUNA_PERF=1. ZUNA_PERF_MESSAGES sets the history size (default 10,000).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";
import { HostApp } from "../src/host";

const enabled = process.env.ZUNA_PERF === "1";
const count = Number(process.env.ZUNA_PERF_MESSAGES ?? 10_000);

let server: TestServer;
let alice: TestApp;
let invite: string;
const hosts: HostApp[] = [];

describe.skipIf(!enabled)("performance of the iOS host", () => {
  beforeAll(async () => {
    loadCrypto();
    server = new TestServer();
    await server.start();
    alice = await new TestApp("alice-laptop").open();
    await alice.register(server.setupLink, "alice");
    invite = await alice.session.createInvite(0, 0);
  });

  afterAll(async () => {
    for (const host of hosts) await host.close();
    alice?.client.stop();
    await server?.stop();
  });

  it("reports whether JSC_useJIT=0 really turns the JIT off", async () => {
    const timings: Record<string, number> = {};
    for (const noJit of [false, true]) {
      const host = await new HostApp(noJit ? "nojit" : "jit", { noJit }).open();
      hosts.push(host);
      const script = "(() => { const start = Date.now(); let s = 0; for (let i = 0; i < 3e6; i++) s = (s + i * 7) % 1000003; return Date.now() - start; })()";
      timings[noJit ? "noJit" : "jit"] = Number(await host.evaluate(script));
    }
    console.log(`[perf] tight loop: JIT ${timings.jit} ms, no JIT ${timings.noJit} ms (x${(timings.noJit! / Math.max(timings.jit!, 1)).toFixed(1)})`);
    expect(timings.noJit).toBeGreaterThan(0);
  });

  it(`syncs ${count} messages onto a new device`, { timeout: 1_800_000 }, async () => {
    const phone = await new HostApp("bob-iphone").open();
    hosts.push(phone);
    await phone.register(invite, "bob");
    const bobId = await phone.userId();

    // The server allows each person about 15 messages a second, so a crowd writes the history.
    const senders: TestApp[] = [];
    for (let i = 0; i < 10; i++) {
      const sender = await new TestApp(`sender-${i}`).open();
      await sender.register(invite, `sender${i}`);
      senders.push(sender);
    }
    await waitFor(() => alice.session.getUsers().length >= 12, "alice to see everyone");
    const groupId = await alice.session.createGroup("History", [bobId, ...senders.map((sender) => sender.userId)], false);
    await waitFor(() => senders.every((sender) => sender.session.getConversations().some((item) => item.key === `group:${groupId}` && item.ready)), "the senders to join");
    // Bob's first device joins and files the group's keys in his vault, which is
    // how a later device of his can read the history.
    await waitFor(async () => (await phone.session.getConversations()).some((item) => item.key === `group:${groupId}` && item.ready), "bob's phone to join");
    await sleep(1000);
    await phone.close();

    const sendStart = Date.now();
    senders.forEach((sender, index) => {
      for (let i = index; i < count; i += senders.length) {
        sender.session.sendMessage(`group:${groupId}`, { text: `message number ${i} with a few words of text` });
      }
    });
    const outbox = (app: TestApp) => (app.session as any).db.get("SELECT COUNT(*) AS n FROM outbox").n as number;
    await waitFor(() => senders.every((sender) => outbox(sender) === 0), "everything to be sent", 900_000);
    console.log(`[perf] desktop cores sent ${count} messages in ${Date.now() - sendStart} ms`);
    for (const sender of senders) sender.client.stop();

    for (const noJit of [false]) {
      const device = await new HostApp("bob-new-device", { noJit }).open();
      hosts.push(device);
      const start = Date.now();
      await device.login(server.url, "bob");
      const loggedIn = Date.now() - start;
      await waitFor(async () => {
        const coverage = await device.session.searchCoverage();
        return coverage.total > 0 && coverage.done >= coverage.total;
      }, "the new device to sync", 900_000);
      const synced = Date.now() - start;
      const openStart = Date.now();
      const texts = await device.texts(`group:${groupId}`);
      const opened = Date.now() - openStart;
      const searchStart = Date.now();
      const hits = await device.session.search(`number ${count - 1}`);
      const searched = Date.now() - searchStart;
      const argon2 = Number(await device.evaluate(
        "(() => { const start = Date.now(); __zunaCrypto.argon2id(new Uint8Array(12), new Uint8Array(16), 65536, 3, 1, 32); return Date.now() - start; })()",
      ));
      console.log(
        `[perf] ${noJit ? "no JIT" : "JIT"}: sign in ${loggedIn} ms, sync of ${count} messages ${synced} ms ` +
          `(${(synced / count).toFixed(2)} ms each, including sign-in), open chat ${opened} ms, search ${searched} ms (${hits.length} hits), Argon2id ${argon2} ms`,
      );
      // Every message was decrypted and indexed, not just stored.
      expect(texts).not.toContain("<undecryptable>");
      expect(texts.at(-1)).toMatch(/^message number \d+ with a few words of text$/);
      expect(hits).toHaveLength(1);
      await device.close();
      await sleep(200);
    }
  });
});
