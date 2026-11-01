// The lists in a chat's details, as in Telegram: its photos, videos, files, sound
// files, voice messages and links, counted and paged from the messages on a device.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaCounts } from "../src/types";
import { loadCrypto, png, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;

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

const file = (name: string, mime: string, extra: { width?: number; height?: number; duration?: number; voice?: boolean } = {}) => ({
  blob: new Blob([mime.startsWith("image/") ? new Uint8Array(png(4, 4)) : new Uint8Array(64).fill(7)], { type: mime }),
  name,
  mime,
  ...extra,
});

describe("a chat's photos, files and links", () => {
  it("are counted and listed by kind, newest first, and follow edits and deletions", async () => {
    const dm = `user:${bob.userId}`;
    await alice.session.sendWithAttachments(
      dm,
      [file("one.png", "image/png", { width: 4, height: 4 }), file("two.png", "image/png", { width: 4, height: 4 }), file("report.pdf", "application/pdf"), file("odd.png", "image/png")],
      { text: "the trip" },
    );
    await alice.session.sendWithAttachments(dm, [file("clip.mp4", "video/mp4", { width: 16, height: 9, duration: 2 })], {});
    await alice.session.sendWithAttachments(dm, [file("song.mp3", "audio/mpeg", { duration: 3 })], {});
    await alice.session.sendWithAttachments(dm, [file("Voice message.m4a", "audio/mp4", { duration: 1, voice: true })], {});
    alice.session.sendMessage(dm, { text: "see https://example.com/a and https://example.org/b" });
    alice.session.sendMessage(dm, { text: "and https://example.net/c" });
    // Links in code and spoilers aren't shown as links, so they aren't shared ones.
    alice.session.sendMessage(dm, { text: "`https://example.com/code` ||https://example.com/secret|| nothing else" });
    alice.session.sendMessage(dm, { text: "done" });

    const groupId = () => bob.session.getConversations().find((item) => item.key === `user:${alice.userId}`)?.groupId ?? "";
    await waitFor(() => bob.texts(`user:${alice.userId}`).includes("done"), "bob to get everything");
    const expected: MediaCounts = { photo: 2, video: 1, file: 2, audio: 1, voice: 1, link: 2 };
    expect(bob.session.mediaCounts(groupId())).toEqual(expected);
    await waitFor(() => JSON.stringify(alice.session.mediaCounts(groupId())) === JSON.stringify(expected), "alice's own copies to be counted too");

    const photos = bob.session.loadMedia(groupId(), "photo");
    expect(photos.hasMore).toBe(false);
    expect(photos.messages.map((message) => message.attachments.map((item) => item.name))).toEqual([["one.png", "two.png", "report.pdf", "odd.png"]]);
    expect(bob.session.loadMedia(groupId(), "voice").messages[0]!.attachments[0]!.voice).toBe(true);

    const newest = bob.session.loadMedia(groupId(), "link", undefined, 1);
    expect(newest).toMatchObject({ hasMore: true, messages: [{ text: "and https://example.net/c" }] });
    const older = bob.session.loadMedia(groupId(), "link", newest.messages[0]!.seq!, 1);
    expect(older).toMatchObject({ hasMore: false, messages: [{ text: "see https://example.com/a and https://example.org/b" }] });

    // The database names the kinds only by keyed hashes, as it does words.
    const kinds = (bob.session as any).db.all("SELECT DISTINCT kind FROM media") as { kind: string }[];
    expect(kinds.length).toBe(6);
    for (const { kind } of kinds) expect(kind).toMatch(/^h[0-9a-f]{16}$/);

    alice.session.editMessage(groupId(), newest.messages[0]!.id, "and no link after all", {}, []);
    await alice.session.deleteMessage(groupId(), photos.messages[0]!.id);
    await waitFor(() => bob.session.mediaCounts(groupId()).link === 1 && bob.session.mediaCounts(groupId()).photo === 0, "bob to see the edit and the deletion");
    expect(bob.session.mediaCounts(groupId())).toEqual({ ...expected, photo: 0, file: 0, link: 1 });
    expect(bob.session.loadMedia(groupId(), "photo").messages).toEqual([]);
  });

  it("are counted again for messages from before the index had them", async () => {
    const groupId = bob.session.getConversations().find((item) => item.key === `user:${alice.userId}`)!.groupId!;
    const before = bob.session.mediaCounts(groupId);
    const session = bob.session as any;
    session.db.run("DELETE FROM media");
    expect(Object.values(bob.session.mediaCounts(groupId)).every((count) => count === 0)).toBe(true);
    session.setKv("search_version", 2);
    await session.rebuildSearchIndex();
    expect(bob.session.mediaCounts(groupId)).toEqual(before);
  });
});
