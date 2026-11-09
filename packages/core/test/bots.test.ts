// Bots, end to end through a real server, with an app as the bot: one is made, set up
// through its link and brought into chats, it gets nothing from before, a private one is
// there for nobody it shares no chat with, and it keeps its owner's rules itself.

import * as wasm from "@zuna/crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../src/encoding";
import type { UserView } from "../src/types";
import { TestApp, png, waitFor } from "./helpers";
import { alice, apiOf, groupWith, open, person, sessionOf, startServer, warned, withServerDatabase } from "./security-setup";

startServer();

const userOf = (app: TestApp, id: string): UserView | undefined => app.session.getUsers().find((user) => user.id === id);
const read = (app: TestApp, key: string, text: string) => waitFor(() => app.texts(key).includes(text), `${app.name} to read "${text}"`);
const heard = (app: TestApp, text: string) => waitFor(() => app.events.some((event) => event.type === "message" && event.message.text === text && event.message.status === "sent"), `${app.name} to hear "${text}"`);
const inGroup = (app: TestApp, groupId: string) => app.session.getConversations().some((item) => item.groupId === groupId && item.ready && !item.removed);

/** Makes a bot and runs it, as its owner and then its program do. */
async function runBot(owner: TestApp, username: string, settings: { listed?: boolean; add?: "owner" | "admins" | "anyone" } = {}): Promise<{ id: string; app: TestApp; link: string }> {
  const { bot, link } = await owner.session.createBot({ username, name: `The ${username}`, ...settings });
  expect(bot).toMatchObject({ username, ownerId: owner.userId, setUp: false, listed: settings.listed ?? false });
  const app = await new TestApp(username).open();
  await app.registerBot(link);
  open.push(app);
  expect(app.userId).toBe(bot.id);
  return { id: bot.id, app, link };
}

describe("a bot", () => {
  let helper: { id: string; app: TestApp; link: string };
  let bob: TestApp;
  let carol: TestApp;
  let groupId: string;

  it("is made by its owner, set up through its link, and answers", async () => {
    helper = await runBot(alice, "helper");
    // Its owner's app knows the key is the one its link made, with nothing to compare.
    await waitFor(() => userOf(alice, helper.id)?.trust === "verified", "the owner's app to trust the bot's key");
    expect(userOf(alice, helper.id)).toMatchObject({ displayName: "The helper", bot: { ownerId: alice.userId, listed: false, add: "owner" }, online: false, lastSeenAt: null });
    expect((await alice.session.getBots()).map((bot) => [bot.id, bot.setUp])).toEqual([[helper.id, true]]);
    // The bot holds its owner's rules, and its owner's key from the link.
    expect(sessionOf(helper.app).account.bot).toMatchObject({ ownerId: alice.userId, listed: false, add: "owner" });

    alice.session.sendMessage(`user:${helper.id}`, { text: "ping" });
    await read(helper.app, `user:${alice.userId}`, "ping");
    helper.app.session.sendMessage(`user:${alice.userId}`, { text: "pong" });
    await read(alice, `user:${helper.id}`, "pong");
    expect(alice.session.getConversations().find((item) => item.key === `user:${helper.id}`)).toMatchObject({ bot: true });
  });

  it("has a link that works once, and only for the bot's program", async () => {
    await expect(alice.client.previewInvite(helper.link)).rejects.toThrow(/sets up a bot/);
    const again = await new TestApp("again").open();
    await expect(again.registerBot(helper.link)).rejects.toThrow();
    again.client.stop();
  });

  it("is added to a group by its owner, and gets nothing from before", async () => {
    bob = await person("bob");
    carol = await person("carol");
    groupId = await groupWith(alice, [bob], true, "With history");
    alice.session.sendMessage(`group:${groupId}`, { text: "said before the bot" });
    await read(bob, `group:${groupId}`, "said before the bot");

    await alice.session.addMembers(groupId, [helper.id]);
    await waitFor(() => inGroup(helper.app, groupId), "the bot to come into the group");
    alice.session.sendMessage(`group:${groupId}`, { text: "said with the bot there" });
    await read(helper.app, `group:${groupId}`, "said with the bot there");
    expect(helper.app.texts(`group:${groupId}`)).not.toContain("said before the bot");
    // No keys from before were handed to it either, though the group shares its history.
    expect(await apiOf(helper.app).historyGrants()).toEqual([]);
    expect(sessionOf(helper.app).allEpochKeys(groupId)).not.toHaveProperty("1");

    helper.app.session.sendMessage(`group:${groupId}`, { text: "the bot answers" });
    await read(bob, `group:${groupId}`, "the bot answers");
    // Someone in a group with it sees it, and that it's a bot.
    await waitFor(() => !!userOf(bob, helper.id)?.bot, "bob to see the bot");
    expect(userOf(bob, helper.id)).toMatchObject({ displayName: "The helper", bot: { ownerId: alice.userId, listed: false } });
  });

  it("stays unknown to anyone it shares no chat with, the server's admins too", async () => {
    await alice.session.setServerRole(carol.userId, "admin");
    await waitFor(() => carol.session.getSelf().role === "admin", "carol to be an admin");
    // Starting again asks the server for everyone, from the beginning.
    const fresh = await new TestApp("carol-again").open();
    await fresh.login(alice.session.serverUrl(), carol.session.getSelf().username);
    open.push(fresh);
    for (const app of [carol, fresh]) {
      expect(userOf(app, helper.id)).toBeUndefined();
      expect(app.session.getConversations().some((item) => item.peerId === helper.id)).toBe(false);
      expect(await app.session.getBots()).toEqual([]);
      await expect(apiOf(app).user(helper.id)).rejects.toMatchObject({ status: 404 });
      await expect(apiOf(app).createDm(helper.id)).rejects.toMatchObject({ status: 404 });
    }
    // Nor does it count as one of the server's people.
    expect((await apiOf(alice).info()).user_count).toBe(3);
  });

  it("can't be added by anyone but its owner, and leaves if a server lets them", async () => {
    const bobs = await groupWith(bob, [carol], false, "Bob's");
    await expect(bob.session.addMembers(bobs, [helper.id])).rejects.toBeInstanceOf(ApiError);
    expect((await apiOf(bob).group(bobs)).members.map((member) => member.user_id)).not.toContain(helper.id);

    // A server that lies about what the bot's owner chose lets bob add it. The bot keeps
    // its owner's rules itself, from its setup link, and leaves.
    withServerDatabase((db) => db.prepare("UPDATE bots SET listed = 1, add_policy = 'anyone' WHERE id = ?").run(helper.id));
    await bob.session.addMembers(bobs, [helper.id]);
    await waitFor(async () => !(await apiOf(bob).group(bobs)).members.some((member) => member.user_id === helper.id), "the bot to leave bob's group");
    expect(inGroup(helper.app, bobs)).toBe(false);
    expect(inGroup(helper.app, groupId)).toBe(true);
    withServerDatabase((db) => db.prepare("UPDATE bots SET listed = 0, add_policy = 'owner' WHERE id = ?").run(helper.id));
  });

  it("can't start a group, or write to anyone first", async () => {
    await expect(helper.app.session.createGroup("The bot's own", [], false)).rejects.toMatchObject({ code: "bot" });
    await expect(apiOf(helper.app).createDm(bob.userId)).rejects.toMatchObject({ code: "bot" });
    await expect(helper.app.session.createInvite(1, 0)).rejects.toMatchObject({ status: 403 });
  });

  it("takes its name and picture from its owner, through their chat, which shows none of it", async () => {
    const before = alice.texts(`user:${helper.id}`);
    await alice.session.updateBotProfile(helper.id, { displayName: "Helper Two", bio: "I help." }, new Blob([png(4, 4) as BlobPart], { type: "image/png" }));
    await waitFor(() => userOf(alice, helper.id)?.displayName === "Helper Two" && !!userOf(alice, helper.id)?.avatar, "the bot to take its new profile");
    expect(userOf(alice, helper.id)).toMatchObject({ bio: "I help." });
    // Bob sees it too, and nobody's chat shows the ask.
    await waitFor(() => userOf(bob, helper.id)?.displayName === "Helper Two", "bob to see the bot's new name");
    expect(alice.texts(`user:${helper.id}`)).toEqual(before);
    expect(helper.app.texts(`user:${alice.userId}`)).toEqual(before);
    expect(alice.session.getConversations().find((item) => item.key === `user:${helper.id}`)?.lastMessage?.text).toBe("pong");

    await alice.session.updateBotProfile(helper.id, {}, null);
    await waitFor(() => userOf(alice, helper.id)?.avatar === null, "the bot to drop its picture");
  });

  it("keeps who may see and add it as its owner says, and nobody else", async () => {
    // Bob, who shares a group with it, may write to it, but it does nothing he asks.
    bob.session.sendMessage(`user:${helper.id}`, { text: "hello bot" });
    await read(helper.app, `user:${bob.userId}`, "hello bot");
    const withBot = bob.session.getConversations().find((item) => item.key === `user:${helper.id}`)!.groupId!;
    await sessionOf(bob).sendSignal(withBot, { type: "bot_settings", listed: true, add: "anyone", profile: { displayName: "Bob's now" } });
    bob.session.sendMessage(`user:${helper.id}`, { text: "did that work?" });
    await read(helper.app, `user:${bob.userId}`, "did that work?");
    expect(sessionOf(helper.app).account.bot).toMatchObject({ listed: false, add: "owner" });
    expect(userOf(alice, helper.id)?.displayName).toBe("Helper Two");

    // Its owner lists it for everyone, and lets anyone add it. The bot hears, and so does everyone.
    expect(await alice.session.updateBot(helper.id, { listed: true, add: "anyone" })).toMatchObject({ listed: true, add: "anyone" });
    await waitFor(() => sessionOf(helper.app).account.bot.listed === true && sessionOf(helper.app).account.bot.add === "anyone", "the bot to hear its new rules");
    await waitFor(() => !!userOf(carol, helper.id)?.bot?.listed, "carol to see the listed bot");
    // A listed bot nobody has written to is a chat for an app that lists bots, and for no other.
    expect(carol.session.getConversations().find((item) => item.peerId === helper.id)).toMatchObject({ bot: true, groupId: null });
    const plain = new TestApp("plain");
    plain.bots = false;
    await plain.open();
    await plain.login(alice.session.serverUrl(), carol.session.getSelf().username);
    open.push(plain);
    expect(userOf(plain, helper.id)?.bot).toBeTruthy();
    expect(plain.session.getConversations().some((item) => item.peerId === helper.id)).toBe(false);

    // Now bob may add it, and it stays.
    const bobs = await groupWith(bob, [carol], false, "Bob's other");
    await bob.session.addMembers(bobs, [helper.id]);
    await waitFor(() => inGroup(helper.app, bobs), "the bot to come into bob's group");
    bob.session.sendMessage(`group:${bobs}`, { text: "welcome, bot" });
    await read(helper.app, `group:${bobs}`, "welcome, bot");
    expect(inGroup(helper.app, bobs)).toBe(true);

    // Private again, it's its owner's alone to add, whatever it was before.
    expect(await alice.session.updateBot(helper.id, { listed: false })).toMatchObject({ listed: false, add: "owner" });
    await waitFor(() => sessionOf(helper.app).account.bot.listed === false, "the bot to hear it's private");
    expect(sessionOf(helper.app).account.bot.add).toBe("owner");
  });

  it("lists its commands for the chats it's in", async () => {
    await helper.app.session.updateProfile({ commands: [{ command: "start", description: "Begin" }, { command: "help", description: "What I can do" }] });
    await waitFor(() => userOf(bob, helper.id)?.commands.length === 2 && userOf(alice, helper.id)?.commands.length === 2, "everyone with the bot to see its commands");
    expect(userOf(alice, helper.id)?.commands).toEqual([{ command: "start", description: "Begin" }, { command: "help", description: "What I can do" }]);
    // Nobody but a bot has any, whatever their profile says.
    await bob.session.updateProfile({ commands: [{ command: "mine", description: "Not a bot's" }] });
    await waitFor(() => userOf(alice, bob.userId)?.displayName !== undefined, "alice to see bob");
    expect(userOf(alice, bob.userId)?.commands).toEqual([]);
  });

  it("hears a button pressed under its message, which shows nowhere", async () => {
    const key = `group:${groupId}`;
    const sent = helper.app.session.sendMessage(key, { text: "Pick one", buttons: [[{ text: "Yes", data: "yes" }, { text: "Docs", url: "https://example.com/docs" }], [{ text: "No", data: "no" }]] });
    await read(bob, key, "Pick one");
    await read(alice, key, "Pick one");
    const shown = (await bob.session.messageById(groupId, sent.id))!;
    expect(shown.buttons).toEqual([[{ text: "Yes", data: "yes" }, { text: "Docs", url: "https://example.com/docs" }], [{ text: "No", data: "no" }]]);
    const before = { texts: alice.texts(key), unread: alice.session.getConversations().find((item) => item.groupId === groupId)!.unread };

    const presses = () => helper.app.events.filter((event) => event.type === "button");
    await bob.session.pressButton(groupId, sent.id, 1, 0);
    await waitFor(() => presses().length === 1, "the bot to hear the press");
    expect(presses()[0]).toMatchObject({ groupId, messageId: sent.id, userId: bob.userId, data: "no" });
    // A link isn't pressed, it's opened. And data no button of that message holds is nobody's press.
    await expect(bob.session.pressButton(groupId, sent.id, 0, 1)).rejects.toThrow();
    await sessionOf(bob).sendSignal(groupId, { type: "button", message: sent.id, data: "made up" });
    await alice.session.pressButton(groupId, sent.id, 0, 0);
    await waitFor(() => presses().length === 2, "the bot to hear the second press");
    expect(presses().map((event) => (event as { data: string }).data)).toEqual(["no", "yes"]);

    // The chat shows none of it, to anyone.
    expect(alice.texts(key)).toEqual(before.texts);
    expect(alice.session.getConversations().find((item) => item.groupId === groupId)!.unread).toBe(before.unread);
    expect(bob.texts(key)).toEqual(before.texts);
    expect(bob.session.getConversations().find((item) => item.groupId === groupId)!.lastMessage?.text).toBe("Pick one");

    // Buttons are a bot's: a person's message shows none, whatever it says.
    const fake = alice.session.sendMessage(key, { text: "Not a bot", buttons: [[{ text: "Yes", data: "yes" }]] });
    await read(bob, key, "Not a bot");
    expect((await bob.session.messageById(groupId, fake.id))!.buttons).toEqual([]);
    // And a bot takes its own away by editing them out.
    helper.app.session.editMessage(groupId, sent.id, "Picked", {}, [], null);
    await read(bob, key, "Picked");
    expect((await bob.session.messageById(groupId, sent.id))!.buttons).toEqual([]);
  });

  it("is taken out of its chats when it's deleted", async () => {
    await alice.session.deleteBot(helper.id);
    await waitFor(() => helper.app.events.some((event) => event.type === "signed_out" && event.reason === "account_deleted"), "the bot to be signed out");
    await waitFor(() => userOf(alice, helper.id)?.deleted === true && userOf(bob, helper.id)?.deleted === true, "everyone who knew it to see it's gone");
    await waitFor(async () => !(await apiOf(alice).group(groupId)).members.some((member) => member.user_id === helper.id), "the bot to be off the group's list");
    await waitFor(() => !sessionOf(alice).treeUsers(groupId).includes(helper.id), "the group's keys to leave the bot behind");
    expect(await alice.session.getBots()).toEqual([]);
  });
});

describe("a bot's standing", () => {
  it("isn't trusted when it signed up with a key its link didn't make", async () => {
    const { bot, link } = await alice.session.createBot({ username: "impostor", name: "Impostor" });
    // The link as someone who took the bot's place would use it: all of it but the key that vouches.
    const [address, fragment] = link.split("#") as [string, string];
    const parts = new URLSearchParams(fragment);
    const carried = JSON.parse(fromUtf8(fromBase64Url(parts.get("bot")!)));
    carried.s = toBase64Url((wasm.signingKeygen() as { secretKey: Uint8Array }).secretKey);
    parts.set("bot", toBase64Url(utf8(JSON.stringify(carried))));
    const app = await new TestApp("impostor").open();
    await app.registerBot(`${address}#${parts}`);
    open.push(app);

    await waitFor(() => warned(alice, "signed up with a key its setup link didn't make"), "the owner to be warned");
    expect(userOf(alice, bot.id)?.trust).toBe("unverified");
    await alice.session.deleteBot(bot.id);
  });

  it("goes with its owner when they're banned", async () => {
    await alice.session.updateServerSettings({ allow_member_bots: true });
    const erin = await person("erin");
    await waitFor(() => erin.session.getInfo()?.allow_member_bots === true, "erin to hear members may make bots");
    const erins = await runBot(erin, "erins");
    const waiting = await erin.session.createBot({ username: "erins-waiting" });
    await alice.session.banUser(erin.userId);
    await waitFor(() => erins.app.events.some((event) => event.type === "signed_out"), "the banned owner's bot to be signed out");
    const late = await new TestApp("late").open();
    await expect(late.registerBot(waiting.link)).rejects.toThrow();
    late.client.stop();
  });

  it("joins the channels a listed bot was given, and no others", async () => {
    const given = await alice.session.createChannel({ type: "text", name: "for-bots" });
    const other = await alice.session.createChannel({ type: "text", name: "for-people" });
    const listed = await runBot(alice, "announcer", { listed: true });
    expect(listed.app.session.getChannels()).toEqual([]);
    expect(await alice.session.setBotChannels(listed.id, [given])).toMatchObject({ channels: [given] });
    await waitFor(() => !!listed.app.session.getChannels().find((channel) => channel.id === given)?.conversation?.ready, "the bot to come into its channel");
    expect(listed.app.session.getChannels().map((channel) => channel.id)).toEqual([given]);
    await expect(apiOf(listed.app).joinChannel(other, new Uint8Array(32), false)).rejects.toMatchObject({ status: 403 });

    alice.session.sendMessage(`group:${given}`, { text: "to the channel" });
    await heard(listed.app, "to the channel");
    listed.app.session.sendMessage(`group:${given}`, { text: "from the bot" });
    await heard(alice, "from the bot");

    // Taken away, it's out.
    await alice.session.setBotChannels(listed.id, []);
    await waitFor(() => listed.app.session.getChannels().length === 0, "the bot to lose its channel");
  });
});
