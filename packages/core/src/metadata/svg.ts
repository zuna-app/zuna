// SVG drawings: comments, metadata and what drawing programs keep for themselves taken out,
// and pictures drawn into them cleaned as files of their own.

import { cleanBytes } from "../metadata";
import { Unreadable, check, Reader, Output } from "./bytes";

// --- SVG ---

/** What drawing programs keep for themselves: layer names, file paths, settings and private copies of the drawing. */
const EDITOR_NAMESPACES = [
  "http://www.inkscape.org/namespaces/inkscape",
  "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  "http://www.bohemiancoding.com/sketch/ns",
  "http://www.serif.com/",
  "http://www.corel.com/coreldraw/odm/2003",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://purl.org/dc/elements/1.1/",
  "http://creativecommons.org/ns#",
  "http://web.resource.org/cc/",
  "adobe:ns:meta/",
];
const isEditorNamespace = (uri: string) => EDITOR_NAMESPACES.includes(uri) || uri.startsWith("http://ns.adobe.com/");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Comments, metadata, and whatever drawing programs add for themselves go. The drawing stays as written. */
export async function svg(reader: Reader): Promise<Output | null> {
  const original = await reader.bytes(0, reader.size);
  const text = decoder.decode(original);
  // Only text that reads back to the same bytes, so nothing else in it changes.
  const back = encoder.encode(text);
  const bom = original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf ? 3 : 0;
  if (back.length + bom !== original.length || !back.every((byte, index) => byte === original[index + bom]) || !text.includes("<svg")) return null;
  const cleaned = await cleanSvg(text);
  const out = new Output();
  if (bom) out.copy(0, 3);
  out.bytes(encoder.encode(cleaned));
  return out;
}

const DATA_PICTURE = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]*)$/;

async function cleanSvg(text: string): Promise<string> {
  // Which prefixes stand for editors' namespaces. Illustrator spells them with entities.
  const entities = new Map<string, string>();
  for (const match of text.matchAll(/<!ENTITY\s+([\w.-]+)\s+(["'])(.*?)\2\s*>/g)) entities.set(match[1]!, match[3]!);
  const editorPrefixes = new Set<string>();
  for (const match of text.matchAll(/xmlns:([\w.-]+)\s*=\s*(["'])(.*?)\2/g)) {
    const uri = match[3]!.replace(/&([\w.-]+);/g, (whole, name: string) => entities.get(name) ?? whole);
    if (isEditorNamespace(uri)) editorPrefixes.add(match[1]!);
  }
  const prefixOf = (name: string) => (name.includes(":") ? name.slice(0, name.indexOf(":")) : "");
  const dropsElement = (name: string) => name === "metadata" || name === "svg:metadata" || editorPrefixes.has(prefixOf(name));

  const parts: string[] = [];
  let skipping = 0;
  let at = 0;
  const find = (needle: string, from: number) => {
    const found = text.indexOf(needle, from);
    check(found !== -1);
    return found;
  };
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      if (!skipping) parts.push(text.slice(at));
      break;
    }
    if (!skipping) parts.push(text.slice(at, open));
    if (text.startsWith("<!--", open)) {
      at = find("-->", open + 4) + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      at = find("]]>", open + 9) + 3;
      if (!skipping) parts.push(text.slice(open, at));
    } else if (text.startsWith("<?", open)) {
      at = find("?>", open + 2) + 2;
      if (!skipping) parts.push(text.slice(open, at));
    } else if (text.startsWith("<!", open)) {
      at = afterDeclaration(text, open);
      if (!skipping) parts.push(text.slice(open, at));
    } else if (text.startsWith("</", open)) {
      at = find(">", open) + 1;
      if (skipping) skipping--;
      else parts.push(text.slice(open, at));
    } else {
      const tag = startTag(text, open);
      at = tag.end;
      if (skipping) {
        if (!tag.selfClosing) skipping++;
      } else if (dropsElement(tag.name)) {
        if (!tag.selfClosing) skipping = 1;
      } else {
        parts.push(await cleanTag(text, tag, editorPrefixes));
      }
    }
  }
  check(skipping === 0);
  return parts.join("");
}

/** A doctype, with the declarations it may hold between brackets. */
function afterDeclaration(text: string, open: number): number {
  let quote = "";
  let depth = 0;
  for (let i = open + 2; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth++;
    else if (char === "]") depth--;
    else if (char === ">" && depth === 0) return i + 1;
  }
  throw new Unreadable();
}

interface Attribute {
  name: string;
  /** From the space before it to the end of its value. */
  from: number;
  to: number;
  value: string;
}

interface StartTag {
  name: string;
  open: number;
  end: number;
  selfClosing: boolean;
  attributes: Attribute[];
}

function startTag(text: string, open: number): StartTag {
  let i = open + 1;
  const nameStart = i;
  while (i < text.length && !/[\s/>]/.test(text[i]!)) i++;
  const name = text.slice(nameStart, i);
  check(name.length > 0);
  const attributes: Attribute[] = [];
  for (;;) {
    const from = i;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    check(i < text.length);
    if (text[i] === ">") return { name, open, end: i + 1, selfClosing: false, attributes };
    if (text.startsWith("/>", i)) return { name, open, end: i + 2, selfClosing: true, attributes };
    const attributeStart = i;
    while (i < text.length && !/[\s=/>]/.test(text[i]!)) i++;
    const attributeName = text.slice(attributeStart, i);
    check(attributeName.length > 0);
    while (i < text.length && /\s/.test(text[i]!)) i++;
    let value = "";
    if (text[i] === "=") {
      i++;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      const quote = text[i];
      check(quote === '"' || quote === "'");
      const close = text.indexOf(quote, i + 1);
      check(close !== -1);
      value = text.slice(i + 1, close);
      i = close + 1;
    }
    attributes.push({ name: attributeName, from, to: i, value });
  }
}

async function cleanTag(text: string, tag: StartTag, editorPrefixes: Set<string>): Promise<string> {
  const local = tag.name.slice(tag.name.indexOf(":") + 1);
  let result = "";
  let cursor = tag.open;
  for (const attribute of tag.attributes) {
    const prefix = attribute.name.includes(":") ? attribute.name.slice(0, attribute.name.indexOf(":")) : "";
    const isLink = attribute.name === "href" || attribute.name.endsWith(":href");
    const value = attribute.value.trim();
    // A picture on the sender's disk can't be shown to anyone else, and its path says whose disk it is.
    const localFile = isLink && (/^file:/i.test(value) || (local === "image" && !/^(data|https?):/i.test(value)));
    const picture = isLink && DATA_PICTURE.exec(value);
    if (editorPrefixes.has(prefix) || localFile) {
      result += text.slice(cursor, attribute.from);
      cursor = attribute.to;
    } else if (picture) {
      const cleaned = await cleanPicture(picture[1]!, picture[2]!);
      if (cleaned === null) continue;
      const quote = text[attribute.to - 1]!;
      result += text.slice(cursor, attribute.from) + text.slice(attribute.from, attribute.to).replace(/=[\s\S]*$/, `=${quote}${cleaned}${quote}`);
      cursor = attribute.to;
    }
  }
  return result + text.slice(cursor, tag.end);
}

/** A picture drawn into the drawing, without its own metadata. */
async function cleanPicture(mime: string, base64: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64.replace(/\s/g, "")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  const cleaned = await cleanBytes(bytes, mime);
  if (cleaned.length === bytes.length && cleaned.every((byte, index) => byte === bytes[index])) return null;
  let binary = "";
  for (let i = 0; i < cleaned.length; i += 0x8000) binary += String.fromCharCode(...cleaned.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
