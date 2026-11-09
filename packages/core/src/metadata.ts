// What a file says about where, when and on what it was made, taken out before
// it's sent: the location, the camera and its serial number, dates, the program
// and editing history. Pictures and videos keep every byte of what they show, so
// nothing is compressed again, and keep which way up they're meant to be seen and
// their colors. A file of another kind, or one that doesn't read as its kind
// should, is sent as it is.

import { unreadable, starts, ascii, Reader, Output } from "./metadata/bytes";
import { jpeg, png, gif, webp } from "./metadata/images";
import { QUICKTIME_FIRST, isHeif, isobmff } from "./metadata/isobmff";
import { matroska } from "./metadata/matroska";
import { svg } from "./metadata/svg";

export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

const VIDEO_NAMES = /\.(mp4|m4v|mov|3gp|3g2|webm|mkv)$/i;
const SVG_LIMIT = 32 << 20;

/** The file as it's sent: without its metadata when it's a kind this knows. */
export async function withoutMetadata(source: ByteSource, mime: string, name: string): Promise<ByteSource> {
  try {
    const reader = new Reader(source);
    const head = await reader.bytes(0, Math.min(source.size, 64));
    const video = mime.startsWith("video/") || VIDEO_NAMES.test(name);
    let out: Output | null = null;
    if (starts(head, [0xff, 0xd8, 0xff])) out = await jpeg(reader);
    else if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) out = await png(reader);
    else if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") out = await gif(reader);
    else if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") out = await webp(reader);
    else if (ascii(head, 4, 4) === "ftyp" && isHeif(head)) out = await isobmff(reader, "image");
    else if (video && (ascii(head, 4, 4) === "ftyp" || QUICKTIME_FIRST.has(ascii(head, 4, 4)))) out = await isobmff(reader, "video");
    else if (video && starts(head, [0x1a, 0x45, 0xdf, 0xa3])) out = await matroska(reader);
    else if ((mime === "image/svg+xml" || /\.svg$/i.test(name)) && source.size <= SVG_LIMIT) out = await svg(reader);
    return out ? out.over(source) : source;
  } catch (error) {
    if (unreadable(error)) return source;
    throw error;
  }
}

/** Takes the metadata out of a file held in memory, such as a picture inside a drawing. */
export async function cleanBytes(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  const cleaned = await withoutMetadata({ size: bytes.length, read: async (start, end) => bytes.subarray(start, end) }, mime, "");
  return cleaned.read(0, cleaned.size);
}
