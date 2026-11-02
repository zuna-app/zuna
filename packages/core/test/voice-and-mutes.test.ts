// Voice messages, chats muted for a while, and acting on several messages at
// once, end to end through a real server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewText } from "../src/notify";
import type { CoreEvent, MessageView } from "../src/types";
import { FakeRelay, loadCrypto, sleep, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let relay: FakeRelay;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;

const notified = (app: TestApp) => app.events.filter((event): event is Extract<CoreEvent, { type: "notify" }> => event.type === "notify");
const latest = (app: TestApp, text: string): MessageView | undefined =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message)
    .filter((message) => message.text === text && message.status === "sent")
    .at(-1);

beforeAll(async () => {
  loadCrypto();
  relay = new FakeRelay();
  await relay.start();
  server = new TestServer({ pushRelays: [relay.url] });
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  const invite = await alice.session.createInvite(0, 0);
  bob = await new TestApp("bob").open();
  await bob.register(invite, "bob");
  carol = await new TestApp("carol").open();
  await carol.register(invite, "carol");
  await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await server?.stop();
  relay?.stop();
});

describe("voice messages", () => {
  it("arrive with their length and waveform, and read as voice messages", async () => {
    const waveform = Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 37) % 256)).toString("base64");
    const audio = new Uint8Array(20_000).map((_, i) => i & 255);
    await alice.session.sendWithAttachments(
      `user:${bob.userId}`,
      [{ blob: new Blob([audio], { type: "audio/mp4" }), name: "Voice message.m4a", mime: "audio/mp4", duration: 3.4, voice: true, waveform }],
      {},
    );
    await waitFor(() => bob.events.some((event) => event.type === "message" && event.message.attachments[0]?.voice === true && event.message.status === "sent"), "bob to get it");
    const voice = bob.events
      .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
      .map((event) => event.message)
      .find((message) => message.attachments[0]?.voice)!;
    expect(voice.attachments[0]).toMatchObject({ mime: "audio/mp4", duration: 3.4, voice: true, waveform });
    expect(new Uint8Array(await (await bob.session.downloadFile(voice.attachments[0]!)).arrayBuffer())).toEqual(audio);
    expect(previewText(voice)).toBe("🎤 Voice message");
    expect(notified(bob).at(-1)?.body).toBe("🎤 Voice message");
  });
});

describe("muting a chat for a while", () => {
  it("keeps it quiet until the time is up, on every device and for pushes", async () => {
    const key = `user:${alice.userId}`;
    const key32 = new Uint8Array(32).fill(4);
    await bob.session.setPush({ relay: relay.url, handle: "bob-phone", key: key32, registration: "b".repeat(32), sendMuted: true });
    const until = Date.now() + 1500;
    await bob.session.mute(key, until);
    const chat = () => bob.session.getConversations().find((item) => item.key === key)!;
    expect(chat()).toMatchObject({ muted: true, mutedUntil: until });

    // Bob's laptop hears about it too, through his synced preferences.
    const laptop = await new TestApp("bob-laptop").open();
    await laptop.login(server.url, "bob");
    await waitFor(() => laptop.session.getConversations().find((item) => item.key === key)?.muted === true, "the laptop to see the mute");

    const before = notified(bob).length;
    const pushes = relay.pushes.length;
    alice.session.sendMessage(`user:${bob.userId}`, { text: "quiet for now" });
    await waitFor(() => !!latest(bob, "quiet for now"), "bob to get it");
    await sleep(300);
    expect(notified(bob).length).toBe(before);
    expect(relay.pushes.length).toBe(pushes);

    // Once it's over, the app hears the chat isn't muted any more, without anyone touching it.
    const updates = () => bob.events.filter((event) => event.type === "conversations").length;
    const seen = updates();
    await sleep(Math.max(0, until - Date.now()));
    await waitFor(() => updates() > seen, "the app to hear the mute ended", 5000);
    expect(chat()).toMatchObject({ muted: false, mutedUntil: null });
    alice.session.sendMessage(`user:${bob.userId}`, { text: "can you hear me now" });
    await waitFor(() => notified(bob).some((event) => event.body === "can you hear me now"), "a notification again");
    await waitFor(() => relay.pushes.length > pushes, "a push again");

    // Muting for good replaces a time, and unmuting clears both.
    await bob.session.mute(key, Date.now() + 60_000);
    await bob.session.mute(key);
    expect(chat()).toMatchObject({ muted: true, mutedUntil: null });
    expect(bob.session.getPreferences().mutedUntil?.[key]).toBeUndefined();
    await bob.session.unmute(key);
    expect(chat()).toMatchObject({ muted: false, mutedUntil: null });

    // A time with a fraction of a millisecond, as a phone may give one, is kept whole, and
    // one synced that way is sent whole, since the server refuses the registration otherwise.
    await bob.session.mute(key, Date.now() + 60_000.5);
    expect(Number.isInteger(bob.session.getPreferences().mutedUntil?.[key])).toBe(true);
    await bob.session.updatePreferences({ mutedUntil: { [key]: Date.now() + 60_000.5 } });
    await bob.session.setPush({ relay: relay.url, handle: "bob-phone", key: key32, registration: "b".repeat(32), sendMuted: true });
    await bob.session.unmute(key);
    await bob.session.setPush(null);
    laptop.client.stop();
  });
});

describe("several messages at once", () => {
  it("forwards them in order and deletes them together", async () => {
    const dm = `user:${carol.userId}`;
    for (const text of ["one", "two", "three"]) alice.session.sendMessage(dm, { text });
    await waitFor(() => carol.texts(`user:${alice.userId}`).join(",") === "one,two,three", "carol to get all three");
    const groupId = alice.session.getConversations().find((item) => item.key === dm)!.groupId!;
    const ids = ["one", "two", "three"].map((text) => latest(alice, text)!.id);

    await alice.client.forwardMessages(alice.serverId, groupId, ids, alice.serverId, `user:${bob.userId}`);
    await waitFor(() => bob.texts(`user:${alice.userId}`).slice(-3).join(",") === "one,two,three", "bob to get them in order");

    await alice.session.deleteMessages(groupId, ids.slice(0, 2));
    await waitFor(() => carol.texts(`user:${alice.userId}`).join(",") === "three", "carol to see two of them go");
  });
});
