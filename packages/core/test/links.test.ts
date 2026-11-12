// Link previews as the sender's device makes them, against a stand-in for the web, and what a
// received one is held to.

import { describe, expect, it } from "vitest";
import { checkPreview, findLink, linkHost, linkInText, makeLinkPreview, makeVideoPreview, previewable, readPage, sharedLinks, type WebAdapter } from "../src/links";

const SHRUNK = { data: "data:image/jpeg;base64,AAAA", width: 10, height: 10 };
const encode = (text: string) => new TextEncoder().encode(text);

/** A web of a few addresses, recording what was fetched. */
function web(pages: Record<string, { type: string; body: Uint8Array | string; url?: string } | Error>, shrink: (body: Uint8Array) => typeof SHRUNK | null = () => SHRUNK): WebAdapter & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    async fetch(url) {
      fetched.push(url);
      const page = pages[url];
      if (!page) throw new Error(`nothing at ${url}`);
      if (page instanceof Error) throw page;
      return { url: page.url ?? url, type: page.type, body: typeof page.body === "string" ? encode(page.body) : page.body };
    },
    async shrinkImage(body) {
      return shrink(body);
    },
  };
}

describe("which links may be fetched", () => {
  it("allows public HTTPS on the usual port only", () => {
    expect(previewable("https://example.com/a")).toBe(true);
    for (const url of ["http://example.com", "https://example.com:8443", "https://user:pw@example.com", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]/", "https://[fd00::1]/", "https://printer.local", "not a link"]) {
      expect(previewable(url), url).toBe(false);
    }
    expect(previewable("https://[2001:db8::1]/")).toBe(false);
    expect(previewable("https://[2606:4700::1111]/")).toBe(true);
  });

  it("finds the links a message shares, outside code and spoilers", () => {
    const text = "see https://a.example/x and `https://b.example` ||https://c.example|| ```\nhttps://d.example\n```";
    expect(sharedLinks(text)).toEqual(["https://a.example/x"]);
    expect(findLink(text)).toBe("https://a.example/x");
    expect(findLink("nothing here")).toBeNull();
    expect(linkInText("https://a.example/x", text)).toBe(true);
    expect(linkInText("https://a.example", text)).toBe(false);
    expect(linkHost("https://www.example.com/page")).toBe("example.com");
    expect(linkHost("not a link")).toBe("");
  });
});

describe("making a preview", () => {
  it("reads a page's tags and fetches its picture", async () => {
    const html = `<html><head><title>Fallback &amp; title</title>
      <meta property="og:title" content="The &quot;title&quot;"><meta property="og:title" content="second">
      <meta name="description" content="  lots   of   space  "><meta property="og:site_name" content="Site">
      <meta property="og:image" content="/pic.png"></head><body>`;
    const fake = web({ "https://example.com/a": { type: "text/html; charset=utf-8", body: html }, "https://example.com/pic.png": { type: "image/png", body: "png" } });
    expect(await makeLinkPreview(fake, "https://example.com/a")).toEqual({ url: "https://example.com/a", title: 'The "title"', description: "lots of space", siteName: "Site", image: SHRUNK });
  });

  it("takes the title from the page's title tag, and the site from the address, when the tags say neither", async () => {
    const html = "<head><title>Caf&#233; &#x2615; &bogus; &#0;</title></head>";
    const fake = web({ "https://www.example.com/": { type: "text/html", body: html } });
    expect(await makeLinkPreview(fake, "https://www.example.com/")).toEqual({ url: "https://www.example.com/", title: "Café ☕ &bogus; &#0;", description: undefined, siteName: "example.com", image: undefined });
  });

  it("reads a page in the character set it says, in its headers or itself, or as UTF-8", async () => {
    const latin1 = new Uint8Array([...encode('<head><meta charset="iso-8859-1"><title>Caf'), 0xe9, ...encode("</title></head>")]);
    expect((await makeLinkPreview(web({ "https://example.com/": { type: "text/html", body: latin1 } }), "https://example.com/"))?.title).toBe("Café");
    const unknown = encode('<head><title>Plain</title></head>');
    expect((await makeLinkPreview(web({ "https://example.com/": { type: "text/html; charset=made-up", body: unknown } }), "https://example.com/"))?.title).toBe("Plain");
  });

  it("makes nothing of a page that says nothing, isn't a page, or can't be fetched", async () => {
    expect(await makeLinkPreview(web({ "https://example.com/": { type: "text/html", body: "<body>hi</body>" } }), "https://example.com/")).toBeNull();
    expect(await makeLinkPreview(web({ "https://example.com/": { type: "application/pdf", body: "%PDF" } }), "https://example.com/")).toBeNull();
    expect(await makeLinkPreview(web({}), "http://example.com/")).toBeNull();
    await expect(makeLinkPreview(web({ "https://example.com/": new Error("down") }), "https://example.com/")).rejects.toThrow("down");
  });

  it("leaves out a picture it can't get, or one somewhere it mustn't go", async () => {
    const page = (image: string) => `<head><meta property="og:title" content="T"><meta property="og:image" content="${image}"></head>`;
    for (const [image, pages] of [
      ["https://10.0.0.1/pic.png", {}],
      ["https://example.com/text", { "https://example.com/text": { type: "text/plain", body: "x" } }],
      ["https://example.com/broken", { "https://example.com/broken": new Error("gone") }],
      ["http://[bad", {}],
    ] as const) {
      const fake = web({ "https://example.com/": { type: "text/html", body: page(image) }, ...pages });
      expect((await makeLinkPreview(fake, "https://example.com/"))?.image, image).toBeUndefined();
    }
    const unshrinkable = web({ "https://example.com/": { type: "text/html", body: page("https://example.com/p.png") }, "https://example.com/p.png": { type: "image/png", body: "p" } }, () => null);
    expect((await makeLinkPreview(unshrinkable, "https://example.com/"))?.image).toBeUndefined();
  });

  it("shows a link straight to a picture as that picture, fetching it again if it was cut off", async () => {
    const fake = web({ "https://example.com/p.png": { type: "image/png", body: "png" } });
    expect(await makeLinkPreview(fake, "https://example.com/p.png")).toEqual({ url: "https://example.com/p.png", siteName: "example.com", image: SHRUNK });
    const big = new Uint8Array(2 << 20);
    const cut = web({ "https://example.com/big.png": { type: "image/png", body: big } });
    expect(await makeLinkPreview(cut, "https://example.com/big.png")).toEqual({ url: "https://example.com/big.png", siteName: "example.com", image: SHRUNK });
    expect(cut.fetched).toEqual(["https://example.com/big.png", "https://example.com/big.png"]);
    expect(await makeLinkPreview(web({ "https://example.com/p.png": { type: "image/png", body: "png" } }, () => null), "https://example.com/p.png")).toBeNull();
  });
});

describe("a video's preview", () => {
  const page = (image = "") =>
    `<head><meta property="og:title" content="A video">${image}</head><body><span itemprop="author"><link itemprop="url" href="x"><link itemprop="name" content="Its maker"></span></body>`;

  it("takes the title, who made it and YouTube's picture of it", async () => {
    const fake = web({ "https://www.youtube.com/watch?v=abc": { type: "text/html", body: page() }, "https://i.ytimg.com/vi/abc/hqdefault.jpg": { type: "image/jpeg", body: "jpg" } });
    expect(await makeVideoPreview(fake, "abc")).toEqual({ title: "A video", author: "Its maker", image: SHRUNK });
  });

  it("does without what it can't get", async () => {
    expect(await makeVideoPreview(web({ "https://www.youtube.com/watch?v=abc": { type: "application/json", body: "{}" } }), "abc")).toEqual({});
    const noAuthor = web({ "https://www.youtube.com/watch?v=abc": { type: "text/html", body: '<head><meta property="og:image" content="https://10.0.0.1/x.jpg"></head><span itemprop="author"></span>' } });
    expect(await makeVideoPreview(noAuthor, "abc")).toEqual({ title: undefined, author: undefined, image: undefined });
    const failing = web({ "https://www.youtube.com/watch?v=abc": { type: "text/html", body: page() }, "https://i.ytimg.com/vi/abc/hqdefault.jpg": { type: "text/html", body: "no" } });
    expect((await makeVideoPreview(failing, "abc")).image).toBeUndefined();
  });
});

describe("a received preview", () => {
  const text = "look at https://example.com/a";
  it("holds to a link in the message, with plain text and a small picture", () => {
    expect(checkPreview({ url: "https://example.com/a", title: "  T  ", description: 5, siteName: "S", image: SHRUNK }, text)).toEqual({ url: "https://example.com/a", title: "T", description: undefined, siteName: "S", image: SHRUNK });
    expect(checkPreview({ url: "https://example.com/a", image: { data: "https://evil.example/x.png", width: 1, height: 1 } }, text)?.image).toBeUndefined();
    expect(checkPreview({ url: "https://example.com/a", image: { ...SHRUNK, width: 0 } }, text)?.image).toBeUndefined();
    for (const preview of [null, "preview", { url: 5 }, { url: "javascript:x" }, { url: "https://elsewhere.example" }]) expect(checkPreview(preview, text)).toBeNull();
  });

  it("reads a page's tags even without a head, and a title past many tags", () => {
    expect(readPage('<meta name="twitter:title" content="Tw"><meta name="twitter:image" content="::bad::url">', "not a base")).toEqual({ title: "Tw", description: undefined, siteName: undefined, image: undefined });
    expect(readPage(`<title>${"x".repeat(300)}</title>`, "https://example.com/").title).toHaveLength(200);
  });
});
