// Link previews, made on the sender's device. It fetches the page and sends
// what it found, encrypted inside the message: recipients never contact the
// site, and the server never sees the link. The site sees the sender's
// address, as it would if they opened the link.

import { plainName } from "./hidden";
import type { LinkPreview } from "./types";

/** How the device fetches pages and pictures for previews, and shrinks pictures. */
export interface WebAdapter {
  /** Fetches a public page or picture without cookies, keeping at most `maxBytes`. `url` is where it ended up after redirects. */
  fetch(url: string, maxBytes: number): Promise<{ url: string; type: string; body: Uint8Array }>;
  /** Shrinks a picture to fit within `maxSize` pixels, as a JPEG data URL, or null if it can't be read. */
  shrinkImage(body: Uint8Array, maxSize: number): Promise<{ data: string; width: number; height: number } | null>;
}

// Some pages, YouTube's among them, put their meta tags most of a megabyte in.
const PAGE_BYTES = 2 << 20;
const IMAGE_BYTES = 5 << 20;
const IMAGE_SIZE = 600;
const TITLE_LENGTH = 200;
const DESCRIPTION_LENGTH = 400;
const SITE_LENGTH = 100;
const MAX_TAG_LENGTH = 256 << 10;

// The same links the message text shows as links, on the desktop (lib/markup.tsx) and the phone (Markup.swift).
// Brackets that pair up stay in a link, as in Wikipedia's addresses; one around it doesn't.
const URL_PATTERN = /\bhttps?:\/\/(?:[^\s<>"'()]|\([^\s<>"'()]*\))*(?:[^\s<>"'.,;:!?()\]}]|\([^\s<>"'()]*\))/gi;
const IMAGE_DATA = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

let localLinksAllowed = false;

/**
 * Lets previews reach this machine, for development and tests only. A released
 * app never does this: a page could otherwise redirect it to a local service, and
 * what it found would go into the message.
 */
export function allowLocalLinks(allowed: boolean): void {
  localLinksAllowed = allowed;
}

function privateIpv4(host: string): boolean {
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** An IPv6 address as its 16 bytes, or null if it isn't one. It can be written many ways, so its text says little. */
function ipv6Bytes(address: string): Uint8Array | null {
  let text = address.toLowerCase();
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    if (Math.max(a, b, c, d) > 255) return null;
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<string>(missing).fill("0"), ...tail];
  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    bytes[index * 2] = parseInt(group, 16) >> 8;
    bytes[index * 2 + 1] = parseInt(group, 16) & 255;
  }
  return bytes;
}

function inRange(bytes: Uint8Array, network: string, bits: number): boolean {
  const start = ipv6Bytes(network)!;
  for (let index = 0; index < 16; index++) {
    const used = Math.min(Math.max(bits - index * 8, 0), 8);
    const mask = (0xff << (8 - used)) & 0xff;
    if ((bytes[index]! & mask) !== (start[index]! & mask)) return false;
  }
  return true;
}

// Besides this machine and private networks: documentation, and the ways of carrying
// IPv4 inside IPv6, which can lead anywhere in IPv4 with none of the checks on it.
const PRIVATE_IPV6: readonly (readonly [string, number])[] = [
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

function privateIpv6(host: string): boolean {
  const bytes = ipv6Bytes(host);
  if (!bytes) return true;
  if (inRange(bytes, "::ffff:0:0", 96)) return privateIpv4([...bytes.subarray(12)].join("."));
  return PRIVATE_IPV6.some(([network, bits]) => inRange(bytes, network, bits));
}

/** Whether an address, as a resolver gives it, is on this machine or a private network. */
export function privateAddress(address: string): boolean {
  return address.includes(":") ? privateIpv6(address) : privateIpv4(address);
}

/** Names that only mean something on this machine or its network. */
function localName(host: string): boolean {
  const name = host.replace(/\.$/, "").toLowerCase();
  return !name.includes(".") || /\.(?:localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/.test(name);
}

/**
 * Whether a link may be fetched for a preview: HTTPS to somewhere public, on the
 * usual port. Pages can redirect anywhere, so this is checked again for every address
 * along the way. They could otherwise have someone's device look for open ports.
 */
export function previewable(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (localLinksAllowed) {
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");
      if (local) return parsed.protocol === "https:" || parsed.protocol === "http:";
    }
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return false;
    if (host.startsWith("[")) return !privateIpv6(host.slice(1, -1));
    return !privateIpv4(host) && !localName(host);
  } catch {
    return false;
  }
}

/** The links in a text, written as the message's text shows them. */
function linksIn(text: string): string[] {
  return text.match(URL_PATTERN) ?? [];
}

/** Whether a link is one of those in a text, in full, not just the start of one. */
export function linkInText(url: string, text: string): boolean {
  return linksIn(text).includes(url);
}

/** The site a link really goes to, to show beside whatever its preview claims. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The links a message shares, leaving out those in code and spoilers. */
export function sharedLinks(text: string): string[] {
  const visible = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\|\|[\s\S]*?\|\|/g, " ");
  return linksIn(visible);
}

/** The first link in a message that can have a preview. Links in code and spoilers don't count. */
export function findLink(text: string): string | null {
  return sharedLinks(text).find(previewable) ?? null;
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
  // Without what would turn the text around it, or hide in it, as a name is shown.
  const text = (value === undefined ? undefined : plainName(value))?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  // A name always matches, value or not, so that a long one is only looked at once.
  for (const match of tag.matchAll(/([a-z:_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi)) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined) found.set(match[1]!.toLowerCase(), decodeEntities(value));
  }
  return found;
}

// Pages come from anyone, and the patterns that would find these in one expression
// take minutes on a page that's nothing but "<meta", so each search picks up where
// the last one ended.

/** The meta tags in a page's head. */
function metaTags(head: string, element = "meta"): string[] {
  const tags: string[] = [];
  const start = new RegExp(`<${element}\\b`, "gi");
  for (let match = start.exec(head); match; match = start.exec(head)) {
    const end = head.indexOf(">", match.index);
    if (end < 0) break;
    if (end - match.index <= MAX_TAG_LENGTH) tags.push(head.slice(match.index, end + 1));
    start.lastIndex = end + 1;
  }
  return tags;
}

/** What's in a page's first title tag. */
function titleIn(head: string): string | undefined {
  const open = head.search(/<title\b/i);
  const start = open < 0 ? -1 : head.indexOf(">", open);
  if (start < 0) return undefined;
  const text = head.slice(start + 1);
  const end = text.search(/<\/title>/i);
  return end < 0 ? undefined : text.slice(0, end);
}

/** What a page says about itself, from its Open Graph and other meta tags. */
export function readPage(html: string, pageUrl: string): { title?: string; description?: string; siteName?: string; image?: string } {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = end > 0 ? html.slice(0, end) : html;
  const meta = new Map<string, string>();
  for (const found of metaTags(head)) {
    const tag = attributes(found);
    const name = (tag.get("property") ?? tag.get("name"))?.toLowerCase();
    const content = tag.get("content");
    if (name && content && !meta.has(name)) meta.set(name, content);
  }
  const titleTag = titleIn(head);
  const first =(...names: string[]) => names.map((name) => meta.get(name)).find((value) => value?.trim());
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
    // A link straight to a picture already brought it, unless it was cut off at the page's limit.
    const image = page.body.length < PAGE_BYTES ? ((await web.shrinkImage(page.body, IMAGE_SIZE)) ?? undefined) : await shrink(web, page.url);
    return image ? { url, siteName: host, image } : null;
  }
  if (!type.includes("html")) return null;
  const found = readPage(decodePage(type, page.body), page.url);
  if (!found.title && !found.description) return null;
  const image = found.image ? await shrink(web, found.image).catch(() => undefined) : undefined;
  return { url, title: found.title, description: found.description, siteName: found.siteName ?? host, image };
}

// A video's picture travels inside what a room watches, so it's kept smaller than a link's.
const VIDEO_IMAGE_SIZE = 320;
const AUTHOR_LENGTH = 100;

/** Who made a YouTube video, as its page says just after `itemprop="author"`. */
function authorIn(html: string): string | undefined {
  const at = html.search(/itemprop\s*=\s*["']author["']/i);
  if (at < 0) return undefined;
  for (const found of metaTags(html.slice(at, at + 2048), "link")) {
    const tag = attributes(found);
    if (tag.get("itemprop")?.toLowerCase() === "name" && tag.get("content")) return clean(tag.get("content"), AUTHOR_LENGTH);
  }
  return undefined;
}

/**
 * A YouTube video's title, who made it and a small picture, from its page, for what a room
 * watches together. The device that puts the video on fetches them, as it would a link's
 * preview, so that the others can say what's on before they've touched YouTube.
 */
export async function makeVideoPreview(web: WebAdapter, id: string): Promise<{ title?: string; author?: string; image?: LinkPreview["image"] }> {
  const pageUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const page = await web.fetch(pageUrl, PAGE_BYTES);
  const type = page.type.toLowerCase();
  if (!type.includes("html")) return {};
  const html = decodePage(type, page.body);
  const found = readPage(html, page.url);
  // The picture YouTube makes for every video, if the page names none.
  const imageUrl = found.image ?? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  let image: LinkPreview["image"];
  if (previewable(imageUrl)) {
    const picture = await web.fetch(imageUrl, IMAGE_BYTES).catch(() => null);
    if (picture?.type.toLowerCase().startsWith("image/")) image = (await web.shrinkImage(picture.body, VIDEO_IMAGE_SIZE).catch(() => null)) ?? undefined;
  }
  return { title: found.title, author: authorIn(html), image };
}

/**
 * A received preview, if it holds up. It must be for a whole link in the
 * message's own text, and anything that isn't plain text or a small inline
 * picture is dropped. What it says about the page is the sender's claim, so the
 * apps show the link's real site beside it.
 */
const MAX_IMAGE_DATA = 256 << 10;
/** A picture's side, as validate.ts holds an attachment's: nothing depends on it but the layout. */
const sensibleSide = (value: unknown): boolean => typeof value === "number" && value > 0 && value <= 1 << 20;

export function checkPreview(preview: unknown, text: string): LinkPreview | null {
  if (!preview || typeof preview !== "object") return null;
  const { url, title, description, siteName, image } = preview as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !linkInText(url, text)) return null;
  const textOf = (value: unknown, max: number) => (typeof value === "string" ? clean(value, max) : undefined);
  const picture = image as Record<string, unknown> | undefined;
  // A small picture, as a thumbnail is: what the sender's device makes is far less than this.
  const validImage =
    picture &&
    typeof picture.data === "string" &&
    picture.data.length <= MAX_IMAGE_DATA &&
    IMAGE_DATA.test(picture.data) &&
    sensibleSide(picture.width) &&
    sensibleSide(picture.height);
  return {
    url,
    title: textOf(title, TITLE_LENGTH),
    description: textOf(description, DESCRIPTION_LENGTH),
    siteName: textOf(siteName, SITE_LENGTH),
    image: validImage ? { data: picture.data as string, width: picture.width as number, height: picture.height as number } : undefined,
  };
}
