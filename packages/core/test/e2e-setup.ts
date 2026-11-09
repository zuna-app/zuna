// What the end-to-end tests share: a server and a push relay, with alice, bob and carol on it.

import { afterAll, beforeAll } from "vitest";
import type { MessageView } from "../src/types";
import { createRequire } from "node:module";
import { FakeRelay, TestApp, TestServer, loadCrypto, waitFor } from "./helpers";

export const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** How long someone shows as online after they stop using the app, here, in place of a minute. */
export const PRESENCE_LINGER = 1_500;

export let server: TestServer;
export let relay: FakeRelay;
export let alice: TestApp;
export let bob: TestApp;
export let carol: TestApp;
export let invite: string;

/** Starts the server these tests share, and what's on it, for the test file that calls this. */
export function startServer(): void {
  beforeAll(async () => {
    loadCrypto();
    relay = new FakeRelay();
    await relay.start();
    server = new TestServer({ pushRelays: [relay.url], presenceLinger: PRESENCE_LINGER });
    await server.start();
    alice = await new TestApp("alice-laptop").open();
    await alice.register(server.setupLink, "alice");
    invite = await alice.session.createInvite(0, 0);
    bob = await new TestApp("bob-laptop").open();
    await bob.register(invite, "bob");
    carol = await new TestApp("carol-laptop").open();
    await carol.register(invite, "carol");
    await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
  });

  afterAll(async () => {
    for (const app of [alice, bob, carol]) app?.client.stop();
    await server?.stop();
    relay?.stop();
  });
}

/** A message a client has, by its text, once it has come. */
export async function waitForMessage(app: TestApp, groupId: string, text: string): Promise<MessageView> {
  let found: MessageView | undefined;
  await waitFor(async () => {
    let page = await app.session.loadMessages(groupId);
    found = page.messages.find((item) => item.text === text);
    while (!found && page.hasMore) {
      page = await app.session.loadMessages(groupId, page.messages.find((item) => item.seq !== null)!.seq!);
      found = page.messages.find((item) => item.text === text);
    }
    return !!found;
  }, `"${text}" to come`, 30_000);
  return found!;
}
