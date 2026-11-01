// Metadata taken out of files before they're sent. The fixtures are tiny pictures,
// films and drawings made with ffmpeg, sips, cwebp and AVFoundation, then given
// metadata with exiftool: a place, a camera, a serial number, dates, a program,
// XMP, IPTC and comments, every value starting "ZunaTest". timed.mov has a track
// of places, one a frame, as cameras write. drawing.svg and illustrator.svg are
// written as Inkscape and Illustrator write them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withoutMetadata, type ByteSource } from "../src/metadata";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/metadata/${name}`, import.meta.url)));

const memory = (bytes: Uint8Array): ByteSource => ({ size: bytes.length, read: async (start, end) => bytes.subarray(start, end) });

const MIMES: Record<string, string> = {
  jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", avif: "image/avif",
  mp4: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp", mkv: "video/x-matroska", webm: "video/webm", svg: "image/svg+xml",
};

async function clean(name: string, mime = MIMES[name.split(".").pop()!]!): Promise<{ before: Uint8Array; after: Uint8Array }> {
  const before = fixture(name);
  const cleaned = await withoutMetadata(memory(before), mime, name);
  return { before, after: await cleaned.read(0, cleaned.size) };
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");
const has = (bytes: Uint8Array, needle: string | number[]) => Buffer.from(bytes).includes(typeof needle === "string" ? Buffer.from(needle, "latin1") : Buffer.from(needle));

/** Exif that says only that the picture is turned a quarter right, as written in its place. */
const TURNED = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6];

describe("taking metadata out of a file", () => {
  it.each(["photo.jpg", "photo.png", "photo.webp", "photo.gif", "photo.heic", "photo.avif", "video.mp4", "video.mov", "video.3gp", "video.mkv", "video.webm", "timed.mov", "drawing.svg", "illustrator.svg"])(
    "leaves nothing of it in %s",
    async (name) => {
      const { before, after } = await clean(name);
      expect(has(before, "ZunaTest")).toBe(name !== "timed.mov" || has(before, "ZunaTestMake"));
      expect(has(after, "ZunaTest")).toBe(false);
      expect(after.length).toBeLessThanOrEqual(before.length);
    },
  );

  it("keeps a photo's picture, colors and which way up it is, and drops what follows it", async () => {
    const { before, after } = await clean("photo.jpg");
    // From the scan header to the end of the picture, byte for byte. The thumbnail in the Exif has one of its own first.
    const scan = (bytes: Uint8Array) => {
      const start = Buffer.from(bytes).lastIndexOf(Buffer.from([0xff, 0xda]));
      const end = Buffer.from(bytes).lastIndexOf(Buffer.from([0xff, 0xd9]));
      return Buffer.from(bytes.subarray(start, end + 2));
    };
    expect(scan(after).equals(scan(before))).toBe(true);
    expect(text(before).endsWith("ZunaTestTrailer")).toBe(true);
    expect([...after.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(has(after, "ICC_PROFILE\0")).toBe(true);
    expect(has(after, [...Buffer.from("Exif\0\0", "latin1"), ...TURNED])).toBe(true);
    // The JFIF header stays, without room for a thumbnail.
    expect([...after.subarray(0, 6)]).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    // Exif with its embedded thumbnail, XMP, IPTC and the comment all went.
    for (const gone of ["http://ns.adobe.com/xap/1.0/", "Photoshop 3.0", "ZunaTestComment"]) expect(has(after, gone)).toBe(false);
  });

  it("keeps a PNG's picture and turns it the same way", async () => {
    const { before, after } = await clean("photo.png");
    const chunks = (bytes: Uint8Array) => {
      const found: string[] = [];
      for (let at = 8; at < bytes.length; ) {
        const length = Buffer.from(bytes).readUInt32BE(at);
        found.push(text(bytes.subarray(at + 4, at + 8)));
        at += 12 + length;
      }
      return found;
    };
    expect(chunks(before)).toContain("tEXt");
    expect(chunks(after)).toEqual(["IHDR", "pHYs", "eXIf", "IDAT", "IEND"]);
    const idat = (bytes: Uint8Array) => Buffer.from(bytes).subarray(Buffer.from(bytes).indexOf("IDAT") - 4);
    expect(idat(after).equals(idat(before))).toBe(true);
    expect(has(after, TURNED)).toBe(true);
  });

  it("rewrites a WebP's header to say what's left", async () => {
    const { after } = await clean("photo.webp");
    const view = Buffer.from(after);
    expect(view.readUInt32LE(4)).toBe(after.length - 8);
    expect(text(after.subarray(12, 16))).toBe("VP8X");
    // Exif is still there, as only which way up the picture is; XMP isn't.
    expect(after[20]! & 0x0c).toBe(0x08);
    expect(has(after, TURNED)).toBe(true);
    expect(has(after, "XMP ")).toBe(false);
  });

  it("writes over a HEIF picture's Exif and XMP in place", async () => {
    for (const name of ["photo.heic", "photo.avif"]) {
      const { before, after } = await clean(name);
      expect(after.length).toBe(before.length);
      expect(has(after, [0, 0, 0, 0, ...TURNED])).toBe(true);
      expect(has(after, '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>')).toBe(true);
    }
  });

  it("empties a film's metadata boxes and dates without moving anything", async () => {
    for (const name of ["video.mp4", "video.mov", "video.3gp"]) {
      const { before, after } = await clean(name);
      expect(after.length).toBe(before.length);
      // Every byte that changed is a zero, or the name of a box turned into padding.
      let changed = 0;
      for (let i = 0; i < before.length; i++) {
        if (after[i] === before[i]) continue;
        changed++;
        if (after[i] !== 0) expect(text(after.subarray(i - 3, i + 4))).toMatch(/free/);
      }
      expect(changed).toBeGreaterThan(0);
      expect(has(after, "ZunaTest")).toBe(false);
      // ISO 6709, as the place is written.
      expect(has(after, "+52.2297")).toBe(false);
    }
  });

  it("takes out a track of where the camera was, sample by sample", async () => {
    const { before, after } = await clean("timed.mov");
    expect(has(before, "+52.2247+021.0122")).toBe(true);
    expect(has(after, "+52.22")).toBe(false);
    expect(has(after, "mebx")).toBe(false);
    expect(after.length).toBe(before.length);
  });

  it("makes Matroska's tags, title and date Void", async () => {
    for (const name of ["video.mkv", "video.webm"]) {
      const { before, after } = await clean(name);
      expect(after.length).toBe(before.length);
      expect(has(after, "+52.2297")).toBe(false);
      expect(has(after, "Lavf")).toBe(true);
    }
  });

  it("keeps a drawing as drawn, with its pictures cleaned too", async () => {
    const { after } = await clean("drawing.svg");
    const svg = new TextDecoder().decode(after);
    for (const gone of ["<!--", "sodipodi:namedview", "inkscape:label", "sodipodi:docname", "<metadata", "/Users/zunatest"]) expect(svg).not.toContain(gone);
    for (const kept of ['<rect style="fill:#3366cc"', "<title>A drawing</title>", "<![CDATA[ .a > .b { fill: #c00 } ]]>", "Hello &amp; welcome", 'xmlns:inkscape="']) expect(svg).toContain(kept);
    const picture = /data:image\/jpeg;base64,([^"]+)/.exec(svg)![1]!;
    const inside = Buffer.from(picture, "base64");
    expect(inside.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(inside.includes("ZunaTest")).toBe(false);

    const illustrator = new TextDecoder().decode((await clean("illustrator.svg")).after);
    expect(illustrator).not.toContain("i:pgf");
    expect(illustrator).not.toContain("i:extraneous");
    expect(illustrator).toContain('<circle cx="16" cy="16" r="8" fill="#e33"/>');
    expect(illustrator).toContain("<!ENTITY ns_ai");
  });

  it("reads the same in pieces as at once", async () => {
    const before = fixture("photo.jpg");
    const cleaned = await withoutMetadata(memory(before), "image/jpeg", "photo.jpg");
    const whole = await cleaned.read(0, cleaned.size);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < cleaned.size; at += 777) pieces.push(await cleaned.read(at, Math.min(at + 777, cleaned.size)));
    expect(Buffer.concat(pieces).equals(Buffer.from(whole))).toBe(true);
  });

  it("sends other files, and ones that don't read as their kind should, as they are", async () => {
    const plain = memory(new TextEncoder().encode("ZunaTest notes"));
    expect(await withoutMetadata(plain, "text/plain", "notes.txt")).toBe(plain);
    // A film only when it's named or typed as one, so music keeps its tags.
    const song = memory(fixture("video.mp4"));
    expect(await withoutMetadata(song, "audio/mp4", "song.m4a")).toBe(song);
    const cut = memory(fixture("photo.png").subarray(0, 400));
    expect(await withoutMetadata(cut, "image/png", "cut.png")).toBe(cut);
    const broken = memory(new TextEncoder().encode("<svg><g>unclosed <!-- comment"));
    expect(await withoutMetadata(broken, "image/svg+xml", "broken.svg")).toBe(broken);
  });

  it("passes on a failure to read the file", async () => {
    const failing: ByteSource = { size: 100, read: async () => Promise.reject(new Error("disk gone")) };
    await expect(withoutMetadata(failing, "image/jpeg", "photo.jpg")).rejects.toThrow("disk gone");
  });
});
