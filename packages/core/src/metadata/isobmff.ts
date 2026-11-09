// HEIF and AVIF pictures, and MP4 and QuickTime films: their metadata emptied in place, and
// when they were made zeroed.

import { unreadable, check, ascii, asciiBytes, Reader, Output, Patches, orientationIn, orientationTiff, concat, u32be } from "./bytes";

// --- HEIF, MP4 and QuickTime ---

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif", "avis"]);
/** How a QuickTime file with no type box can start. */
export const QUICKTIME_FIRST = new Set(["moov", "mdat", "wide", "free", "skip"]);

/** A HEIF or AVIF picture names itself by brand in its first box. */
export function isHeif(head: Uint8Array): boolean {
  const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
  for (let at = 8; at + 4 <= Math.min(size, head.length); at += at === 8 ? 8 : 4) {
    if (HEIF_BRANDS.has(ascii(head, at, 4))) return true;
  }
  return false;
}

interface Box {
  type: string;
  at: number;
  /** After the size and type, where a box turned into padding starts being zeros. */
  body: number;
  /** Where its contents start. */
  payload: number;
  end: number;
}

async function boxAt(reader: Reader, at: number, limit: number): Promise<Box> {
  let size = await reader.u32(at);
  const type = ascii(await reader.bytes(at + 4, 4), 0, 4);
  let body = at + 8;
  if (size === 1) {
    size = await reader.u64(at + 8);
    body = at + 16;
  } else if (size === 0) {
    size = limit - at;
  }
  check(size >= body - at && at + size <= limit);
  return { type, at, body, payload: type === "uuid" ? body + 16 : body, end: at + size };
}

async function boxesIn(reader: Reader, from: number, to: number): Promise<Box[]> {
  const boxes: Box[] = [];
  for (let at = from; at + 8 <= to; ) {
    const box = await boxAt(reader, at, to);
    boxes.push(box);
    at = box.end;
  }
  return boxes;
}

/** Turns a box into padding, which every reader skips: its name says so and it holds only zeros. */
function blank(patches: Patches, box: Box): void {
  patches.write(box.at + 4, asciiBytes("free"));
  patches.zero(box.body, box.end - box.body);
}

/** Padding is kept, but emptied, since programs that edit a file in place leave old metadata in it. */
const PADDING = new Set(["free", "skip"]);

/** What a picture or a film needs to be read. Anything else at the top of the file is emptied. */
const TOP_KEPT = new Set(["ftyp", "mdat", "moov", "moof", "mfra", "sidx", "ssix", "styp", "prft", "emsg", "pdin", "wide"]);

export async function isobmff(reader: Reader, kind: "image" | "video"): Promise<Output> {
  const patches = new Patches();
  for (const box of await boxesIn(reader, 0, reader.size)) {
    if (box.type === "moov") await movie(reader, patches, box);
    else if (box.type === "meta" && kind === "image") await heifItems(reader, patches, box);
    else if (PADDING.has(box.type)) patches.zero(box.body, box.end - box.body);
    else if (!TOP_KEPT.has(box.type)) blank(patches, box);
  }
  return patches.output(reader.size);
}

/** When a film, a track and its media were made and changed: zero, as many programs leave them. */
async function zeroTimes(reader: Reader, patches: Patches, box: Box): Promise<void> {
  const version = await reader.u8(box.payload);
  patches.zero(box.payload + 4, version === 1 ? 16 : 8);
}

async function movie(reader: Reader, patches: Patches, moov: Box): Promise<void> {
  const children = await boxesIn(reader, moov.payload, moov.end);
  // A fragmented film's samples are described outside its tracks, so none can be taken out.
  const fragmented = children.some((child) => child.type === "mvex");
  for (const child of children) {
    if (child.type === "mvhd") await zeroTimes(reader, patches, child);
    else if (child.type === "trak") await track(reader, patches, child, fragmented);
    else if (child.type === "udta" || child.type === "meta" || child.type === "uuid") blank(patches, child);
    else if (PADDING.has(child.type)) patches.zero(child.body, child.end - child.body);
  }
}

async function track(reader: Reader, patches: Patches, trak: Box, fragmented: boolean): Promise<void> {
  const children = await boxesIn(reader, trak.payload, trak.end);
  const mdia = children.find((child) => child.type === "mdia");
  const mediaBoxes = mdia ? await boxesIn(reader, mdia.payload, mdia.end) : [];
  const hdlr = mediaBoxes.find((child) => child.type === "hdlr");
  const handler = hdlr && hdlr.payload + 12 <= hdlr.end ? ascii(await reader.bytes(hdlr.payload + 8, 4), 0, 4) : "";
  if (handler === "meta" && !fragmented) {
    // A track of timed metadata, where cameras put where they were each moment.
    try {
      for (const [from, to] of await samplesOf(reader, mediaBoxes)) patches.zero(from, to - from);
    } catch (error) {
      if (!unreadable(error)) throw error;
    }
    blank(patches, trak);
    return;
  }
  for (const child of children) {
    if (child.type === "tkhd") await zeroTimes(reader, patches, child);
    else if (child.type === "udta" || child.type === "meta") blank(patches, child);
    else if (PADDING.has(child.type)) patches.zero(child.body, child.end - child.body);
  }
  for (const child of mediaBoxes) {
    if (child.type === "mdhd") await zeroTimes(reader, patches, child);
    else if (child.type === "udta" || child.type === "meta") blank(patches, child);
  }
}

const TABLE_LIMIT = 64 << 20;

/** Where a track's samples are in the file, chunk by chunk. */
async function samplesOf(reader: Reader, mediaBoxes: Box[]): Promise<[number, number][]> {
  const minf = mediaBoxes.find((box) => box.type === "minf");
  check(!!minf);
  const stbl = (await boxesIn(reader, minf.payload, minf.end)).find((box) => box.type === "stbl");
  check(!!stbl);
  const tables = await boxesIn(reader, stbl.payload, stbl.end);
  const table = async (type: string) => {
    const box = tables.find((item) => item.type === type);
    if (!box) return null;
    check(box.end - box.payload <= TABLE_LIMIT);
    const bytes = await reader.bytes(box.payload, box.end - box.payload);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const stsc = await table("stsc");
  const stsz = await table("stsz");
  const stco = await table("stco");
  const co64 = await table("co64");
  check(!!stsc && !!stsz && (!!stco || !!co64));

  const offsets: number[] = [];
  if (stco) for (let i = 0; i < stco.getUint32(4); i++) offsets.push(stco.getUint32(8 + i * 4));
  else for (let i = 0; i < co64!.getUint32(4); i++) offsets.push(Number(co64!.getBigUint64(8 + i * 8)));
  const runs: { first: number; samples: number }[] = [];
  for (let i = 0; i < stsc.getUint32(4); i++) runs.push({ first: stsc.getUint32(8 + i * 12), samples: stsc.getUint32(12 + i * 12) });
  const fixedSize = stsz.getUint32(4);
  const sampleCount = stsz.getUint32(8);
  const sizeOf = (sample: number) => (fixedSize || stsz.getUint32(12 + sample * 4));

  const ranges: [number, number][] = [];
  let sample = 0;
  let run = 0;
  for (let chunk = 0; chunk < offsets.length && sample < sampleCount; chunk++) {
    while (run + 1 < runs.length && runs[run + 1]!.first <= chunk + 1) run++;
    let length = 0;
    for (let i = 0; i < (runs[run]?.samples ?? 0) && sample < sampleCount; i++) length += sizeOf(sample++);
    const from = offsets[chunk]!;
    check(from + length <= reader.size);
    ranges.push([from, from + length]);
  }
  return ranges;
}

const META_LIMIT = 16 << 20;
const XMP_TYPES = new Set(["application/rdf+xml", "application/xmp+xml", "text/xml", "application/xml"]);

/** A HEIF picture keeps its Exif and XMP as items of their own: they're written over in place. */
async function heifItems(reader: Reader, patches: Patches, meta: Box): Promise<void> {
  check(meta.end - meta.at <= META_LIMIT);
  const bytes = await reader.bytes(meta.at, meta.end - meta.at);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = meta.at;
  const childrenOf = (from: number, to: number) => {
    const found: { type: string; payload: number; end: number }[] = [];
    for (let at = from; at + 8 <= to; ) {
      const size = view.getUint32(at);
      check(size >= 8 && at + size <= to);
      found.push({ type: ascii(bytes, at + 4, 4), payload: at + 8, end: at + size });
      at += size;
    }
    return found;
  };
  // The meta box carries a version and flags before what it holds.
  const children = childrenOf(meta.payload - base + 4, meta.end - base);
  const iinf = children.find((child) => child.type === "iinf");
  const iloc = children.find((child) => child.type === "iloc");
  const idat = children.find((child) => child.type === "idat");
  if (!iinf || !iloc) return;

  const cstring = (at: number, end: number): [string, number] => {
    let stop = at;
    while (stop < end && bytes[stop] !== 0) stop++;
    return [ascii(bytes, at, stop - at), stop + 1];
  };
  const metadata = new Map<number, "exif" | "xmp">();
  const infeFrom = iinf.payload + 4 + (bytes[iinf.payload] === 0 ? 2 : 4);
  for (const infe of childrenOf(infeFrom, iinf.end)) {
    if (infe.type !== "infe") continue;
    const version = bytes[infe.payload]!;
    let at = infe.payload + 4;
    if (version >= 2) {
      const id = version === 2 ? view.getUint16(at) : view.getUint32(at);
      at += (version === 2 ? 2 : 4) + 2;
      const type = ascii(bytes, at, 4);
      const [, afterName] = cstring(at + 4, infe.end);
      if (type === "Exif") metadata.set(id, "exif");
      else if (type === "mime" && XMP_TYPES.has(cstring(afterName, infe.end)[0])) metadata.set(id, "xmp");
    } else {
      const id = view.getUint16(at);
      const [, afterName] = cstring(at + 4, infe.end);
      if (XMP_TYPES.has(cstring(afterName, infe.end)[0])) metadata.set(id, "xmp");
    }
  }
  if (metadata.size === 0) return;

  const version = bytes[iloc.payload]!;
  const sizes = bytes[iloc.payload + 4]!;
  const more = bytes[iloc.payload + 5]!;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 15;
  const baseSize = more >> 4;
  const indexSize = version === 1 || version === 2 ? more & 15 : 0;
  let at = iloc.payload + 6;
  const uint = (size: number) => {
    check(size === 0 || size === 4 || size === 8);
    check(at + size <= iloc.end);
    const value = size === 4 ? view.getUint32(at) : size === 8 ? Number(view.getBigUint64(at)) : 0;
    at += size;
    return value;
  };
  const count = version < 2 ? view.getUint16(at) : view.getUint32(at);
  at += version < 2 ? 2 : 4;
  for (let item = 0; item < count; item++) {
    check(at + 2 <= iloc.end);
    const id = version < 2 ? view.getUint16(at) : view.getUint32(at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version === 1 || version === 2) {
      method = view.getUint16(at) & 15;
      at += 2;
    }
    const reference = view.getUint16(at);
    at += 2;
    const baseOffset = uint(baseSize);
    const extentCount = view.getUint16(at);
    at += 2;
    const extents: [number, number][] = [];
    for (let i = 0; i < extentCount; i++) {
      if (indexSize) uint(indexSize);
      const offset = uint(offsetSize);
      const length = uint(lengthSize);
      extents.push([offset, length]);
    }
    const kind = metadata.get(id);
    // Only what's in this file, and in a place it says.
    if (!kind || reference !== 0 || (method !== 0 && method !== 1) || (method === 1 && !idat)) continue;
    const origin = method === 0 ? 0 : base + idat!.payload;
    const spans = extents.map(([offset, length]): [number, number] => [origin + baseOffset + offset, length]);
    if (spans.some(([from, length]) => length === 0 || from + length > reader.size)) continue;
    const total = spans.reduce((sum, [, length]) => sum + length, 0);
    let replacement: Uint8Array;
    if (kind === "exif") {
      const data = concat(...(await Promise.all(spans.map(([from, length]) => reader.bytes(from, length).then((part) => part.slice())))));
      const header = data.length >= 4 ? new DataView(data.buffer).getUint32(0) : 0;
      const orientation = 4 + header <= data.length ? orientationIn(data.subarray(4 + header)) : 1;
      replacement = concat(u32be(0), orientationTiff(orientation));
    } else {
      replacement = asciiBytes('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
      const end = asciiBytes('<?xpacket end="w"?>');
      replacement = replacement.length + end.length <= total ? concat(replacement, new Uint8Array(total - replacement.length - end.length).fill(0x20), end) : new Uint8Array(total).fill(0x20);
    }
    let written = 0;
    for (const [from, length] of spans) {
      const part = new Uint8Array(length);
      part.set(replacement.subarray(written, written + length));
      patches.write(from, part);
      written += length;
    }
  }
}
