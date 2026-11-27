// Small pieces of the core with no server in them: YouTube links and which watch state wins,
// soundboard WAV files, the trust manifest split into vault items, and when a voice key's slot is retired.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { manifestParts, parseManifest, readManifestPart, joinManifestParts, manifestPartId, isManifestPart, MANIFEST_MOST_PARTS } from "../src/manifest";
import { heldRoster, readmitsNobody, readRoster, rosterHash, rosterJump } from "../src/roster";
import { readWav, writeWav } from "../src/sounds";
import { readYouTubeLink, sameWatch, watchBeats, watchPosition, type WatchState } from "../src/watch";
import { fromRecoveryText, toRecoveryText, utf8 } from "../src/encoding";
import { previewText } from "../src/notify";
import { VOICE_KEY_RING, VOICE_OLD_KEY_MS, VoiceKeySlots, voiceKeyIndex } from "../src/voice";
import { ZunaClient } from "../src/client";
import { MemoryDbProvider } from "./helpers";
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
    // A file of nothing but its header and an unknown chunk has no sound in it.
    const noData = wav.slice(0, 44);
    noData.set(utf8("junk"), 36);
    new DataView(noData.buffer).setUint32(40, 0, true);
    expect(readWav(noData)).toBeNull();
    // Data before its format, or of an odd size.
    expect(broken((bytes) => bytes.set(utf8("junk"), 12))).toBeNull();
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

describe("a group's roster", () => {
  const signed = (version: number, admins: string[], members: string[], by: string, prev = "") =>
    readRoster("g", utf8(JSON.stringify({ r: JSON.stringify({ v: 1, group: "g", version, admins, members, prev, by: { userId: by, deviceId: "d" } }), s: "AAAA" })))!;
  const context = { adminPresent: true, signerServerAdmin: false };

  it("reads only what's a roster for this group", () => {
    expect(signed(1, ["a"], ["a", "b"], "a").roster.version).toBe(1);
    for (const bytes of [utf8("not json"), utf8(JSON.stringify({ r: 5, s: "x" })), utf8(JSON.stringify({ r: JSON.stringify({ v: 1, group: "h", version: 1, admins: [], members: [], prev: "", by: { userId: "a", deviceId: "d" } }), s: "AAAA" }))]) {
      expect(readRoster("g", bytes)).toBeNull();
    }
  });

  it("takes the one held again, the next, or a later one an admin made, and nothing older", () => {
    const kept = signed(2, ["a"], ["a", "b"], "a");
    const held = heldRoster(kept);
    expect(rosterJump(held, kept, context)).toBeNull();
    // Going back to an older one is only ever for one that lets nobody in again, and makes nobody an admin again.
    expect(readmitsNobody({ admins: ["a"], members: ["a"] }, kept.roster)).toBe(true);
    expect(readmitsNobody({ admins: ["a"], members: ["a", "c"] }, kept.roster)).toBe(false);
    expect(readmitsNobody({ admins: ["a", "b"], members: ["a", "b"] }, kept.roster)).toBe(false);
    expect(rosterJump(held, signed(2, ["b"], ["a", "b"], "b"), context)).toMatch(/another version/);
    expect(rosterJump(held, signed(1, ["a"], ["a"], "a"), context)).toMatch(/older/);
    expect(rosterJump(held, signed(3, ["a"], ["a"], "a", "wrong"), context)).toMatch(/doesn't follow/);
    expect(rosterJump(held, signed(3, ["a"], ["a"], "a", rosterHash(kept.bytes)), context)).toBeNull();
    expect(rosterJump(held, signed(5, ["a"], ["a"], "a"), context)).toBeNull();
    expect(rosterJump(held, signed(5, ["b"], ["a", "b"], "b"), context)).toMatch(/wasn't an admin/);
  });
});

describe("a recovery key as words", () => {
  it("reads back what it wrote, taking the letters people mix up for the digits, and nothing else", () => {
    const key = new Uint8Array([1, 2, 3, 250, 99]);
    const text = toRecoveryText(key);
    expect(fromRecoveryText(text.toLowerCase())).toEqual(key);
    expect(fromRecoveryText(text.replace(/0/g, "O").replace(/1/g, "I"))).toEqual(key);
    expect(fromRecoveryText("not-a-key-U")).toBeNull();
  });
});

describe("a message as one short line", () => {
  it("says what a message without words carries, by its first file", () => {
    const file = (change: Record<string, unknown>) => ({ fileId: "f", key: "", prefix: "", chunks: 1, size: 1, name: "notes.pdf", mime: "application/pdf", ...change });
    const line = (change: Record<string, unknown>) => previewText({ text: "", attachments: [file(change)] });
    expect(line({ mime: "video/mp4", round: true })).toBe("📹 Video message");
    expect(line({ mime: "video/mp4" })).toBe("🎬 Video");
    expect(line({ mime: "audio/ogg", voice: true })).toBe("🎤 Voice message");
    expect(line({ mime: "audio/mpeg" })).toBe("🎵 Audio");
    expect(line({})).toBe("📎 notes.pdf");
    expect(previewText({ text: "x".repeat(200), attachments: [] })).toHaveLength(141);
    expect(previewText({ text: "", attachments: [] })).toBe("");
  });
});

describe("a link's preview, as the client keeps it", () => {
  it("asks again for a page that didn't answer, and keeps no more than the last fifty", async () => {
    let asked = 0;
    const web = {
      fetch: async () => {
        asked++;
        throw new Error("offline");
      },
      shrinkImage: async () => null,
    };
    const client = new ZunaClient({ db: new MemoryDbProvider(), deviceKey: new Uint8Array(32).fill(5), deviceName: "Test", onEvent: () => undefined, web });
    await client.open();
    expect(await client.linkPreview("https://example.com/page")).toBeNull();
    expect(await client.linkPreview("https://example.com/page")).toBeNull();
    expect(asked).toBe(2);
    await Promise.all(Array.from({ length: 52 }, (_, index) => client.linkPreview(`https://example.com/${index}`)));
    expect((client as any).previews.size).toBeLessThanOrEqual(50);
    // Without a way to fetch pages, there are no previews.
    const without = new ZunaClient({ db: new MemoryDbProvider(), deviceKey: new Uint8Array(32).fill(6), deviceName: "Test", onEvent: () => undefined });
    expect(await without.linkPreview("https://example.com/page")).toBeNull();
    client.stop();
    without.stop();
  });
});

describe("a voice room's key slots", () => {
  it("retire a replaced epoch's slot once, after its time and not before, and never the current one", () => {
    const slots = new VoiceKeySlots();
    expect(slots.take(5, 0)).toEqual({ index: 5 });
    expect(slots.take(6, 1000)).toEqual({ index: 6, retireAt: 1000 + VOICE_OLD_KEY_MS });
    expect(slots.holds(5, 5) && slots.holds(6, 6)).toBe(true);
    expect(slots.due(VOICE_OLD_KEY_MS)).toEqual([]);
    expect(slots.holds(5, 5)).toBe(true);
    expect(slots.due(1000 + VOICE_OLD_KEY_MS)).toEqual([{ index: 5, epoch: 5 }]);
    expect(slots.free(5) && !slots.holds(5, 5)).toBe(true);
    // Once.
    expect(slots.due(10 * VOICE_OLD_KEY_MS)).toEqual([]);
    // The current one never is, however long it lasts.
    expect(slots.holds(6, 6) && !slots.free(6)).toBe(true);
    // An epoch heard again changes nothing.
    expect(slots.take(6, 2000)).toEqual({ index: 6 });
  });

  it("retire each epoch in turn when several come quickly, the one sent under last as late as any", () => {
    const slots = new VoiceKeySlots();
    slots.take(1, 0);
    slots.take(2, 100);
    slots.take(3, 200);
    expect(slots.due(100 + VOICE_OLD_KEY_MS - 1)).toEqual([]);
    expect(slots.due(100 + VOICE_OLD_KEY_MS)).toEqual([{ index: 1, epoch: 1 }]);
    expect(slots.due(200 + VOICE_OLD_KEY_MS)).toEqual([{ index: 2, epoch: 2 }]);
    expect(slots.holds(3, 3)).toBe(true);
    // A device that skipped epochs retires the last it held.
    expect(slots.take(9, 300)).toEqual({ index: 9, retireAt: 300 + VOICE_OLD_KEY_MS });
    expect(slots.due(300 + VOICE_OLD_KEY_MS)).toEqual([{ index: 3, epoch: 3 }]);
  });

  it("leave a slot the ring has come round to with a newer epoch's key", () => {
    const slots = new VoiceKeySlots();
    // A whole ring's worth of joins and leaves within the time: epoch 0's slot is epoch 16's by then.
    for (let epoch = 0; epoch <= VOICE_KEY_RING; epoch++) slots.take(epoch, epoch);
    expect(voiceKeyIndex(VOICE_KEY_RING)).toBe(0);
    const due = slots.due(VOICE_KEY_RING + VOICE_OLD_KEY_MS);
    expect(due.map(({ epoch }) => epoch)).toEqual([...Array(VOICE_KEY_RING - 1).keys()].map((epoch) => epoch + 1));
    expect(slots.holds(0, VOICE_KEY_RING)).toBe(true);
    // And when epoch 16 is replaced in turn, its slot is retired after its own time.
    expect(slots.take(VOICE_KEY_RING + 1, 100)).toEqual({ index: 1, retireAt: 100 + VOICE_OLD_KEY_MS });
    expect(slots.due(100 + VOICE_OLD_KEY_MS)).toEqual([{ index: 0, epoch: VOICE_KEY_RING }]);
    // Straight from epoch 3 to 19, the same slot: nothing older is left in it to retire.
    const skipping = new VoiceKeySlots();
    skipping.take(3, 0);
    expect(skipping.take(3 + VOICE_KEY_RING, 1)).toEqual({ index: 3 });
    expect(skipping.due(10 * VOICE_OLD_KEY_MS)).toEqual([]);
    expect(skipping.holds(3, 3 + VOICE_KEY_RING)).toBe(true);
  });

  it("keep an epoch a group was taken back to, and retire the one it was taken back from", () => {
    const slots = new VoiceKeySlots();
    slots.take(4, 0);
    slots.take(5, 10);
    // A commit nobody could apply is undone, and the group is back at 4.
    expect(slots.take(4, 20)).toEqual({ index: 4, retireAt: 20 + VOICE_OLD_KEY_MS });
    expect(slots.due(10 * VOICE_OLD_KEY_MS)).toEqual([{ index: 5, epoch: 5 }]);
    expect(slots.holds(4, 4)).toBe(true);
  });

  it("retire on a timer, which leaving the room cancels", () => {
    vi.useFakeTimers();
    try {
      const retired: [number, number][] = [];
      const retire = (index: number, epoch: number) => retired.push([index, epoch]);
      const slots = new VoiceKeySlots();
      slots.take(7, Date.now());
      const { retireAt } = slots.take(8, Date.now());
      slots.retireAt(retireAt!, Date.now(), retire);
      vi.advanceTimersByTime(VOICE_OLD_KEY_MS - 1);
      expect(retired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(retired).toEqual([[7, 7]]);
      const { retireAt: next } = slots.take(9, Date.now());
      slots.retireAt(next!, Date.now(), retire);
      slots.close();
      vi.advanceTimersByTime(10 * VOICE_OLD_KEY_MS);
      expect(retired).toEqual([[7, 7]]);
      // Nor does a slot replaced after leaving start a timer.
      slots.retireAt(slots.take(10, Date.now()).retireAt!, Date.now(), retire);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
