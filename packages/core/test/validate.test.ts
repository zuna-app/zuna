// What other devices send, checked before anything shows it: for each kind of thing, one that's
// right, then each field of it wrong in each way it can be, which either fails the whole or is
// dropped from it, as the field's comment in validate.ts says.

import { describe, expect, it } from "vitest";
import {
  MAX_EXPIRES_IN,
  MAX_TEXT_LENGTH,
  parseAvatarRef,
  parseButtons,
  parseChannelDetails,
  parseCommands,
  parseEmoteRef,
  parseGroupDetails,
  parseMessageBody,
  parsePlay,
  parsePreferences,
  parseProfile,
  parseReaction,
  parseReadState,
  parseSoundDetails,
  parseSystemEvent,
  parseWatch,
} from "../src/validate";

const ID = "0123456789abcdef0123456789abcdef";
const THUMB = "data:image/png;base64,iVBORw0KGgo=";
const KEY32 = "A".repeat(43) + "=";
const LOG_SIG = "A".repeat(Math.ceil(3374 / 3) * 4 - 2) + "==";

/** `base` with one field changed, or taken away with undefined. */
function changed<T extends Record<string, unknown>>(base: T, field: string, value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...base };
  if (value === undefined) delete copy[field];
  else copy[field] = value;
  return copy;
}

/** Each change of base's fields must make parse refuse it. */
function refuses(parse: (value: unknown) => unknown, base: Record<string, unknown>, changes: [string, unknown][]) {
  for (const [field, value] of changes) {
    expect(parse(changed(base, field, value)), `${field} = ${JSON.stringify(value)?.slice(0, 40)}`).toBeNull();
  }
}

const attachment = { fileId: "abc123", key: "AAAA", prefix: "AAAA", chunks: 1, name: "a.txt", mime: "text/plain", size: 3 };
const avatar = { fileId: "abc123", key: "AAAA", prefix: "AAAA", chunks: 1, mime: "image/png" };

describe("pieces of a message", () => {
  it("takes an emote that's one, with what it may say about itself", () => {
    expect(parseEmoteRef({ id: "Kappa_1", animated: true, zeroWidth: true, owner: "someone" })).toEqual({ id: "Kappa_1", animated: true, zeroWidth: true, owner: "someone" });
    expect(parseEmoteRef({ id: "Kappa", animated: "yes", zeroWidth: 1, owner: 5 })).toEqual({ id: "Kappa" });
    for (const value of [null, [], "Kappa", { id: 5 }, { id: "x".repeat(65) }, { id: "bad id!" }]) expect(parseEmoteRef(value)).toBeNull();
  });

  it("takes a picture of someone that's one", () => {
    expect(parseAvatarRef(avatar)).toEqual(avatar);
    expect(parseAvatarRef("avatar")).toBeNull();
    refuses(parseAvatarRef, avatar, [
      ["fileId", 5],
      ["fileId", "XYZ"],
      ["fileId", ""],
      ["key", 5],
      ["key", "not base64!"],
      ["prefix", 5],
      ["prefix", "not base64!"],
      ["chunks", -1],
      ["chunks", 1.5],
      ["mime", 5],
    ]);
  });

  it("takes buttons that all open a link or send data back, and nothing if any doesn't", () => {
    expect(parseButtons([[{ text: " Go ", url: "https://example.com/a b" }, { text: "Yes", data: "y" }]])).toEqual([[{ text: "Go", url: "https://example.com/a%20b" }, { text: "Yes", data: "y" }]]);
    for (const value of [
      undefined,
      [],
      "rows",
      Array.from({ length: 26 }, () => [{ text: "x", data: "x" }]),
      ["row"],
      [[]],
      [Array.from({ length: 9 }, () => ({ text: "x", data: "x" }))],
      [["button"]],
      [[{ text: 5, data: "x" }]],
      [[{ text: "  ", data: "x" }]],
      [[{ text: "x", url: "javascript:alert(1)" }]],
      [[{ text: "x", url: "https://" }]],
      [[{ text: "x", url: 5 }]],
      [[{ text: "x" }]],
      [[{ text: "x", data: "d".repeat(257) }]],
    ]) {
      expect(parseButtons(value)).toBeUndefined();
    }
  });

  it("takes a bot's commands only if they're all commands", () => {
    expect(parseCommands([{ command: "start", description: "Begin" }])).toEqual([{ command: "start", description: "Begin" }]);
    for (const value of ["start", Array.from({ length: 101 }, () => ({ command: "a", description: "b" })), [null], [{ command: "Start", description: "x" }], [{ command: 5, description: "x" }], [{ command: "a", description: 5 }]]) {
      expect(parseCommands(value)).toBeUndefined();
    }
  });
});

describe("a message body", () => {
  it("keeps everything that's right", () => {
    const body = {
      text: "hello",
      replyTo: ID,
      emotes: { Kappa: { id: "Kappa" } },
      attachments: [{ ...attachment, width: 10, height: 20, thumb: THUMB, duration: 1.5, voice: true, waveform: "AAAA", share: KEY32 }],
      mentions: ["u1"],
      forwarded: { userId: "u2" },
      sentAt: 123,
      revision: 2,
      after: { id: ID, epoch: 3, at: 456, expiresIn: 60 },
      expiresIn: 60,
      location: { lat: 1, lon: 2, accuracy: 5 },
      buttons: [[{ text: "Go", data: "g" }]],
      tokenKeys: { p: 7, h: "0123456789abcdef" },
      log: { e: 1, n: 2, r: KEY32, s: LOG_SIG },
      signal: { type: "button", message: ID, data: "pressed" },
    };
    const parsed = parseMessageBody(body)!;
    expect(parsed).toMatchObject({ text: "hello", replyTo: ID, mentions: ["u1"], forwarded: { userId: "u2" }, sentAt: 123, revision: 2, expiresIn: 60, location: { lat: 1, lon: 2, accuracy: 5 } });
    expect(parsed.attachments![0]).toMatchObject({ width: 10, height: 20, thumb: THUMB, duration: 1.5, voice: true, waveform: "AAAA", share: KEY32 });
    expect(parsed.after).toEqual({ id: ID, epoch: 3, at: 456, expiresIn: 60 });
    expect(parsed.tokenKeys).toEqual({ p: 7, h: "0123456789abcdef" });
    expect(parsed.log).toEqual({ e: 1, n: 2, r: KEY32, s: LOG_SIG });
    expect(parsed.signal).toEqual({ type: "button", message: ID, data: "pressed" });
  });

  it("refuses one that can't be shown", () => {
    for (const value of [null, [], "text"]) expect(parseMessageBody(value)).toBeNull();
    refuses(parseMessageBody, { text: "hi" }, [
      ["text", 5],
      ["text", "x".repeat(MAX_TEXT_LENGTH + 1)],
      ["replyTo", 5],
      ["emotes", []],
      ["emotes", Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`e${i}`, { id: "e" }]))],
      ["emotes", { Kappa: { id: "bad id!" } }],
      ["emotes", { ["x".repeat(1025)]: { id: "e" } }],
      ["attachments", "files"],
      ["attachments", Array.from({ length: 33 }, () => attachment)],
      ["attachments", [null]],
      ["mentions", "u1"],
      ["mentions", Array.from({ length: 2001 }, () => "u")],
      ["mentions", [5]],
      ["location", { lat: "1", lon: 2 }],
      ["location", { lat: 1, lon: Infinity }],
      ["location", { lat: 91, lon: 0 }],
      ["location", { lat: 0, lon: 181 }],
      ["location", "here"],
      ["signal", { type: "unknown" }],
      ["signal", { type: "button", message: "short", data: "x" }],
      ["signal", { type: "button", message: ID, data: 5 }],
      ["signal", "go"],
    ]);
  });

  it("drops what it needn't trust instead of failing the message", () => {
    const parsed = parseMessageBody({
      text: "hi",
      replyTo: "not an id",
      forwarded: "someone",
      sentAt: Infinity,
      revision: -1,
      after: { id: ID, epoch: 1, at: Infinity },
      expiresIn: MAX_EXPIRES_IN + 1,
      buttons: [[{ text: "x" }]],
      tokenKeys: { p: 1, h: "short" },
      log: { e: 0, n: 1, r: KEY32, s: LOG_SIG },
    })!;
    expect(parsed).toEqual({ text: "hi" });
    expect(parseMessageBody({ forwarded: { userId: 5 } })).toEqual({ forwarded: {} });
    expect(parseMessageBody({ after: "x" })).toEqual({});
    expect(parseMessageBody({ after: { id: ID, epoch: -1, at: 1 } })).toEqual({});
    expect(parseMessageBody({ after: { id: "x", epoch: 1, at: 1 } })).toEqual({});
    expect(parseMessageBody({ after: { id: ID, epoch: 1, at: 1, expiresIn: 0 } })).toEqual({ after: { id: ID, epoch: 1, at: 1 } });
    expect(parseMessageBody({ location: { lat: 1, lon: 2, accuracy: -1 } })).toEqual({ location: { lat: 1, lon: 2 } });
    expect(parseMessageBody({ tokenKeys: "x", log: "x" })).toEqual({});
    expect(parseMessageBody({ log: { e: 1, n: -1, r: KEY32, s: LOG_SIG } })).toEqual({});
    expect(parseMessageBody({ log: { e: 1, n: 1, r: "short", s: LOG_SIG } })).toEqual({});
    expect(parseMessageBody({ log: { e: 1, n: 1, r: KEY32, s: 5 } })).toEqual({});
  });

  it("takes only attachments it can fetch, with only what's sensible about them", () => {
    const one = (change: Record<string, unknown>) => parseMessageBody({ attachments: [{ ...attachment, ...change }] })?.attachments?.[0] ?? null;
    expect(one({ mime: "" })?.mime).toBe("application/octet-stream");
    expect(one({ width: 10 })?.width).toBeUndefined();
    expect(one({ width: 0, height: 10 })?.width).toBeUndefined();
    expect(one({ thumb: "https://evil.example/x.png" })?.thumb).toBeUndefined();
    expect(one({ duration: -1 })?.duration).toBeUndefined();
    expect(one({ duration: Infinity })?.duration).toBeUndefined();
    expect(one({ round: true })?.round).toBeUndefined();
    expect(one({ round: true, mime: "video/mp4" })?.round).toBe(true);
    expect(one({ waveform: "not base64!" })?.waveform).toBeUndefined();
    expect(one({ share: "short" })?.share).toBeUndefined();
    const parse = (value: unknown) => parseMessageBody({ attachments: [value] });
    refuses(parse, attachment, [
      ["fileId", 5],
      ["fileId", "XYZ"],
      ["key", 5],
      ["key", "not base64!"],
      ["prefix", 5],
      ["prefix", "not base64!"],
      ["chunks", 1.5],
      ["name", 5],
      ["mime", 5],
      ["mime", "not a type"],
      ["size", -1],
    ]);
  });

  it("takes a bot's settings, as its owner sent them", () => {
    expect(parseMessageBody({ signal: { type: "bot_settings", listed: true, add: "anyone", profile: { displayName: "Bot", bio: "Hi", avatar: null } } })?.signal).toEqual({ type: "bot_settings", listed: true, add: "anyone", profile: { displayName: "Bot", bio: "Hi", avatar: null } });
    expect(parseMessageBody({ signal: { type: "bot_settings", listed: "yes", add: "everyone", profile: { displayName: 5, bio: 5, avatar: avatar } } })?.signal).toEqual({ type: "bot_settings", profile: { avatar } });
    expect(parseMessageBody({ signal: { type: "bot_settings", profile: { avatar: "x" } } })?.signal).toEqual({ type: "bot_settings", profile: {} });
    expect(parseMessageBody({ signal: { type: "bot_settings" } })?.signal).toEqual({ type: "bot_settings" });
  });
});

describe("what a device keeps or is told of", () => {
  it("reads back only notices it could have written", () => {
    expect(parseSystemEvent({ type: "member_added", actorId: "a", targetIds: ["b", 5], seconds: 60 })).toEqual({ type: "member_added", actorId: "a", targetIds: ["b"], seconds: 60 });
    expect(parseSystemEvent({ type: "timer_changed", actorId: 5, seconds: -1 })).toEqual({ type: "timer_changed" });
    for (const value of [null, { type: 5 }, { type: "made_up" }]) expect(parseSystemEvent(value)).toBeNull();
  });

  it("takes a profile that's one", () => {
    expect(parseProfile({ displayName: "Ann", bio: "hi", avatar: null, commands: [{ command: "go", description: "Go" }] })).toEqual({ displayName: "Ann", bio: "hi", avatar: null, commands: [{ command: "go", description: "Go" }] });
    expect(parseProfile({ displayName: "Ann", avatar: avatar, commands: [] })).toEqual({ displayName: "Ann", avatar });
    refuses(parseProfile, { displayName: "Ann" }, [
      ["displayName", 5],
      ["bio", 5],
      ["avatar", "x"],
    ]);
    expect(parseProfile(null)).toBeNull();
  });

  it("takes a group's details that are those", () => {
    expect(parseGroupDetails({ name: "G", description: "d", avatar: null, historyVisible: true, disappearAfter: 60 })).toEqual({ name: "G", description: "d", avatar: null, historyVisible: true, disappearAfter: 60 });
    expect(parseGroupDetails({ avatar, historyVisible: "yes", disappearAfter: -1 })).toEqual({ avatar });
    refuses(parseGroupDetails, {}, [
      ["name", 5],
      ["description", 5],
      ["avatar", "x"],
    ]);
    expect(parseGroupDetails([])).toBeNull();
  });

  it("takes a soundboard's sound that's one", () => {
    const sound = { name: " Boom ", emoji: "💥", durationMs: 1000, file: { fileId: ID, key: "AAAA", prefix: "AAAA", chunks: 1 } };
    expect(parseSoundDetails(sound)).toEqual({ name: "Boom", emoji: "💥", durationMs: 1000, file: sound.file });
    expect(parseSoundDetails({ ...sound, emoji: undefined })?.emoji).toBe("");
    refuses(parseSoundDetails, sound, [
      ["name", 5],
      ["name", "   "],
      ["durationMs", 0],
      ["durationMs", 6000],
      ["emoji", 5],
      ["file", "f"],
      ["file", { ...sound.file, fileId: "short" }],
      ["file", { ...sound.file, key: "not base64!" }],
      ["file", { ...sound.file, prefix: 5 }],
      ["file", { ...sound.file, chunks: 2 }],
    ]);
    expect(parseSoundDetails(null)).toBeNull();
  });

  it("takes a sound played that says what and when", () => {
    const play = { sound: ID, user: "u", at: 1, nonce: "n" };
    expect(parsePlay(play)).toEqual(play);
    refuses(parsePlay, play, [
      ["sound", "short"],
      ["user", 5],
      ["at", Infinity],
      ["nonce", ""],
    ]);
  });

  it("takes a channel's details that are those", () => {
    expect(parseChannelDetails({ name: " General ", topic: "t", category: " Talk ", bitrate: 64 })).toEqual({ name: "General", topic: "t", category: "Talk", bitrate: 64 });
    expect(parseChannelDetails({ name: "Voice", bitrate: 4 })).toEqual({ name: "Voice" });
    refuses(parseChannelDetails, { name: "General" }, [
      ["name", 5],
      ["name", "  "],
      ["topic", 5],
      ["category", 5],
    ]);
  });

  it("takes a reaction, a read state and preferences only as they are", () => {
    expect(parseReaction({ key: "👍" })).toEqual({ key: "👍" });
    expect(parseReaction({ key: "Kappa", emote: { id: "Kappa" } })).toEqual({ key: "Kappa", emote: { id: "Kappa" } });
    for (const value of [null, { key: 5 }, { key: "" }, { key: "x", emote: { id: "bad id!" } }]) expect(parseReaction(value)).toBeNull();
    expect(parseReadState({ seq: 5 })).toBe(5);
    expect(parseReadState({ seq: -1 })).toBeNull();
    expect(parsePreferences("prefs")).toEqual({});
    expect(
      parsePreferences({ pinned: ["a"], hidden: ["b"], muted: ["c"], mutedUntil: { d: 5, e: "no" }, markedUnread: ["f"], mentionsOnly: ["g"], blocked: ["h"], sendReadReceipts: false, reported: ["i"] }),
    ).toEqual({ pinned: ["a"], hidden: ["b"], muted: ["c"], mutedUntil: { d: 5 }, markedUnread: ["f"], mentionsOnly: ["g"], blocked: ["h"], sendReadReceipts: false, reported: ["i"] });
    expect(parsePreferences({ pinned: [5], sendReadReceipts: "yes" })).toEqual({});
  });
});

describe("what a room watches", () => {
  const video = { id: "aqz-KE-bpKQ", by: "u", title: "  A   video ", author: "Someone", image: { data: THUMB, width: 320, height: 180 } };
  const state = { session: ID, rev: 1, video, playing: true, position: 1000, at: 5, rate: 1, user: "u", device: "d" };
  const signal = (s: unknown) => ({ kind: "state", sent: 1, nonce: "n", state: s });

  it("takes a state and an ask that make sense", () => {
    const parsed = parseWatch(signal(state));
    expect(parsed).toMatchObject({ kind: "state", state: { video: { id: "aqz-KE-bpKQ", title: "A video", author: "Someone", image: video.image }, playing: true, position: 1000 } });
    expect(parseWatch(signal({ ...state, video: null }))).toMatchObject({ state: { video: null, playing: false, position: 0 } });
    expect(parseWatch(signal({ ...state, video: { ...video, title: " ", author: 5, image: { data: THUMB, width: 0, height: 1 } } }))?.kind).toBe("state");
    expect(parseWatch({ kind: "ask", sent: 1, nonce: "n" })).toEqual({ kind: "ask", sent: 1, nonce: "n" });
    expect(parseWatch({ kind: "ask", sent: 1, nonce: "n", have: { session: ID, rev: 2 } })).toEqual({ kind: "ask", sent: 1, nonce: "n", have: { session: ID, rev: 2 } });
  });

  it("refuses what makes no sense", () => {
    for (const value of [null, { kind: "ask", sent: "1", nonce: "n" }, { kind: "ask", sent: 1, nonce: "" }, { kind: "ask", sent: 1, nonce: "n", have: { session: "x", rev: 1 } }, { kind: "ask", sent: 1, nonce: "n", have: { session: ID, rev: 0 } }, { kind: "other", sent: 1, nonce: "n" }]) {
      expect(parseWatch(value)).toBeNull();
    }
    refuses((s) => parseWatch(signal(s)), state, [
      ["session", "short"],
      ["rev", 0],
      ["rev", 1.5],
      ["playing", "yes"],
      ["at", Infinity],
      ["position", -1],
      ["position", 32 * 24 * 60 * 60_000],
      ["rate", 3],
      ["user", ""],
      ["device", 5],
      ["video", { ...video, id: "short" }],
      ["video", { ...video, by: "" }],
      ["video", "v"],
    ]);
    expect(parseWatch(signal("state"))).toBeNull();
  });
});
