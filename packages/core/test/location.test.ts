// Sharing a location, end to end through a real server, and what the core
// accepts as one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewText } from "../src/notify";
import type { CoreEvent, MessageView } from "../src/types";
import { parseMessageBody } from "../src/validate";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;

const located = (app: TestApp): MessageView | undefined =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message)
    .filter((message) => message.location && message.status === "sent")
    .at(-1);

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  bob = await new TestApp("bob").open();
  await bob.register(await alice.session.createInvite(0, 0), "bob");
  await waitFor(() => alice.session.getUsers().length === 2, "alice to see bob");
});

afterAll(async () => {
  for (const app of [alice, bob]) app?.client.stop();
  await server?.stop();
});

describe("sharing a location", () => {
  const place = { lat: 52.229676, lon: 21.012229, accuracy: 18 };

  it("arrives as the place it was, and reads as a location", async () => {
    alice.session.sendMessage(`user:${bob.userId}`, { location: place });
    await waitFor(() => !!located(bob), "bob to get it");
    const message = located(bob)!;
    expect(message.location).toEqual(place);
    expect(message.text).toBe("");
    expect(previewText(message)).toBe("📍 Location");
    await waitFor(() => bob.events.some((event) => event.type === "notify" && event.body === "📍 Location"), "bob to be told");
  });

  it("shows in a reply, and goes along when forwarded", async () => {
    const original = located(bob)!;
    bob.session.sendMessage(`user:${alice.userId}`, { text: "on my way", replyTo: original.id });
    await waitFor(() => alice.texts(`user:${bob.userId}`).includes("on my way"), "alice to get the reply");
    const reply = alice.events
      .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
      .map((event) => event.message)
      .find((message) => message.text === "on my way")!;
    expect(reply.reply?.text).toBe("📍 Location");

    bob.session.forwardMessage(original.groupId, original.id, `user:${bob.userId}`);
    await waitFor(() => bob.events.some((event) => event.type === "message" && event.message.forwarded && event.message.location?.lat === place.lat && event.message.status === "sent"), "the forwarded copy");
  });

  it("is only one if it's a place on Earth", () => {
    expect(parseMessageBody({ location: { lat: 91, lon: 0 } })).toBeNull();
    expect(parseMessageBody({ location: { lat: 0, lon: -180.5 } })).toBeNull();
    expect(parseMessageBody({ location: { lat: "52", lon: 21 } })).toBeNull();
    expect(parseMessageBody({ location: { lat: Number.NaN, lon: 21 } })).toBeNull();
    // How far off it may be is only a hint, so a nonsense one is dropped and the place stays.
    expect(parseMessageBody({ location: { lat: -33.86, lon: 151.21, accuracy: -5 } })).toEqual({ location: { lat: -33.86, lon: 151.21 } });
  });
});
