// Metadata taken out of files built here byte by byte, in the shapes metadata.test.ts's fixtures
// don't have: boxes of 64 bits and to the file's end, timed metadata with 64-bit offsets, HEIF items
// of every version and in the meta box's own data, JPEG restarts, GIFs without a palette, WebP's
// Exif without its header, and drawings that are cut short or hold pictures that can't be read.

import { describe, expect, it } from "vitest";
import { withoutMetadata, type ByteSource } from "../src/metadata";
import { Output, Patches, Reader, Unreadable, orientationIn } from "../src/metadata/bytes";
import { isHeif } from "../src/metadata/isobmff";

type Part = number[] | Uint8Array | string;

/** Bytes from numbers, other bytes, and text as Latin-1. */
function bytes(...parts: Part[]): Uint8Array {
  const arrays = parts.map((part) => (typeof part === "string" ? Uint8Array.from(part, (char) => char.charCodeAt(0)) : Uint8Array.from(part)));
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of arrays) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const u16 = (n: number) => [n >> 8, n & 255];
const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n: number) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];
const le16 = (n: number) => [n & 255, n >> 8];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
const fill = (length: number, byte: number) => new Array<number>(length).fill(byte);

/** An ISO base media box. */
const box = (type: string, ...payload: Part[]) => {
  const body = bytes(...payload);
  return bytes(u32(8 + body.length), type, body);
};

/** Exif's TIFF, big-endian, saying which way up a picture is, and a camera's name it shouldn't keep. */
const tiff = (orientation: number) => bytes("MM", [0, 42], u32(8), u16(2), u16(0x0112), u16(3), u32(1), u16(orientation), [0, 0], u16(0x010f), u16(2), u32(4), "Cam\0", u32(0));

const memory = (data: Uint8Array): ByteSource => ({ size: data.length, read: async (start, end) => data.subarray(start, end) });

async function clean(data: Uint8Array, mime: string, name = ""): Promise<Uint8Array> {
  const cleaned = await withoutMetadata(memory(data), mime, name);
  return cleaned.read(0, cleaned.size);
}

const latin1 = (data: Uint8Array) => Buffer.from(data).toString("latin1");
const zeros = (data: Uint8Array, from: number, length: number) => data.subarray(from, from + length).every((byte) => byte === 0);

describe("the reader and the writer under every cleaner", () => {
  it("reads both byte orders, and refuses a read past the end", async () => {
    const reader = new Reader(memory(bytes([1, 2, 3, 4])));
    expect([await reader.u16(0), await reader.u16(0, true), await reader.u32(0, true)]).toEqual([0x0102, 0x0201, 0x04030201]);
    await expect(reader.bytes(2, 3)).rejects.toBeInstanceOf(Unreadable);
    // A source that gives less than it says it has can't be read either.
    const short = new Reader({ size: 10, read: async () => new Uint8Array(2) });
    await expect(short.bytes(0, 4)).rejects.toBeInstanceOf(Unreadable);
    await expect(new Reader(memory(bytes(fill(8, 255)))).u64(0)).rejects.toBeInstanceOf(Unreadable);
  });

  it("writes zeros inside zeros once, and refuses bytes written inside them", async () => {
    const patches = new Patches();
    patches.zero(2, 4);
    patches.zero(4, 4);
    patches.zero(5, 1);
    patches.zero(9, 0);
    const out = patches.output(10).over(memory(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
    expect([...(await out.read(0, 10))]).toEqual([1, 2, 0, 0, 0, 0, 0, 0, 9, 10]);
    // Past the end, nothing.
    expect([...(await out.read(12, 14))]).toEqual([0, 0]);
    const clash = new Patches();
    clash.zero(0, 4);
    clash.write(2, bytes([1]));
    expect(() => clash.output(10)).toThrow(Unreadable);
    const past = new Patches();
    past.zero(8, 4);
    expect(() => past.output(10)).toThrow(Unreadable);
    // Nothing added is nothing.
    const output = new Output();
    output.bytes(new Uint8Array(0));
    output.zeros(0);
    output.copy(5, 5);
    expect(output.size).toBe(0);
  });

  it("finds which way up a picture is in Exif of either byte order, and says upright otherwise", () => {
    expect(orientationIn(tiff(6).subarray(0, 7))).toBe(1);
    expect(orientationIn(tiff(6))).toBe(6);
    expect(orientationIn(bytes("II", [42, 0], le32(8), le16(1), le16(0x0112), le16(3), le32(1), le16(8), [0, 0]))).toBe(8);
    expect(orientationIn(bytes("XX", [0, 42], u32(8), fill(14, 0)))).toBe(1);
    expect(orientationIn(bytes("MM", [0, 42], u32(100)))).toBe(1);
    // An entry cut short, one of another type, and a value that isn't one.
    expect(orientationIn(bytes("MM", [0, 42], u32(8), u16(3), u16(0x0112), u16(3)))).toBe(1);
    expect(orientationIn(bytes("MM", [0, 42], u32(8), u16(1), u16(0x0112), u16(4), u32(1), u32(6)))).toBe(1);
    expect(orientationIn(tiff(9))).toBe(1);
    expect(orientationIn(bytes("MM", [0, 42], u32(8), u16(1), u16(0x0110), u16(3), u32(1), u16(6), [0, 0]))).toBe(1);
  });
});

describe("films and HEIF pictures built by hand", () => {
  it("names a HEIF picture by any of its brands, and nothing else", () => {
    expect(isHeif(box("ftyp", "mif1", u32(0), "heic"))).toBe(true);
    expect(isHeif(box("ftyp", "isom", u32(0), "mp41", "avif"))).toBe(true);
    expect(isHeif(box("ftyp", "isom", u32(0), "mp41"))).toBe(false);
  });

  it("empties what a film keeps anywhere in it, in boxes of every size, and keeps every offset", async () => {
    const times = fill(16, 0x11);
    const film = bytes(
      box("ftyp", "isom", u32(0), "isom"),
      box("uuid", fill(16, 0xab), "ZunaTest maker's data"),
      box(
        "moov",
        box("mvhd", [1, 0, 0, 0], times, u32(1000)),
        box("free", "ZunaTest old title"),
        box("uuid", fill(16, 0xcd), "ZunaTest XMP"),
        box(
          "trak",
          box("tkhd", [0, 0, 0, 0], fill(8, 0x22), u32(1)),
          box("meta", "ZunaTest track's place"),
          box("skip", "ZunaTest skipped"),
          box("mdia", box("mdhd", [0, 0, 0, 0], fill(8, 0x33), u32(600)), box("hdlr", [0, 0, 0, 0], u32(0), "vide", fill(12, 0)), box("udta", "ZunaTest media's note")),
        ),
        // A track with no media in it.
        box("trak", box("tkhd", [0, 0, 0, 0], fill(8, 0x44), u32(3))),
      ),
      box("wide"),
      // Padding with a 64-bit size.
      bytes(u32(1), "skip", u64(31), "ZunaTest 64-bit"),
      // The picture itself, to the end of the file.
      bytes(u32(0), "mdat", "frames"),
    );
    const after = await clean(film, "video/mp4", "film.mp4");
    expect(after.length).toBe(film.length);
    expect(latin1(after)).not.toContain("ZunaTest");
    expect(latin1(after)).toContain("frames");
    const at = (needle: string) => latin1(film).indexOf(needle);
    expect(zeros(after, at("mvhd") + 8, 16)).toBe(true);
    expect([...after.subarray(at("mvhd") + 24, at("mvhd") + 28)]).toEqual(u32(1000));
    expect(zeros(after, at("tkhd") + 8, 8)).toBe(true);
    expect(zeros(after, at("mdhd") + 8, 8)).toBe(true);
    // What's emptied is named padding, which every reader skips.
    expect(latin1(after.subarray(at("uuid") , at("uuid") + 4))).toBe("free");
    expect(latin1(after.subarray(at("udta"), at("udta") + 4))).toBe("free");
  });

  it("takes a timed metadata track's samples out, chunk by chunk, wherever its offsets say", async () => {
    // Two chunks of places, the first of two samples and the second of one, after a header of 8.
    const samples = bytes("ZunaTest:1;", "ZunaTest:22;", "ZunaTest:333;");
    const header = box("ftyp", "qt  ", u32(0), "qt  ");
    const mdatAt = header.length;
    const first = mdatAt + 8;
    const second = first + 11 + 12;
    const track = (offsets: Uint8Array, sizes: Uint8Array) =>
      box(
        "trak",
        box("tkhd", [0, 0, 0, 0], fill(8, 0x22), u32(2)),
        box(
          "mdia",
          box("hdlr", [0, 0, 0, 0], u32(0), "meta", fill(12, 0)),
          box("minf", box("stbl", box("stsc", [0, 0, 0, 0], u32(2), u32(1), u32(2), u32(1), u32(2), u32(1), u32(1)), sizes, offsets)),
        ),
      );
    const perSample = box("stsz", [0, 0, 0, 0], u32(0), u32(3), u32(11), u32(12), u32(13));
    const wide = box("co64", [0, 0, 0, 0], u32(2), u64(first), u64(second));
    const film = bytes(header, box("mdat", samples), box("moov", track(wide, perSample)));
    const after = await clean(film, "video/quicktime", "places.mov");
    expect(zeros(after, first, samples.length)).toBe(true);
    expect(latin1(after)).not.toContain("ZunaTest");

    // Of a fixed size, with 32-bit offsets.
    const fixed = box("stsz", [0, 0, 0, 0], u32(4), u32(3));
    const narrow = box("stco", [0, 0, 0, 0], u32(2), u32(first), u32(first + 8));
    const evenly = bytes(header, box("mdat", "ZunaTestZunaTest!!!!"), box("moov", track(narrow, fixed)));
    const cleaned = await clean(evenly, "video/mp4", "even.mp4");
    expect(zeros(cleaned, first, 12)).toBe(true);
    expect(latin1(cleaned.subarray(first + 12, first + 20))).toBe("Test!!!!");

    // A table of chunks with no runs in it holds no samples, but the track still goes.
    const noRuns = (offsets: Uint8Array) =>
      box("trak", box("mdia", box("hdlr", [0, 0, 0, 0], u32(0), "meta", fill(12, 0)), box("minf", box("stbl", box("stsc", [0, 0, 0, 0], u32(0)), fixed, offsets))));
    const empty = bytes(header, box("mdat", "ZunaTest"), box("moov", noRuns(narrow)));
    const emptied = await clean(empty, "video/mp4", "empty.mp4");
    expect(latin1(emptied.subarray(first, first + 8))).toBe("ZunaTest");
    expect(latin1(emptied)).not.toContain("trak");
  });

  it("empties a metadata track it can't read sample by sample, and one in a fragmented film as any track", async () => {
    const header = box("ftyp", "isom", u32(0), "isom");
    const broken = box("trak", box("tkhd", [0, 0, 0, 0], fill(8, 0x22), u32(2)), box("mdia", box("hdlr", [0, 0, 0, 0], u32(0), "meta", fill(12, 0)), box("udta", "ZunaTest place")));
    const unreadable = bytes(header, box("moov", broken), box("mdat", "x"));
    const after = await clean(unreadable, "video/mp4", "a.mp4");
    expect(latin1(after)).not.toContain("ZunaTest");
    expect(latin1(after)).toContain("free");

    const fragmented = bytes(header, box("moov", box("mvex", box("trex", fill(24, 0))), broken), box("mdat", "x"));
    const kept = await clean(fragmented, "video/mp4", "b.mp4");
    // The track stays a track, with its times and notes emptied.
    expect(latin1(kept)).toContain("trak");
    expect(latin1(kept)).not.toContain("ZunaTest");
    // A handler too short to name a kind names none.
    const short = bytes(header, box("moov", box("trak", box("mdia", box("hdlr", [0, 0, 0, 0], "abc")))), box("mdat", "x"));
    expect((await clean(short, "video/mp4", "c.mp4")).length).toBe(short.length);
  });

  it("sends a film whose boxes don't add up as it is", async () => {
    const broken = bytes(box("ftyp", "isom", u32(0), "isom"), u32(4), "moov");
    expect(await clean(broken, "video/mp4", "broken.mp4")).toEqual(broken);
    const tooLong = bytes(box("ftyp", "isom", u32(0), "isom"), u32(1000), "moov", "short");
    expect(await clean(tooLong, "video/mp4", "long.mp4")).toEqual(tooLong);
  });

  const FTYP = box("ftyp", "heic", u32(0), "mif1", "heic");

  /** A HEIF picture: its type, a meta box with items, then the file's data. */
  function heif(meta: Uint8Array, data: Uint8Array): Uint8Array {
    return bytes(FTYP, meta, box("mdat", data));
  }

  const infe = (version: number, ...rest: Part[]) => box("infe", [version, 0, 0, 0], ...rest);

  it("writes over Exif and XMP items of every version, in the file or in the meta box's own data", async () => {
    const exif = bytes(u32(0), tiff(6));
    const xmpInIdat = bytes("<x:xmpmeta>ZunaTest in idat</x:xmpmeta>");
    const xmpOld = bytes("<x:xmpmeta>ZunaTest of an old infe, with room to spare for the packet</x:xmpmeta>".padEnd(120, " "));
    const ftypLength = FTYP.length;
    // The meta box is built twice: once to learn its size, which the file offsets depend on.
    const build = (mdatData: number) => {
      const iinf = box("iinf", [0, 0, 0, 0], u16(7), infe(2, u16(1), u16(0), "Exif", "\0"), infe(3, u32(2), u16(0), "mime", "\0", "application/rdf+xml\0"), infe(0, u16(3), u16(0), "\0", "application/xmp+xml\0"), infe(2, u16(4), u16(0), "hvc1", "\0"), box("pitm", u16(4)), infe(2, u16(5), u16(0), "mime", "\0", "text/plain\0"), infe(1, u16(6), u16(0), "\0", "text/plain\0"));
      const extent = (offset: number, length: number) => [...u16(1), ...u32(offset), ...u32(length)];
      const iloc = box(
        "iloc",
        [1, 0, 0, 0],
        [0x44, 0x00],
        u16(5),
        // Exif, in the file.
        u16(1), u16(0), u16(0), extent(mdatData, exif.length),
        // XMP in the meta box's data.
        u16(2), u16(1), u16(0), extent(0, xmpInIdat.length),
        // XMP of an old infe, in the file.
        u16(3), u16(0), u16(0), extent(mdatData + exif.length, xmpOld.length),
        // The picture: kept.
        u16(4), u16(0), u16(0), extent(mdatData + exif.length + xmpOld.length, 4),
        // Elsewhere than this file: left alone.
        u16(2), u16(0), u16(1), extent(0, 4),
      );
      return box("meta", [0, 0, 0, 0], box("hdlr", [0, 0, 0, 0], u32(0), "pict", fill(12, 0)), iinf, iloc, box("idat", xmpInIdat));
    };
    const size = build(0).length;
    const meta = build(ftypLength + size + 8);
    const file = heif(meta, bytes(exif, xmpOld, "PICT"));
    const after = await clean(file, "image/heic", "photo.heic");
    expect(after.length).toBe(file.length);
    const text = latin1(after);
    expect(text).not.toContain("ZunaTest");
    expect(text).not.toContain("Cam");
    expect(text).toContain("PICT");
    // The Exif left says which way up the picture is, and nothing else.
    const exifAt = ftypLength + size + 8;
    expect(orientationIn(after.subarray(exifAt + 4, exifAt + exif.length))).toBe(6);
    // XMP with room keeps a packet; without, it's spaces.
    expect(text).toContain('<?xpacket end="w"?>');
    const idatAt = latin1(file).indexOf("<x:xmpmeta>ZunaTest in idat");
    expect(latin1(after.subarray(idatAt, idatAt + xmpInIdat.length)).trim()).toBe("");
  });

  it("reads a version 2 location box with 64-bit offsets and an index, and skips what it can't place", async () => {
    const exif = bytes(u32(0), tiff(3));
    const build = (data: number) =>
      box(
        "meta",
        [0, 0, 0, 0],
        box("iinf", [1, 0, 0, 0], u32(2), infe(2, u16(7), u16(0), "Exif", "\0"), infe(2, u16(8), u16(0), "Exif", "\0")),
        box(
          "iloc",
          [2, 0, 0, 0],
          // 8-byte offsets, 4-byte lengths, 4-byte base offsets, 4-byte indexes.
          [0x84, 0x44],
          u32(3),
          u32(7), u16(0), u16(0), u32(data), u16(1), u32(0), u64(0), u32(exif.length),
          // An empty extent, and one past the end.
          u32(8), u16(0), u16(0), u32(0), u16(1), u32(0), u64(data), u32(0),
          u32(8), u16(0), u16(0), u32(0), u16(1), u32(0), u64(data), u32(1_000_000),
        ),
      );
    const size = build(0).length;
    const file = heif(build(FTYP.length + size + 8), exif);
    const after = await clean(file, "image/avif", "photo.avif");
    expect(latin1(after)).not.toContain("Cam");
    expect(orientationIn(after.subarray(FTYP.length + size + 8 + 4))).toBe(3);
  });

  it("leaves a picture whose items can't be found, or say nothing of metadata, as it is", async () => {
    const noItems = heif(box("meta", [0, 0, 0, 0], box("hdlr", [0, 0, 0, 0], u32(0), "pict", fill(12, 0))), bytes("PICT"));
    expect(await clean(noItems, "image/heic")).toEqual(noItems);
    const nothingToClean = heif(box("meta", [0, 0, 0, 0], box("iinf", [0, 0, 0, 0], u16(1), infe(2, u16(1), u16(0), "hvc1", "\0")), box("iloc", [0, 0, 0, 0], [0x44, 0], u16(0))), bytes("PICT"));
    expect(await clean(nothingToClean, "image/heic")).toEqual(nothingToClean);
    // XMP said to be in the meta box's data, with none: nothing to write over. And Exif of under four bytes.
    const tiny = bytes([0, 0]);
    const build = (data: number) =>
      box(
        "meta",
        [0, 0, 0, 0],
        box("iinf", [0, 0, 0, 0], u16(2), infe(2, u16(1), u16(0), "mime", "\0", "application/xml\0"), infe(2, u16(2), u16(0), "Exif", "\0")),
        box("iloc", [1, 0, 0, 0], [0x44, 0x00], u16(2), u16(1), u16(1), u16(0), u16(1), u32(0), u32(4), u16(2), u16(0), u16(0), u16(1), u32(data), u32(tiny.length)),
      );
    const size = build(0).length;
    const file = heif(build(FTYP.length + size + 8), tiny);
    const after = await clean(file, "image/heic");
    expect(after.length).toBe(file.length);
    // Item sizes that aren't 0, 4 or 8 bytes, or a box inside the meta box that runs past it, aren't read.
    const odd = heif(box("meta", [0, 0, 0, 0], box("iinf", [0, 0, 0, 0], u16(1), infe(2, u16(1), u16(0), "Exif", "\0")), box("iloc", [0, 0, 0, 0], [0x22, 0x00], u16(1), u16(1), u16(0), u16(1), u16(0), u16(4))), bytes("PICT"));
    expect(await clean(odd, "image/heic")).toEqual(odd);
    const overrun = heif(box("meta", [0, 0, 0, 0], u32(100), "iinf"), bytes("PICT"));
    expect(await clean(overrun, "image/heic")).toEqual(overrun);
  });
});

describe("pictures built by hand", () => {
  const jpeg = (...segments: Part[]) => bytes([0xff, 0xd8], ...segments);
  const segment = (marker: number, ...payload: Part[]) => {
    const body = bytes(...payload);
    return bytes([0xff, marker], u16(body.length + 2), body);
  };

  it("keeps a JPEG's restarts, fill bytes and scans, and an Adobe segment its colors need", async () => {
    const file = jpeg(
      [0xff, 0xd0, 0xff, 0x01],
      segment(0xee, "Adobe", fill(7, 1)),
      segment(0xfe, "ZunaTest comment"),
      segment(0xe1, "Exif\0\0", tiff(1)),
      segment(0xdb, fill(65, 2)),
      segment(0xda, fill(10, 3)),
      [0x10, 0xff, 0x00, 0x20, 0xff, 0xd3, 0x30],
      [0xff, 0xff, 0xd9],
      "ZunaTest after the picture",
    );
    const after = latin1(await clean(file, "image/jpeg"));
    expect(after).toContain("Adobe");
    expect(after).not.toContain("ZunaTest");
    expect(after).not.toContain("Exif");
    expect(after.endsWith("\x30\xff\xd9")).toBe(true);
    expect(after.startsWith("\xff\xd8\xff\xd0\xff\x01")).toBe(true);
  });

  it("finds a marker split across what's read of a long scan, and keeps a scan that runs to the end", async () => {
    // The scan's data is read 256 KB at a time: a marker's first byte is the last of the first read.
    const scan = new Uint8Array(256 * 1024 + 100).fill(0x44);
    const header = segment(0xda, fill(10, 3));
    const start = 2 + header.length;
    scan[256 * 1024 - 1] = 0xff;
    scan[256 * 1024] = 0xd9;
    const file = jpeg(header, scan.subarray(0, 256 * 1024 + 1), "ZunaTest trailer");
    const after = await clean(file, "image/jpeg");
    expect(after.length).toBe(start + 256 * 1024 + 1);
    expect(latin1(after.subarray(-2))).toBe("\xff\xd9");
    // No end of picture at all: what's there is kept.
    const open = jpeg(segment(0xfe, "ZunaTest"), header, fill(10, 0x55));
    const kept = await clean(open, "image/jpeg");
    expect(latin1(kept)).not.toContain("ZunaTest");
    expect(kept.length).toBe(open.length - 12);
    // Segments only, with no scan or end.
    expect(latin1(await clean(jpeg(segment(0xfe, "ZunaTest")), "image/jpeg"))).toBe("\xff\xd8");
  });

  it("writes a PNG's Exif again with only which way up it is, or drops it", async () => {
    const chunk = (type: string, data: Uint8Array) => bytes(u32(data.length), type, data, u32(0));
    const png = (...chunks: Uint8Array[]) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ...chunks, chunk("IEND", new Uint8Array(0)));
    const turned = await clean(png(chunk("IHDR", new Uint8Array(13)), chunk("eXIf", tiff(6)), chunk("tEXt", bytes("Comment\0ZunaTest"))), "image/png");
    expect(latin1(turned)).toContain("eXIf");
    expect(latin1(turned)).not.toContain("ZunaTest");
    expect(latin1(turned)).not.toContain("Cam");
    const upright = await clean(png(chunk("IHDR", new Uint8Array(13)), chunk("eXIf", tiff(1))), "image/png");
    expect(latin1(upright)).not.toContain("eXIf");
  });

  it("reads a GIF without a palette, with one of its own, and drops what other programs add", async () => {
    const subBlocks = (...blocks: string[]) => bytes(...blocks.flatMap((block) => [[block.length], block]), [0]);
    const image = (local: boolean) => bytes([0x2c], u16(0), u16(0), le16(1), le16(1), [local ? 0x80 : 0], local ? fill(6, 7) : [], [2], subBlocks("\x44\x01"));
    const file = bytes(
      "GIF89a",
      le16(1),
      le16(1),
      [0x00, 0, 0],
      [0x21, 0xff, 11], "NETSCAPE2.0", subBlocks("\x01\x00\x00"),
      [0x21, 0xff, 11], "XMP DataXMP", subBlocks("ZunaTest xmp"),
      [0x21, 0xfe], subBlocks("ZunaTest comment"),
      [0x21, 0xf9], subBlocks("\x00\x00\x00\x00"),
      image(false),
      image(true),
      [0x3b],
    );
    const after = latin1(await clean(file, "image/gif"));
    expect(after).toContain("NETSCAPE2.0");
    expect(after).not.toContain("ZunaTest");
    expect(after.endsWith(";")).toBe(true);
  });

  it("takes WebP's Exif with or without its header, and says in the header what's left", async () => {
    const chunk = (type: string, data: Part) => {
      const body = bytes(data);
      return bytes(type, le32(body.length), body, body.length & 1 ? [0] : []);
    };
    const webp = (...chunks: Uint8Array[]) => {
      const body = bytes("WEBP", ...chunks);
      return bytes("RIFF", le32(body.length), body);
    };
    const flags = (data: Uint8Array) => data[20]!;
    const bare = await clean(webp(chunk("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]), chunk("VP8 ", fill(10, 1)), chunk("EXIF", tiff(8)), chunk("XMP ", "ZunaTest")), "image/webp");
    expect(latin1(bare)).toContain("EXIF");
    expect(latin1(bare)).not.toContain("ZunaTest");
    expect(flags(bare) & 0x0c).toBe(0x08);
    const upright = await clean(webp(chunk("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]), chunk("VP8L", fill(5, 1)), chunk("EXIF", bytes("Exif\0\0", tiff(1)))), "image/webp");
    expect(latin1(upright)).not.toContain("EXIF");
    expect(flags(upright) & 0x0c).toBe(0);
    // An extended header too short to hold its flags is kept as it is.
    const short = await clean(webp(chunk("VP8X", []), chunk("VP8 ", fill(4, 1))), "image/webp");
    expect(latin1(short)).toContain("VP8X");
  });
});

describe("drawings built by hand", () => {
  const svg = (text: string) => clean(new TextEncoder().encode(text), "image/svg+xml", "drawing.svg");
  const read = async (text: string) => new TextDecoder().decode(await svg(text));

  it("keeps a byte order mark, and sends what isn't a drawing or isn't UTF-8 as it is", async () => {
    const withBom = bytes([0xef, 0xbb, 0xbf], '<svg><!-- ZunaTest --><g/></svg>');
    const cleaned = await clean(withBom, "image/svg+xml");
    expect([...cleaned.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(latin1(cleaned)).not.toContain("ZunaTest");
    const notUtf8 = bytes("<svg>", [0xff, 0xfe], "<!-- ZunaTest --></svg>");
    expect(await clean(notUtf8, "image/svg+xml")).toEqual(notUtf8);
    const notADrawing = bytes("<html><!-- ZunaTest --></html>");
    expect(await clean(notADrawing, "image/svg+xml", "page.svg")).toEqual(notADrawing);
  });

  it("drops an editor's elements even when they close themselves, and what's inside dropped ones", async () => {
    const text = await read(
      '<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:x="&unknown;"><inkscape:grid id="ZunaTest"/>' +
        '<metadata><?pi ZunaTest?><!DOCTYPE inner><![CDATA[ZunaTest]]><g/></metadata><rect hidden x="1"/>tail',
    );
    expect(text).toBe('<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:x="&unknown;"><rect hidden x="1"/>tail');
    // Text after a dropped element that never closes can't be placed.
    const unclosed = new TextEncoder().encode("<svg><metadata>ZunaTest");
    expect(await clean(unclosed, "image/svg+xml")).toEqual(unclosed);
  });

  it("sends a drawing cut short, or with an attribute it can't read, as it is", async () => {
    for (const text of ['<svg><!DOCTYPE svg [ <!ENTITY a "]>"> ', "<svg x=1></svg>", '<svg x="1></svg>', "<svg ", "<svg <></svg>", "<svg ='1'></svg>", "<svg><!-- never closed"]) {
      const original = new TextEncoder().encode(text);
      expect(await clean(original, "image/svg+xml"), text).toEqual(original);
    }
  });

  it("keeps a picture drawn in that's already clean, or that isn't base64, as written", async () => {
    // A GIF with nothing to take out, and a picture whose base64 doesn't decode.
    const gif = btoa("GIF89a\x01\x00\x01\x00\x00\x00\x00;");
    const text = `<svg><image href="data:image/gif;base64,${gif}"/><image href="data:image/png;base64,AAAAA"/></svg>`;
    expect(await read(text)).toBe(text);
  });
});

describe("Matroska built by hand", () => {
  /** An element: its ID's bytes, a size of one byte, and what it holds. */
  const element = (id: number[], ...payload: Part[]) => {
    const body = bytes(...payload);
    return bytes(id, [0x80 | body.length], body);
  };
  const EBML = [0x1a, 0x45, 0xdf, 0xa3];
  const SEGMENT = [0x18, 0x53, 0x80, 0x67];
  const INFO = [0x15, 0x49, 0xa9, 0x66];
  const TAGS = [0x12, 0x54, 0xc3, 0x67];
  const TITLE = [0x7b, 0xa9];
  const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

  it("voids tags and the title in a segment still being recorded, as far as its first open cluster", async () => {
    const film = bytes(
      element(EBML, element([0x42, 0x82], "webm")),
      // A segment whose size says it isn't known, in eight bytes.
      SEGMENT,
      [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      element(INFO, element(TITLE, "ZunaTest title")),
      element(TAGS, element([0x73, 0x73], "ZunaTest tag")),
      // A cluster of unknown size: nothing past it is looked at.
      CLUSTER,
      [0xff],
      "frames",
      element(TAGS, "ZunaTest later"),
    );
    const after = latin1(await clean(film, "video/webm", "live.webm"));
    expect(after.length).toBe(film.length);
    expect(after).not.toContain("ZunaTest title");
    expect(after).not.toContain("ZunaTest tag");
    expect(after).toContain("ZunaTest later");
    expect(after).toContain("frames");
  });
});
