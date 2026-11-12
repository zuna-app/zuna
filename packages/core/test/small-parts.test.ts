// Small pieces of the core with no server in them: YouTube links and which watch state wins,
// soundboard WAV files, and the trust manifest split into vault items.

import { beforeAll, describe, expect, it } from "vitest";
import { manifestParts, parseManifest, readManifestPart, joinManifestParts, manifestPartId, isManifestPart, MANIFEST_MOST_PARTS } from "../src/manifest";
import { readWav, writeWav } from "../src/sounds";
import { readYouTubeLink, sameWatch, watchBeats, watchPosition, type WatchState } from "../src/watch";
import { utf8 } from "../src/encoding";
import { loadCrypto } from "./helpers";

beforeAll(loadCrypto);

describe("watching together", () => {
  it("reads every way a YouTube link is written, and where it says to start", () => {
    const id = "aqz-KE-bpKQ";
    for (const [link, start] of [
      [`https://www.youtube.com/watch?v=${id}`, 0],
      [`youtube.com/watch?v=${id}&t=90`, 90_000],
      [`https://youtu.be/${id}?t=1h2m3s`, 3_723_000],
      [`https://m.youtube.com/shorts/${id}?start=2.5s`, 2500],
      [`https://www.youtube-nocookie.com/embed/${id}`, 0],
      [`http://youtube.com:80/live/${id}?t=nonsense`, 0],
      [`https://www.youtu.be/${id}?t=5m`, 300_000],
    ] as const) {
      expect(readYouTubeLink(link), link).toEqual({ id, start });
    }
    for (const link of ["", "two words", "ftp://youtube.com/watch?v=aqz-KE-bpKQ", "https://user@youtube.com/watch?v=aqz-KE-bpKQ", "https://youtube.com:8080/watch?v=aqz-KE-bpKQ", "https://youtube.com/watch", "https://youtube.com/watch/more?v=aqz-KE-bpKQ", "https://youtube.com/channel/x", "https://example.com/watch?v=aqz-KE-bpKQ", "https://youtu.be/short", "http://[bad"]) {
      expect(readYouTubeLink(link), link).toBeNull();
    }
  });

  it("decides which state wins the same way everywhere, and where a video is", () => {
    const state = (rev: number, at: number, device: string): WatchState => ({ session: "s", rev, video: null, playing: false, position: 0, at, rate: 1, user: "u", device });
    expect(watchBeats(state(1, 0, "a"), null)).toBe(true);
    expect(watchBeats(state(2, 0, "a"), state(1, 9, "z"))).toBe(true);
    expect(watchBeats(state(1, 5, "a"), state(1, 4, "z"))).toBe(true);
    expect(watchBeats(state(1, 5, "b"), state(1, 5, "a"))).toBe(true);
    expect(watchBeats(state(1, 5, "a"), state(1, 5, "b"))).toBe(false);
    expect(sameWatch(state(1, 5, "a"), state(1, 5, "a"))).toBe(true);
    expect(sameWatch(state(1, 5, "a"), state(2, 5, "a"))).toBe(false);
    expect(watchPosition({ playing: true, position: 1000, at: 0, rate: 2 }, 500)).toBe(2000);
    expect(watchPosition({ playing: false, position: 1000, at: 0, rate: 2 }, 500)).toBe(1000);
    expect(watchPosition({ playing: true, position: 0, at: 1000, rate: 1 }, 0)).toBe(0);
  });
});

describe("a soundboard's sound", () => {
  it("reads back what it wrote, and refuses what isn't a WAV it makes", () => {
    const samples = new Int16Array([1, -2, 3, -4]);
    expect([...readWav(writeWav(samples))!]).toEqual([1, -2, 3, -4]);
    const wav = writeWav(samples);
    const broken = (change: (bytes: Uint8Array, view: DataView) => void) => {
      const copy = wav.slice();
      change(copy, new DataView(copy.buffer));
      return readWav(copy);
    };
    expect(broken((bytes) => bytes.set(utf8("RIFX"), 0))).toBeNull();
    expect(broken((_, view) => view.setUint32(40, 1 << 20, true))).toBeNull();
    expect(broken((_, view) => view.setUint32(40, 3, true))).toBeNull();
    expect(readWav(wav.slice(0, 36))).toBeNull();
    expect(readWav(wav, 10)).toBeNull();
  });
});

describe("the trust manifest", () => {
  const manifest = { v: 1, pins: { u: "key" }, verified: { u: "key" }, chains: { u: { gen: 1, hash: "h" } }, trust: { u: 2 } };

  it("splits into parts and comes back whole", () => {
    expect(parseManifest(manifest)).toEqual(manifest);
    const parts = manifestParts(manifest as never)!;
    expect(parts.map((part) => part.id)).toEqual([manifestPartId(0)]);
    expect(isManifestPart(manifestPartId(3))).toBe(true);
    const read = parts.map((part) => readManifestPart(part.id, part.data)!);
    expect(JSON.parse(new TextDecoder().decode(joinManifestParts(read)!))).toEqual(manifest);
  });

  it("refuses a manifest, or a part of one, that isn't right", () => {
    for (const value of [null, { ...manifest, v: 0 }, { ...manifest, pins: [] }, { ...manifest, verified: { u: 5 } }, { ...manifest, chains: { u: { gen: -1, hash: "h" } } }, { ...manifest, trust: { u: "two" } }]) {
      expect(parseManifest(value)).toBeNull();
    }
    const huge = { ...manifest, pins: Object.fromEntries(Array.from({ length: MANIFEST_MOST_PARTS * 20_000 }, (_, i) => [`user${i}`, "k".repeat(10)])) };
    expect(manifestParts(huge as never)).toBeNull();
    const [part] = manifestParts(manifest as never)!;
    const header = (fields: Record<string, unknown>) => utf8(`${JSON.stringify(fields)}\n{}`);
    for (const data of [utf8("no line at all"), utf8("not json\n{}"), utf8("5\n{}"), header({ v: 0, part: 0, parts: 1, hash: "h" }), header({ v: 1, part: 0, parts: 1, hash: 5 }), header({ v: 1, part: 0, parts: 0, hash: "h" }), header({ v: 1, part: 0, parts: MANIFEST_MOST_PARTS + 1, hash: "h" })]) {
      expect(readManifestPart(part!.id, data)).toBeNull();
    }
    const good = readManifestPart(part!.id, part!.data)!;
    // Missing a part, or not what the hash says.
    expect(joinManifestParts([{ ...good, parts: 2 }])).toBeNull();
    expect(joinManifestParts([{ ...good, hash: "not it" }])).toBeNull();
  });
});
