// Link previews, made on the sender's device. It fetches the page and sends
// what it found, encrypted inside the message: recipients never contact the
// site, and the server never sees the link. The site sees the sender's
// address, as it would if they opened the link.

import type { LinkPreview } from "./types";

/** How the device fetches pages and pictures for previews, and shrinks pictures. */
export interface WebAdapter {
  /** Fetches a public page or picture without cookies, keeping at most `maxBytes`. `url` is where it ended up after redirects. */
  fetch(url: string, maxBytes: number): Promise<{ url: string; type: string; body: Uint8Array }>;
  /** Shrinks a picture to fit within `maxSize` pixels, as a JPEG data URL, or null if it can't be read. */
  shrinkImage(body: Uint8Array, maxSize: number): Promise<{ data: string; width: number; height: number } | null>;
}

const PAGE_BYTES = 512 << 10;
const IMAGE_BYTES = 5 << 20;
const IMAGE_SIZE = 600;
const TITLE_LENGTH = 200;
const DESCRIPTION_LENGTH = 400;
const SITE_LENGTH = 100;

// The same links the message text shows as links, on the desktop (lib/markup.tsx) and the phone (Markup.swift).
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
const IMAGE_DATA = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Whether a link may be fetched: HTTPS, or plain HTTP on this machine, as for servers. */
export function previewable(url: string): boolean {
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.hostname.endsWith(".localhost");
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && local);
  } catch {
    return false;
  }
}

/** The first link in a message that can have a preview. Links in code and spoilers don't count. */
export function findLink(text: string): string | null {
  const visible = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\|\|[\s\S]*?\|\|/g, " ");
  for (const match of visible.matchAll(URL_PATTERN)) {
    if (previewable(match[0])) return match[0];
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function clean(value: string | undefined, max: number): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    found.set(match[1]!.toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return found;
}

/** What a page says about itself, from its Open Graph and other meta tags. */
export function readPage(html: string, pageUrl: string): { title?: string; description?: string; siteName?: string; image?: string } {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = end > 0 ? html.slice(0, end) : html;
  const meta = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = attributes(match[0]);
    const name = (tag.get("property") ?? tag.get("name"))?.toLowerCase();
    const content = tag.get("content");
    if (name && content && !meta.has(name)) meta.set(name, content);
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const first = (...names: string[]) => names.map((name) => meta.get(name)).find((value) => value?.trim());
  let image = first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  try {
    image = image ? new URL(image, pageUrl).toString() : undefined;
  } catch {
    image = undefined;
  }
  return {
    title: clean(first("og:title", "twitter:title") ?? (titleTag ? decodeEntities(titleTag) : undefined), TITLE_LENGTH),
    description: clean(first("og:description", "twitter:description", "description"), DESCRIPTION_LENGTH),
    siteName: clean(first("og:site_name", "application-name"), SITE_LENGTH),
    image,
  };
}

function charsetOf(type: string, body: Uint8Array): string {
  const declared = type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  if (declared) return declared;
  const start = String.fromCharCode(...body.subarray(0, 2048));
  return start.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? "utf-8";
}

function decodePage(type: string, body: Uint8Array): string {
  try {
    return new TextDecoder(charsetOf(type, body)).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

async function shrink(web: WebAdapter, url: string): Promise<LinkPreview["image"]> {
  if (!previewable(url)) return undefined;
  const picture = await web.fetch(url, IMAGE_BYTES);
  if (!picture.type.toLowerCase().startsWith("image/")) return undefined;
  return (await web.shrinkImage(picture.body, IMAGE_SIZE)) ?? undefined;
}

/** Fetches a link and makes its preview, or null if the page has nothing to show. */
export async function makeLinkPreview(web: WebAdapter, url: string): Promise<LinkPreview | null> {
  if (!previewable(url)) return null;
  const page = await web.fetch(url, PAGE_BYTES);
  const type = page.type.toLowerCase();
  const host = new URL(page.url).hostname.replace(/^www\./, "");
  if (type.startsWith("image/")) {
    const image = await shrink(web, url);
    return image ? { url, siteName: host, image } : null;
  }
  if (!type.includes("html")) return null;
  const found = readPage(decodePage(type, page.body), page.url);
  if (!found.title && !found.description) return null;
  const image = found.image ? await shrink(web, found.image).catch(() => undefined) : undefined;
  return { url, title: found.title, description: found.description, siteName: found.siteName ?? host, image };
}

/**
 * A received preview, if it holds up. It must be for a link in the message's
 * own text, so a preview can't pass one site off as another, and anything
 * that isn't plain text or a small inline picture is dropped.
 */
export function checkPreview(preview: unknown, text: string): LinkPreview | null {
  if (!preview || typeof preview !== "object") return null;
  const { url, title, description, siteName, image } = preview as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !text.includes(url)) return null;
  const textOf = (value: unknown, max: number) => (typeof value === "string" ? clean(value, max) : undefined);
  const picture = image as Record<string, unknown> | undefined;
  const validImage =
    picture &&
    typeof picture.data === "string" &&
    IMAGE_DATA.test(picture.data) &&
    typeof picture.width === "number" &&
    typeof picture.height === "number" &&
    picture.width > 0 &&
    picture.height > 0;
  return {
    url,
    title: textOf(title, TITLE_LENGTH),
    description: textOf(description, DESCRIPTION_LENGTH),
    siteName: textOf(siteName, SITE_LENGTH),
    image: validImage ? { data: picture.data as string, width: picture.width as number, height: picture.height as number } : undefined,
  };
}
