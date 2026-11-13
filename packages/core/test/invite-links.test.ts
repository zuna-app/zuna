// What an invite link, a bot's setup link or a server's address is read as (account.ts): every way
// one is written, what's carried after the #, and what isn't one. Only the last test reaches for a
// server, at an address where none answers.

import { beforeAll, describe, expect, it } from "vitest";
import { botSetupLink, inviteLink, parseInviteLink, parseServerAddress, previewInvite, type BotSetup } from "../src/account";
import { toBase64Url, utf8 } from "../src/encoding";
import { loadCrypto } from "./helpers";

beforeAll(loadCrypto);

const key = new Uint8Array(32).fill(9);
const bot = (change: Partial<BotSetup> = {}): BotSetup => ({
  id: "a".repeat(32),
  username: "weather_bot",
  name: "Weather",
  seed: new Uint8Array(32).fill(1),
  ownerId: "b".repeat(32),
  ownerKeyHash: new Uint8Array(32).fill(2),
  listed: false,
  add: "owner",
  ...change,
});
/** A setup link's `bot` part, as anyone could write it. */
const carried = (value: unknown) => `https://chat.example.com/invite/code#k=${toBase64Url(key)}&bot=${toBase64Url(utf8(JSON.stringify(value)))}`;
const fields = (change: Record<string, unknown> = {}) => ({ id: "a".repeat(32), u: "weather_bot", n: "Weather", s: toBase64Url(new Uint8Array(32)), o: "b".repeat(32), k: toBase64Url(new Uint8Array(32)), l: 0, a: "owner", ...change });

describe("an invite link", () => {
  it("reads from an address, a bare host, or an app's deep link, under any path the server is at", () => {
    const link = inviteLink("https://chat.example.com/zuna", "a b", key, undefined);
    expect(parseInviteLink(link)).toEqual({ url: "https://chat.example.com/zuna", code: "a b", communityKey: toBase64Url(key), pin: null, log: null, bot: null });
    expect(parseInviteLink("chat.example.com/invite/xyz/")).toMatchObject({ url: "https://chat.example.com", code: "xyz", communityKey: null });
    expect(parseInviteLink(`zuna://join?link=${encodeURIComponent(link)}`)).toMatchObject({ url: "https://chat.example.com/zuna", code: "a b" });
  });

  it("isn't one when it leads nowhere a server could be, or isn't an invite at all", () => {
    expect(parseInviteLink("zuna://join")).toBeNull();
    expect(parseInviteLink("zuna://%%%")).toBeNull();
    expect(parseInviteLink("zuna://[bad")).toBeNull();
    expect(parseInviteLink("https://chat.example.com/settings")).toBeNull();
    expect(parseInviteLink("https://[bad/invite/x")).toBeNull();
    // Plain HTTP only reaches this machine.
    expect(parseInviteLink("http://chat.example.com/invite/x")).toBeNull();
    expect(parseInviteLink("http://localhost:8787/invite/x")).toMatchObject({ url: "http://localhost:8787", code: "x" });
  });

  it("carries a bot's setup only when every part of it is what it should be", () => {
    const made = parseInviteLink(botSetupLink("https://chat.example.com", "code", key, undefined, bot({ listed: true, add: "anyone" })))!;
    expect(made.bot).toEqual(bot({ listed: true, add: "anyone" }));
    expect(parseInviteLink(carried(fields({ l: 1, a: "admins" })))!.bot?.add).toBe("admins");
    // Only a listed bot may be added by others.
    expect(parseInviteLink(carried(fields({ l: 0, a: "anyone" })))!.bot?.add).toBe("owner");
    expect(parseInviteLink(carried(fields({ l: 1, a: "everyone" })))!.bot?.add).toBe("owner");
    for (const broken of [fields({ id: "short" }), fields({ o: 5 }), fields({ u: 1 }), fields({ k: null }), fields({ s: toBase64Url(new Uint8Array(31)) }), fields({ k: toBase64Url(new Uint8Array(33)) })]) {
      expect(parseInviteLink(carried(broken))!.bot).toBeNull();
    }
    expect(parseInviteLink(`https://chat.example.com/invite/code#bot=${toBase64Url(utf8("not json"))}`)!.bot).toBeNull();
  });
});

describe("a server's address", () => {
  it("is an invite's server, or the address itself, and nothing that leads nowhere", () => {
    expect(parseServerAddress(inviteLink("https://chat.example.com", "c", key, undefined))).toEqual({ url: "https://chat.example.com", pin: null });
    expect(parseServerAddress("  chat.example.com/  ")).toEqual({ url: "https://chat.example.com", pin: null });
    expect(() => parseServerAddress("zuna://open")).toThrow("That doesn't look like a server's address.");
    expect(() => parseServerAddress("http://chat.example.com")).toThrow("Zuna servers must use HTTPS.");
    // A pin is only for a server reached by its IP address.
    expect(() => parseServerAddress(`chat.example.com#pin=${"A".repeat(43)}`)).toThrow("Only a server reached over HTTPS by its IP address");
  });

  it("previews nothing for an address no server answers at, or a bot's link", async () => {
    const pin = async () => undefined;
    await expect(previewInvite("http://[bad", pin)).rejects.toThrow("That doesn't look like a Zuna invite link.");
    await expect(previewInvite("http://127.0.0.1:9", pin)).rejects.toThrow("That doesn't look like a Zuna invite link.");
    await expect(previewInvite(botSetupLink("http://127.0.0.1:9", "code", key, undefined, bot()), pin)).rejects.toThrow("That link sets up a bot.");
  });
});
