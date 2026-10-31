// Forwarding messages, within a server and to another one, and link previews
// made on the sender's device, end to end through real servers.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findLink } from "../src/links";
import type { CoreEvent, LinkPreview, MessageView } from "../src/types";
import { loadCrypto, nodeWeb, png, TestApp, TestServer, waitFor } from "./helpers";

const picture = png(1200, 630);

/** A small site with the kinds of pages links point to. */
function startSite(): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    const html = (body: string, type = "text/html; charset=utf-8") => {
      response.writeHead(200, { "content-type": type });
      response.end(body);
    };
    switch (request.url) {
      case "/article":
        return html(`<!doctype html><html><head>
          <title>Ignored when there's og:title</title>
          <meta property="og:site_name" content="The Daily Zuna">
          <meta content="Ships &amp; harbours" property="og:title">
          <meta name="description" content="Plain description">
          <meta property="og:description" content="Everything about the  new
            harbour, in one long read.">
          <meta property="og:image" content="/pictures/harbour.png">
          </head><body><meta property="og:title" content="Not in the head"></body></html>`);
      case "/moved":
        response.writeHead(302, { location: "/article" });
        return response.end();
      case "/title-only":
        return html("<html><head><title>Just a &#x201C;title&#x201D;</title></head></html>");
      case "/latin2":
        return html(Buffer.from([...Buffer.from("<html><head><title>Za"), 0xbf, 0xf3, 0xb3, 0xe6, ...Buffer.from("</title></head></html>")]) as never, "text/html; charset=iso-8859-2");
      case "/nothing":
        return html("<html><head></head><body>No title at all</body></html>");
      case "/pictures/harbour.png":
        response.writeHead(200, { "content-type": "image/png" });
        return response.end(picture);
      default:
        response.writeHead(404);
        return response.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits })));
}

let first: TestServer;
let second: TestServer;
let site: Awaited<ReturnType<typeof startSite>>;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;
let bobFirst = "";
let bobSecond = "";
let carolFirst = "";
let carolSecond = "";

const messages = (app: TestApp) =>
  app.events.filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message").map((event) => event.message);

/** The latest state of a message someone received, found by its text. */
const received = (app: TestApp, text: string, serverId?: string): MessageView | undefined =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message" && (!serverId || event.serverId === serverId))
    .map((event) => event.message)
    .filter((message) => message.text === text && message.status === "sent")
    .at(-1);

beforeAll(async () => {
  loadCrypto();
  first = new TestServer();
  second = new TestServer();
  await Promise.all([first.start(), second.start()]);
  site = await startSite();

  alice = await new TestApp("alice").open();
  await alice.register(first.setupLink, "alice");
  const firstInvite = await alice.session.createInvite(0, 0);
  bob = new TestApp("bob");
  bob.web = nodeWeb;
  await bob.open();
  await bob.register(firstInvite, "bob");
  bobFirst = bob.serverId;
  carol = await new TestApp("carol").open();
  await carol.register(firstInvite, "carol");
  carolFirst = carol.serverId;

  // Bob runs the second server, and carol is on it too.
  await bob.register(second.setupLink, "bob");
  bobSecond = bob.serverId;
  const secondInvite = await bob.session.createInvite(0, 0);
  await carol.register(secondInvite, "carol");
  carolSecond = carol.serverId;
  await waitFor(() => alice.session.getUsers().length === 3, "alice to see everyone");
  await waitFor(() => bob.client.session(bobSecond).getUsers().length === 2, "bob to see carol on his server");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await Promise.all([first?.stop(), second?.stop()]);
  site?.server.close();
});

describe("forwarding", () => {
  let original: MessageView;
  const photo = new Uint8Array(300_000).map((_, i) => (i * 31) & 255);

  beforeAll(async () => {
    const bobId = bob.client.session(bobFirst).getSelf().userId;
    await alice.session.sendWithAttachments(`user:${bobId}`, [{ blob: new Blob([photo], { type: "image/png" }), name: "harbour.png", mime: "image/png", width: 40, height: 30 }], {
      text: "look at this",
      mentions: [bobId],
    });
    await waitFor(() => !!received(bob, "look at this", bobFirst), "bob to get alice's photo");
    original = received(bob, "look at this", bobFirst)!;
  });

  it("names the author within a server and shares the files", async () => {
    const carolId = carol.client.session(carolFirst).getSelf().userId;
    await bob.client.forwardMessages(bobFirst, original.groupId, [original.id], bobFirst, `user:${carolId}`);
    await waitFor(() => !!received(carol, "look at this", carolFirst), "carol to get the forwarded photo");
    const copy = received(carol, "look at this", carolFirst)!;

    expect(copy.senderId).toBe(bob.client.session(bobFirst).getSelf().userId);
    expect(copy.forwarded).toEqual({ userId: alice.userId });
    // Mentions and replies belong to the original conversation.
    expect(copy.mentions).toEqual([]);
    expect(copy.attachments[0]).toMatchObject({ fileId: original.attachments[0]!.fileId, name: "harbour.png", width: 40 });

    // The photo stays while a copy uses it, even once the original is deleted.
    await alice.session.deleteMessage(original.groupId, original.id);
    const blob = await carol.client.session(carolFirst).downloadFile(copy.attachments[0]!);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(photo);
  });

  it("keeps the first author when a forwarded message is forwarded again", async () => {
    const copy = received(carol, "look at this", carolFirst)!;
    const bobId = bob.client.session(bobFirst).getSelf().userId;
    const before = messages(bob).length;
    await carol.client.forwardMessages(carolFirst, copy.groupId, [copy.id], carolFirst, `user:${bobId}`);
    await waitFor(
      () => messages(bob).slice(before).some((message) => message.senderId === carol.client.session(carolFirst).getSelf().userId && message.status === "sent"),
      "bob to get carol's forward",
    );
    const again = messages(bob).slice(before).filter((message) => message.status === "sent").at(-1)!;
    expect(again.forwarded).toEqual({ userId: alice.userId });
  });

  it("only says it's forwarded on another server, and uploads the files there", async () => {
    const copy = received(carol, "look at this", carolFirst)!;
    const bobOnSecond = bob.client.session(bobSecond).getSelf().userId;
    const before = messages(bob).length;
    await carol.client.forwardMessages(carolFirst, copy.groupId, [copy.id], carolSecond, `user:${bobOnSecond}`);
    await waitFor(() => !!received(bob, "look at this", bobSecond), "bob to get it on his own server");
    const there = received(bob, "look at this", bobSecond)!;

    expect(messages(bob).length).toBeGreaterThan(before);
    expect(there.forwarded).toEqual({});
    expect(there.attachments[0]!.fileId).not.toBe(copy.attachments[0]!.fileId);
    const blob = await bob.client.session(bobSecond).downloadFile(there.attachments[0]!);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(photo);
  });

  it("refuses messages that aren't there to forward", async () => {
    await expect(bob.client.forwardMessages(bobFirst, original.groupId, ["no-such-message"], bobFirst, `user:${alice.userId}`)).rejects.toThrow();
  });
});

describe("link previews", () => {
  it("finds the first link that can have a preview", () => {
    expect(findLink("see https://example.com/a, then https://example.org")).toBe("https://example.com/a");
    expect(findLink("`https://in.code` and ||https://hidden.example|| but (https://shown.example/x)")).toBe("https://shown.example/x");
    expect(findLink("```\nhttps://in.block\n``` http://insecure.example")).toBeNull();
    expect(findLink("local http://127.0.0.1:8080/page.")).toBe("http://127.0.0.1:8080/page");
    expect(findLink("no links here")).toBeNull();
  });

  it("makes a preview on the sender's device from the page's tags", async () => {
    const link = `${site.url}/moved`;
    const preview = (await bob.client.linkPreview(link))!;
    expect(preview).toMatchObject({
      url: link,
      title: "Ships & harbours",
      description: "Everything about the new harbour, in one long read.",
      siteName: "The Daily Zuna",
      image: { width: 1200, height: 630 },
    });
    expect(preview.image!.data.startsWith("data:image/png;base64,")).toBe(true);
    expect(site.hits).toContain("/pictures/harbour.png");

    expect(await bob.client.linkPreview(`${site.url}/title-only`)).toMatchObject({ title: "Just a “title”", siteName: "127.0.0.1" });
    expect((await bob.client.linkPreview(`${site.url}/latin2`))?.title).toBe("Zażółć");
    expect(await bob.client.linkPreview(`${site.url}/nothing`)).toBeNull();
    expect(await bob.client.linkPreview(`${site.url}/missing`)).toBeNull();
    expect(await bob.client.linkPreview(`${site.url}/pictures/harbour.png`)).toMatchObject({ image: { width: 1200 }, siteName: "127.0.0.1" });
    // Only a device that can fetch pages makes previews.
    expect(await alice.client.linkPreview(`${site.url}/article`)).toBeNull();
  });

  it("sends the preview inside the message, and checks it on arrival", async () => {
    const link = `${site.url}/article`;
    const preview = (await bob.client.linkPreview(link))!;
    const hits = site.hits.length;
    const aliceId = alice.userId;
    const session = bob.client.session(bobFirst);
    session.sendMessage(`user:${aliceId}`, { text: `read ${link} tonight`, preview });
    await waitFor(() => !!received(alice, `read ${link} tonight`), "alice to get the link");
    expect(received(alice, `read ${link} tonight`)!.preview).toEqual(preview);
    // Alice's device never contacts the site.
    expect(site.hits.length).toBe(hits);

    // A preview must be for a link in the text, and its picture must be inline.
    const fake: LinkPreview = { ...preview, url: "https://bank.example/login" };
    session.sendMessage(`user:${aliceId}`, { text: `also ${link}`, preview: fake });
    session.sendMessage(`user:${aliceId}`, { text: `and ${link}`, preview: { ...preview, image: { data: "https://tracker.example/pixel.png", width: 1, height: 1 } } });
    await waitFor(() => !!received(alice, `and ${link}`), "alice to get the rest");
    expect(received(alice, `also ${link}`)!.preview).toBeNull();
    expect(received(alice, `and ${link}`)!.preview).toMatchObject({ title: "Ships & harbours", image: undefined });
  });

  it("waits for a preview still being made when a message goes, keeping the order", async () => {
    const link = `${site.url}/article#pasted`;
    const session = bob.client.session(bobFirst);
    session.sendMessage(`user:${alice.userId}`, { text: `just pasted ${link}` }, { previewUrl: link });
    session.sendMessage(`user:${alice.userId}`, { text: "and then this" });
    await waitFor(() => !!received(alice, "and then this"), "alice to get both");
    const pasted = received(alice, `just pasted ${link}`)!;
    expect(pasted.preview).toMatchObject({ url: link, title: "Ships & harbours" });
    expect(pasted.seq!).toBeLessThan(received(alice, "and then this")!.seq!);
    // Bob sees it on his own message as well.
    expect(received(bob, `just pasted ${link}`, bobFirst)!.preview).toMatchObject({ url: link });
  });

  it("keeps a preview through an edit while its link stays", async () => {
    const link = `${site.url}/article`;
    const original = received(alice, `read ${link} tonight`)!;
    const session = bob.client.session(bobFirst);
    session.editMessage(original.groupId, original.id, `read ${link} tomorrow`, {}, []);
    await waitFor(() => received(alice, `read ${link} tomorrow`)?.preview?.title === "Ships & harbours", "the edit with its preview");
    session.editMessage(original.groupId, original.id, "never mind", {}, []);
    await waitFor(() => !!received(alice, "never mind"), "the edit without the link");
    expect(received(alice, "never mind")!.preview).toBeNull();
  });

  it("forwards a message with its preview", async () => {
    const link = `${site.url}/article`;
    const preview = (await bob.client.linkPreview(link))!;
    const session = bob.client.session(bobFirst);
    const sent = session.sendMessage(`user:${alice.userId}`, { text: link, preview });
    await waitFor(() => received(bob, link, bobFirst)?.seq != null, "bob's link to arrive");
    const carolId = carol.client.session(carolFirst).getSelf().userId;
    await bob.client.forwardMessages(bobFirst, received(bob, link, bobFirst)!.groupId, [sent.id], bobFirst, `user:${carolId}`);
    await waitFor(() => !!received(carol, link, carolFirst), "carol to get the forwarded link");
    expect(received(carol, link, carolFirst)).toMatchObject({ preview, forwarded: { userId: bob.client.session(bobFirst).getSelf().userId } });
  });
});
