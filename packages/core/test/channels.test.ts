// Channels and voice keys, end to end through a real server: anyone on the server
// sees a channel and comes into it by themselves, what it's called and what's said
// there stays out of the server's hands, and who can hear a voice channel is exactly
// who's in its MLS group.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, decode } from "../src/api";
import { channelProof, openChannelDetails, sealChannelDetails } from "../src/channels";
import { previewPush } from "../src/push";
import { equalBytes, fromUtf8, toBase64, utf8 } from "../src/encoding";
import type { ChannelView, CoreEvent, MessageView } from "../src/types";
import { DEFAULT_SCREEN_RULES, parseVoiceIdentity, screenRefusal, screenTerms, voiceIdentity, voiceKeyIndex, voiceSenderKey } from "../src/voice";
import { loadCrypto, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let invite = "";

const channel = (app: TestApp, name: string): ChannelView | undefined => app.session.getChannels().find((item) => item.name === name);
const joined = (app: TestApp, id: string) => !!app.session.getChannels().find((item) => item.id === id)?.conversation?.ready;
const received = (app: TestApp, text: string): MessageView | undefined =>
  app.events
    .filter((event): event is Extract<CoreEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message)
    .filter((message) => message.text === text && message.status === "sent")
    .at(-1);
const makeUser = async (name: string): Promise<TestApp> => {
  const app = await new TestApp(name).open();
  await app.register(invite, name);
  return app;
};

beforeAll(async () => {
  loadCrypto();
  server = new TestServer({ liveKit: "wss://voice.invalid" });
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  invite = await alice.session.createInvite(0, 0);
  bob = await makeUser("bob");
  await waitFor(() => alice.session.getUsers().length === 2, "alice to see bob");
});

afterAll(async () => {
  for (const app of [alice, bob]) app?.client.stop();
  await server?.stop();
});

describe("text channels", () => {
  it("are seen by everyone and joined without anyone doing anything", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "general", topic: "Anything goes" });
    await waitFor(() => joined(bob, id), "bob to come into the channel");
    const seen = channel(bob, "general")!;
    expect(seen).toMatchObject({ type: "text", topic: "Anything goes", key: `group:${id}`, unreadable: false });
    // It isn't one of the chats listed for an app that doesn't know about channels.
    expect(bob.session.getConversations().some((item) => item.groupId === id)).toBe(false);

    alice.session.sendMessage(`group:${id}`, { text: "hello channel" });
    await waitFor(() => !!received(bob, "hello channel"), "bob to read it");
    bob.session.sendMessage(`group:${id}`, { text: "hello back" });
    await waitFor(() => !!received(alice, "hello back"), "alice to read it");
    expect(channel(alice, "general")!.conversation!.unread).toBeGreaterThan(0);
  });

  it("keep what they're called from the server", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "plans-for-the-secret-thing" });
    const api = new Api(server.url);
    api.token = (bob.session as unknown as { account: { token: string } }).account.token;
    const { channels } = await api.channels();
    const sealed = channels.find((item) => item.id === id)!;
    expect(fromUtf8(decode(sealed.details)).includes("secret")).toBe(false);

    // Another channel's details can't be passed off as this one's.
    const communityKey = (bob.session as unknown as { account: { core: { communityKey: Uint8Array } } }).account.core.communityKey;
    expect(openChannelDetails(communityKey, id, decode(sealed.details))).not.toBeNull();
    const otherId = channel(bob, "general")?.id ?? "";
    expect(openChannelDetails(communityKey, otherId, decode(sealed.details))).toBeNull();
  });

  it("give newcomers their history, from whichever member is around", async () => {
    const id = channel(alice, "general")!.id;
    alice.session.sendMessage(`group:${id}`, { text: "before carol came" });
    await waitFor(() => !!received(bob, "before carol came"), "bob to read it");

    const carol = await makeUser("carol");
    try {
      await waitFor(() => joined(carol, id), "carol to come into the channel");
      await waitFor(async () => (await carol.session.loadMessages(id)).messages.some((item) => item.text === "before carol came" && item.status === "sent"), "carol to read what came before her");
    } finally {
      carol.client.stop();
    }
  });

  it("say nothing each time someone comes or goes", async () => {
    const id = channel(alice, "general")!.id;
    const { messages } = await alice.session.loadMessages(id);
    expect(messages.filter((item) => item.system)).toEqual([]);
  });

  it("only notify someone about what's said to them", async () => {
    const id = channel(alice, "general")!.id;
    const notified = () => alice.events.filter((event) => event.type === "notify" && event.groupId === id);
    const before = notified().length;
    bob.session.sendMessage(`group:${id}`, { text: "nothing for alice" });
    await waitFor(() => !!received(alice, "nothing for alice"), "alice to get it");
    expect(notified().length).toBe(before);
    bob.session.sendMessage(`group:${id}`, { text: "@alice look", mentions: [alice.userId] });
    await waitFor(() => notified().length === before + 1, "alice to be told");
    expect(notified().at(-1)).toMatchObject({ title: "#general" });
    expect(channel(alice, "general")!.conversation!.unreadMentions).toBeGreaterThan(0);

    // A phone words them the same way, from what's on it alone.
    const extension = { db: alice.db, deviceKey: alice.deviceKey };
    const preview = (text: string) => previewPush(extension, alice.serverId, id, received(alice, text)!.id);
    expect(await preview("@alice look")).toMatchObject({ title: "#general", body: "bob: @alice look", muted: false, group: { name: "#general" } });
    expect(await preview("nothing for alice")).toMatchObject({ title: "#general", muted: true });
  });

  it("keep where someone's read to between their own devices only", async () => {
    const id = channel(alice, "general")!.id;
    const { messages } = await bob.session.loadMessages(id);
    const newest = messages.filter((item) => item.seq !== null).at(-1)!;
    await bob.session.markRead(id, newest.seq!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(channel(alice, "general")!.conversation!.readBy[bob.userId]).toBeUndefined();
    expect(channel(bob, "general")!.conversation!.ownRead).toBe(newest.seq);
  });

  it("let admins moderate, change and reorder them, and nobody else", async () => {
    const id = channel(alice, "general")!.id;
    await alice.session.updateChannel(id, { name: "lounge", topic: "New topic", category: "Chat" });
    await waitFor(() => channel(bob, "lounge")?.topic === "New topic", "bob to see the new name");
    expect(channel(bob, "lounge")!.category).toBe("Chat");
    await alice.session.updateChannel(id, { name: "general" });
    await waitFor(() => !!channel(bob, "general"), "bob to see the old name again");

    await expect(bob.session.createChannel({ type: "text", name: "mine" })).rejects.toThrow();
    await expect(bob.session.updateChannel(id, { name: "hijacked" })).rejects.toThrow();
    await expect(bob.session.deleteChannel(id)).rejects.toThrow();

    // An admin can take down someone's message, and everyone believes it.
    bob.session.sendMessage(`group:${id}`, { text: "delete me" });
    await waitFor(() => !!received(alice, "delete me"), "alice to get it");
    await alice.session.deleteMessage(id, received(alice, "delete me")!.id);
    await waitFor(() => bob.events.some((event) => event.type === "message" && event.message.id === received(alice, "delete me")?.id && event.message.deletedAt !== null), "bob to see it gone");
  });

  it("hold each person back in slow mode, but not admins, sending what waited once it may go", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "slow" });
    const key = `group:${id}`;
    await waitFor(() => joined(bob, id), "bob to come into the channel");
    const conversation = (app: TestApp) => channel(app, "slow")!.conversation!;
    expect(channel(bob, "slow")!.slowMode).toBe(0);
    await expect(bob.session.updateChannel(id, { slowMode: 2 })).rejects.toThrow();
    await alice.session.updateChannel(id, { slowMode: 2 });
    await waitFor(() => channel(bob, "slow")?.slowMode === 2, "bob to see slow mode on");
    expect(conversation(bob)).toMatchObject({ slowMode: 2, slowUntil: 0 });

    // The wait shows as soon as a message is on its way.
    bob.session.sendMessage(key, { text: "slow first" });
    expect(conversation(bob).slowUntil).toBeGreaterThan(Date.now() + 1500);
    await waitFor(() => !!received(alice, "slow first"), "alice to get the first");

    // One sent anyway waits, for this chat alone, and goes by itself once it may.
    const sentAt = Date.now();
    bob.session.sendMessage(key, { text: "slow second" });
    bob.session.sendMessage(`user:${alice.userId}`, { text: "not held back" });
    await waitFor(() => !!received(alice, "not held back"), "a direct message to go meanwhile");
    expect(received(alice, "slow second")).toBeUndefined();
    await waitFor(() => !!received(alice, "slow second"), "the second to go after the wait");
    expect(Date.now() - sentAt).toBeGreaterThan(1000);
    expect(received(bob, "slow second")).toBeDefined();
    expect(conversation(bob).slowUntil).toBeGreaterThan(Date.now());

    // Admins aren't held back.
    alice.session.sendMessage(key, { text: "admin one" });
    alice.session.sendMessage(key, { text: "admin two" });
    expect(conversation(alice).slowUntil).toBe(0);
    await waitFor(() => !!received(bob, "admin two"), "bob to get both of alice's");

    // Off again, nothing waits.
    await alice.session.updateChannel(id, { slowMode: 0 });
    await waitFor(() => channel(bob, "slow")?.slowMode === 0, "bob to see slow mode off");
    expect(conversation(bob).slowUntil).toBe(0);
  });

  it("refuse an older copy of their details", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "versioned" });
    await waitFor(() => joined(bob, id), "bob to come in");
    const api = new Api(server.url);
    api.token = (alice.session as unknown as { account: { token: string } }).account.token;
    const before = (await api.channels()).channels.find((item) => item.id === id)!.details;
    await alice.session.updateChannel(id, { name: "versioned-two" });
    await waitFor(() => !!channel(bob, "versioned-two"), "bob to see the new name");
    await (api as unknown as { prove: unknown }).prove;
    // What the server might do: go back to what it had before.
    (alice.session as unknown as { applyChannels(list: unknown[]): void }).applyChannels(
      alice.session.getChannels().map((item) => ({ id: item.id, type: item.type, position: item.position, user_limit: item.userLimit, details: item.id === id ? before : toBase64(utf8("")), created_by: "", created_at: 0 })),
    );
    expect(channel(alice, "versioned-two")).toBeDefined();
  });

  it("disappear when they're deleted, though what was said stays until it's cleared", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "short-lived" });
    await waitFor(() => joined(bob, id), "bob to come in");
    await alice.session.deleteChannel(id);
    await waitFor(() => !bob.session.getChannels().some((item) => item.id === id), "bob to see it gone");
    expect(bob.session.getConversations().some((item) => item.groupId === id)).toBe(false);
  });

  it("are left out by an app that doesn't show them", async () => {
    const id = channel(alice, "general")!.id;
    const phone = await new TestApp("phone");
    phone.channels = false;
    await phone.open();
    await phone.login(server.url, "bob");
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(phone.session.getChannels()).toEqual([]);
      expect(phone.session.getConversations().some((item) => item.groupId === id)).toBe(false);
      const tree = (bob.session as unknown as { treeMembers(group: string): { deviceId: string }[] }).treeMembers(id);
      expect(tree.some((leaf) => leaf.deviceId === phone.session.getSelf().deviceId)).toBe(false);
    } finally {
      phone.client.stop();
    }
  });
});

describe("who can be in a channel", () => {
  it("doesn't include someone without the community key, whatever the server says", async () => {
    const id = await alice.session.createChannel({ type: "text", name: "members-only" });
    await waitFor(() => joined(bob, id), "bob to come in");

    // What a server's own made-up account can do: it has no community key, so it makes one up.
    const url = new URL(invite);
    const stranger = await new TestApp("stranger").open();
    await stranger.register(`${url.origin}${url.pathname}#k=${"A".repeat(43)}`, "stranger");
    try {
      await waitFor(() => stranger.session.getChannels().length > 0, "the stranger to see the channels");
      const key = (alice.session as unknown as { account: { core: { communityKey: Uint8Array } } }).account.core.communityKey;
      // It can't read what any channel is called.
      expect(stranger.session.getChannels().every((item) => item.unreadable && item.name === "")).toBe(true);
      expect(equalBytes(channelProof(key, id, stranger.userId), channelProof((stranger.session as unknown as { account: { core: { communityKey: Uint8Array } } }).account.core.communityKey, id, stranger.userId))).toBe(false);

      // An honest app with the wrong key stays out of them.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(stranger.session.getChannels().every((item) => item.conversation === null)).toBe(true);

      // One that isn't honest gets in by itself, which members see, and they take it straight back out.
      const tree = (app: TestApp) => (app.session as unknown as { treeUsers(group: string): string[] }).treeUsers(id);
      await (stranger.session as unknown as { joinChannel(group: string): Promise<void> }).joinChannel(id);
      stranger.client.stop();
      await waitFor(() => tree(alice).includes(stranger.userId) || tree(bob).includes(stranger.userId), "its commit to reach members", 5000).catch(() => undefined);
      await waitFor(() => !tree(bob).includes(stranger.userId) && !tree(alice).includes(stranger.userId), "members to remove the stranger", 15_000);
      // It wasn't listed as a member all along.
      const members = alice.session.getChannels().find((item) => item.id === id)!.conversation!.members;
      expect(members.some((member) => member.userId === stranger.userId)).toBe(false);
    } finally {
      stranger.client.stop();
    }
  });

  it("doesn't include someone banned from the server", async () => {
    const id = channel(alice, "general")!.id;
    const dave = await makeUser("dave");
    try {
      await waitFor(() => joined(dave, id), "dave to come in");
      const tree = () => (alice.session as unknown as { treeUsers(group: string): string[] }).treeUsers(id);
      await waitFor(() => tree().includes(dave.userId), "alice to see dave in the channel");
      await alice.session.banUser(dave.userId);
      await waitFor(() => !tree().includes(dave.userId), "dave's keys to be taken back", 15_000);
    } finally {
      dave.client.stop();
    }
  });
});

describe("what a screen share uses", () => {
  const nothing = { height: null, fps: null, kbps: null, soundKbps: 128 };
  const limits = { ...DEFAULT_SCREEN_RULES, max_height: 1080, max_fps: 30, max_kbps: 8000, max_sound_kbps: 96, default_height: 720, default_fps: 24, default_kbps: 4000 };

  it("is what the server suggests until someone chooses", () => {
    expect(screenTerms(nothing, undefined, "member")).toEqual({ height: 0, fps: 60, kbps: 20_000, soundKbps: 128, sound: true, held: [] });
    expect(screenTerms(nothing, { ...limits, max_sound_kbps: 0 }, "member")).toEqual({ height: 720, fps: 24, kbps: 4000, soundKbps: 128, sound: true, held: [] });
  });

  it("goes by what someone chose, as far as the limits allow", () => {
    expect(screenTerms({ height: 480, fps: 15, kbps: 2000, soundKbps: 64 }, limits, "member")).toMatchObject({ height: 480, fps: 15, kbps: 2000, soundKbps: 64, held: [] });
    const over = screenTerms({ height: 2160, fps: 144, kbps: 50_000, soundKbps: 320 }, limits, "member");
    expect(over).toMatchObject({ height: 1080, fps: 30, kbps: 8000, soundKbps: 96 });
    expect(over.held.sort()).toEqual(["fps", "height", "kbps", "soundKbps"]);
  });

  it("counts the screen's own size as over a limit on size", () => {
    expect(screenTerms({ ...nothing, height: 0 }, limits, "member")).toMatchObject({ height: 1080, held: expect.arrayContaining(["height"]) });
    expect(screenTerms({ ...nothing, height: 0 }, undefined, "member")).toMatchObject({ height: 0, held: [] });
  });

  it("leaves admins out of the limits only if the server says so", () => {
    const wanted = { height: 0, fps: 144, kbps: 50_000, soundKbps: 320 };
    expect(screenTerms(wanted, limits, "admin").held).toHaveLength(4);
    const exempt = { ...limits, admins_exempt: true };
    expect(screenTerms(wanted, exempt, "owner")).toMatchObject({ height: 0, fps: 144, kbps: 50_000, soundKbps: 320, held: [] });
    expect(screenTerms(wanted, exempt, "admin").held).toEqual([]);
    expect(screenTerms(wanted, exempt, "member").held).toHaveLength(4);
  });

  it("says why someone can't share at all", () => {
    expect(screenRefusal(undefined, "member")).toBeNull();
    expect(screenRefusal({ ...DEFAULT_SCREEN_RULES, who: "nobody", admins_exempt: true }, "owner")).toContain("off on this server");
    expect(screenRefusal({ ...DEFAULT_SCREEN_RULES, who: "admins" }, "member")).toContain("Only admins");
    expect(screenRefusal({ ...DEFAULT_SCREEN_RULES, who: "admins" }, "admin")).toBeNull();
    expect(screenRefusal(undefined, "owner", -1)).toContain("off in this voice channel");
    expect(screenRefusal(undefined, "member", 2)).toBeNull();
  });
});

describe("voice channels", () => {
  let id = "";
  const voiceEvents = (app: TestApp) => app.events.filter((event) => event.type === "voice_key" && event.channelId === id).length;

  beforeAll(async () => {
    id = await alice.session.createChannel({ type: "voice", name: "Lounge", bitrate: 96, userLimit: 10 });
    await waitFor(() => joined(bob, id), "bob to come in");
  });

  it("give everyone in them the same key, which nobody else can work out", async () => {
    const [a, b] = await Promise.all([alice.session.voiceKey(id), bob.session.voiceKey(id)]);
    expect(a.epoch).toBe(b.epoch);
    expect(equalBytes(a.key, b.key)).toBe(true);
    expect(a.key.length).toBe(32);
    // It isn't the key to the channel's messages, which a vault or a grant would give away.
    const contentKeys = Object.values((alice.session as unknown as { allEpochKeys(group: string): Record<number, string> }).allEpochKeys(id));
    expect(contentKeys).not.toContain(toBase64(a.key));
    expect(voiceKeyIndex(a.epoch)).toBeLessThan(16);
  });

  it("give each sender a key of their own, bound to who they are in the room", async () => {
    const { key } = await alice.session.voiceKey(id);
    const aliceSelf = alice.session.getSelf();
    const bobSelf = bob.session.getSelf();
    const a = new Uint8Array(await voiceSenderKey(key, voiceIdentity(aliceSelf.userId, aliceSelf.deviceId)));
    const b = new Uint8Array(await voiceSenderKey(key, voiceIdentity(bobSelf.userId, bobSelf.deviceId)));
    expect(a.length).toBe(32);
    expect(equalBytes(a, b)).toBe(false);
    expect(equalBytes(a, key)).toBe(false);
    const screen = new Uint8Array(await voiceSenderKey(key, `${voiceIdentity(aliceSelf.userId, aliceSelf.deviceId)}.screen`));
    expect(equalBytes(a, screen)).toBe(false);
  });

  it("know who's a participant", () => {
    const user = "a".repeat(32);
    const device = "b".repeat(32);
    expect(parseVoiceIdentity(`${user}.${device}`)).toEqual({ userId: user, deviceId: device, screen: false });
    expect(parseVoiceIdentity(`${user}.${device}.screen`)).toEqual({ userId: user, deviceId: device, screen: true });
    expect(parseVoiceIdentity("someone")).toBeNull();
    expect(parseVoiceIdentity(`${user}.${device}.camera`)).toBeNull();
    expect(parseVoiceIdentity(`${user}.${device}.screen.more`)).toBeNull();
  });

  it("give a new key to everyone in the call when someone new comes in", async () => {
    const access = await alice.session.voiceAccess(id);
    expect(access.url).toBe("wss://voice.invalid");
    alice.session.setVoiceState(id, { muted: false, deafened: false, camera: false, screen: false });
    const before = await alice.session.voiceKey(id);
    const events = voiceEvents(alice);

    const erin = await makeUser("erin");
    try {
      await waitFor(() => joined(erin, id), "erin to come in");
      await waitFor(() => voiceEvents(alice) > events, "alice to hear the key changed");
      const [after, hers] = await Promise.all([alice.session.voiceKey(id), erin.session.voiceKey(id)]);
      expect(after.epoch).toBeGreaterThan(before.epoch);
      expect(equalBytes(after.key, before.key)).toBe(false);
      expect(after.epoch).toBe(hers.epoch);
      expect(equalBytes(after.key, hers.key)).toBe(true);

      // And when they're gone, a key they never held.
      const whileIn = hers.key;
      await alice.session.banUser(erin.userId);
      await waitFor(() => voiceEvents(alice) > events + 1, "alice to hear the key changed again", 15_000);
      const later = await alice.session.voiceKey(id);
      expect(equalBytes(later.key, whileIn)).toBe(false);
    } finally {
      erin.client.stop();
    }
    alice.session.setVoiceState(null, null);
  });

  it("show everyone who's there, muted or not, until they leave", async () => {
    bob.session.setVoiceState(id, { muted: true, deafened: false, camera: false, screen: false });
    await waitFor(() => alice.session.getVoiceMembers().some((member) => member.userId === bob.userId && member.muted), "alice to see bob, muted");
    expect(alice.events.some((event) => event.type === "voice" && event.userId === bob.userId && event.channelId === id)).toBe(true);

    // Someone else's list comes with catching up, too.
    const late = await makeUser("late");
    try {
      await waitFor(() => late.session.getVoiceMembers().some((member) => member.userId === bob.userId), "someone who just came to see bob");
    } finally {
      late.client.stop();
    }

    bob.session.setVoiceState(null, null);
    await waitFor(() => !alice.session.getVoiceMembers().some((member) => member.userId === bob.userId), "bob to be gone");
  });

  it("tell someone an admin took them out", async () => {
    bob.session.setVoiceState(id, { muted: false, deafened: false, camera: false, screen: false });
    await waitFor(() => alice.session.getVoiceMembers().some((member) => member.userId === bob.userId), "alice to see bob");
    await alice.session.voiceMute(id, bob.userId, true);
    await waitFor(() => alice.session.getVoiceMembers().some((member) => member.userId === bob.userId && member.serverMuted), "bob to be muted");
    expect((await bob.session.voiceAccess(id)).serverMuted).toBe(true);
    await alice.session.voiceMute(id, bob.userId, false);
    await alice.session.voiceDisconnect(id, bob.userId);
    await waitFor(() => bob.events.some((event) => event.type === "voice_ended" && event.reason === "disconnected"), "bob to be told");
    await waitFor(() => !alice.session.getVoiceMembers().some((member) => member.userId === bob.userId), "bob to be gone");
  });

  it("hold a screen share to what the server allows", async () => {
    const browserFree = { browser: false, sound: false };
    bob.session.setVoiceState(id, { muted: false, deafened: false, camera: false, screen: false });
    await waitFor(() => alice.session.getVoiceMembers().some((member) => member.userId === bob.userId), "alice to see bob");

    // This test server's media server isn't there, so only a native share without sound can go ahead.
    const access = await bob.session.voiceScreenAccess(id, browserFree);
    const bobSelf = bob.session.getSelf();
    expect(access.native?.identity).toBe(`${voiceIdentity(bobSelf.userId, bobSelf.deviceId)}.screen`);
    await bob.session.voiceScreenStop(id);

    const rules = { ...DEFAULT_SCREEN_RULES, who: "admins" as const, max_fps: 30, default_fps: 30, max_height: 1080 };
    await alice.session.updateServerSettings({ screen_share: rules });
    await waitFor(() => bob.session.getInfo()?.screen_share?.who === "admins", "bob to hear the rules");
    expect(bob.session.getInfo()?.screen_share).toMatchObject({ max_fps: 30, max_height: 1080 });
    await expect(bob.session.voiceScreenAccess(id, browserFree)).rejects.toThrow("Only admins");
    expect(screenRefusal(bob.session.getInfo()?.screen_share, "member")).toContain("Only admins");
    expect(screenRefusal(alice.session.getInfo()?.screen_share, "owner")).toBeNull();

    await alice.session.updateServerSettings({ screen_share: DEFAULT_SCREEN_RULES });
    await waitFor(() => bob.session.getInfo()?.screen_share?.who === "everyone", "bob to hear they're allowed");

    // A channel can turn it off, and everyone hears.
    await alice.session.updateChannel(id, { screenLimit: -1 });
    await waitFor(() => bob.session.getChannels().find((item) => item.id === id)?.screenLimit === -1, "bob to hear the channel's rule");
    await expect(bob.session.voiceScreenAccess(id, browserFree)).rejects.toThrow("off in this voice channel");
    await alice.session.updateChannel(id, { screenLimit: 0 });
    await waitFor(() => bob.session.getChannels().find((item) => item.id === id)?.screenLimit === 0, "bob to hear it's back");

    // Stopping someone's share tells them.
    await bob.session.voiceScreenAccess(id, browserFree);
    await alice.session.voiceScreenStopOf(id, bob.userId);
    await waitFor(() => bob.events.some((event) => event.type === "screen_ended" && event.channelId === id && event.reason === "stopped"), "bob to hear his share stopped");
    bob.session.setVoiceState(null, null);
  });

  it("keep an older key from unsealing anything", async () => {
    const { key } = await alice.session.voiceKey(id);
    const sealed = sealChannelDetails(key, id, { name: "x" }, 1, { userId: alice.userId, deviceId: "d" }, (alice.session as unknown as { account: { deviceSecret: Uint8Array } }).account.deviceSecret);
    expect(openChannelDetails((alice.session as unknown as { account: { core: { communityKey: Uint8Array } } }).account.core.communityKey, id, sealed)).toBeNull();
  });
});
