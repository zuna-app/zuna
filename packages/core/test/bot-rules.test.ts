// Where a bot's rules come from: its setup link, its owner since, and its own vault, never the
// server. A server can't make a person's account a bot it names an owner for, and a bot brought
// into a group by someone its owner didn't allow leaves however it came in.

import { describe, expect, it } from "vitest";
import { equalBytes } from "../src/encoding";
import type { UserView } from "../src/types";
import { TestApp, sleep, waitFor } from "./helpers";
import { alice, apiOf, groupWith, open, person, server, sessionOf, startServer, withServerDatabase } from "./security-setup";

startServer();

const userOf = (app: TestApp, id: string): UserView | undefined => app.session.getUsers().find((user) => user.id === id);
const inGroup = (app: TestApp, groupId: string) => app.session.getConversations().some((item) => item.groupId === groupId && item.ready && !item.removed);

describe("a bot's rules", () => {
  it("never come from the server, for a person's account", async () => {
    const victim = await person("victim");
    const mallory = await person("mallory");
    await waitFor(() => userOf(alice, victim.userId)?.displayName.startsWith("victim") === true, "alice to see the victim's real name");
    const realName = userOf(alice, victim.userId)!.displayName;

    // The server says the victim's own account is a bot, mallory's.
    const own = await apiOf(victim).user(victim.userId);
    sessionOf(victim).onFrame({ t: "user", d: { ...own, bot: { owner_id: mallory.userId, listed: false, add: "owner" } } });
    await sleep(200);
    expect(sessionOf(victim).account.bot).toBeUndefined();

    // Mallory sends what an owner's app sends its bot, and nothing comes of it.
    const dm = await sessionOf(mallory).groupIdForKey(`user:${victim.userId}`);
    await sessionOf(mallory).sendSignal(dm, { type: "bot_settings", profile: { displayName: "Forged by Mallory", bio: "the victim never wrote this" } });
    await sleep(3000);
    expect(userOf(alice, victim.userId)?.displayName).toBe(realName);

    // And someone else adding the victim to a group leaves them in it.
    const groupId = await alice.session.createGroup("Alice's group", [victim.userId], false);
    await waitFor(() => inGroup(victim, groupId), "the victim to come into alice's group");
    await sleep(1000);
    expect((await apiOf(alice).group(groupId)).members.map((member) => member.user_id)).toContain(victim.userId);
  });

  it("are a bot's own when it's brought back with its recovery key", async () => {
    const { bot, link } = await alice.session.createBot({ username: "restored", name: "The restored" });
    const first = await new TestApp("restored").open();
    const recoveryKey = await first.registerBot(link);
    open.push(first);
    const rules = sessionOf(first).account.bot;
    expect(rules).toMatchObject({ ownerId: alice.userId, listed: false, add: "owner" });
    await waitFor(() => !!sessionOf(first).manifest?.bot, "the bot to keep its rules in its manifest");
    first.client.stop();

    const again = await new TestApp("restored-again").open();
    open.push(again);
    again.serverId = await again.client.recover(server.url, first.session.getSelf().username, recoveryKey, "a new password for the bot");
    await again.online();
    expect(again.userId).toBe(bot.id);
    await waitFor(() => !!sessionOf(again).account.bot, "the bot to take its rules from its manifest", 30_000);
    expect(sessionOf(again).account.bot).toMatchObject({ ownerId: alice.userId, ownerKey: rules!.ownerKey, listed: false, add: "owner" });
    const pinned = sessionOf(again).pinnedIdentity(alice.userId);
    expect(pinned && equalBytes(pinned, sessionOf(alice).account.core.rootPublic)).toBe(true);
  });

  it("make a bot leave a group someone its owner didn't allow added it to, though its Welcome was kept back", async () => {
    // Alice's private bot: hers alone to add.
    const { bot, link } = await alice.session.createBot({ username: "helper", name: "The helper" });
    const helper = await new TestApp("helper").open();
    await helper.registerBot(link);
    open.push(helper);
    const bob = await person("bob");
    const carol = await person("carol");
    const bobs = await groupWith(bob, [carol], false, "Bob's");
    // Bob knows the bot: its owner brought it into a group he's in.
    const shared = await groupWith(alice, [bob], false, "Alice's");
    await alice.session.addMembers(shared, [bot.id]);
    await waitFor(() => inGroup(helper, shared), "the bot to come into its owner's group");
    await waitFor(() => !!bob.session.getUsers().find((user) => user.id === bot.id)?.bot, "bob to see the bot");
    helper.client.stop();
    await sleep(100);

    // The server lies about what the bot's owner chose, takes bob's commit adding it, and keeps its Welcome.
    withServerDatabase((db) => db.prepare("UPDATE bots SET listed = 1, add_policy = 'anyone' WHERE id = ?").run(bot.id));
    await bob.session.addMembers(bobs, [bot.id]);
    const kept = withServerDatabase((db) => db.prepare("DELETE FROM welcomes WHERE group_id = ?").run(bobs));
    expect(Number(kept.changes)).toBeGreaterThan(0);
    withServerDatabase((db) => db.prepare("UPDATE bots SET listed = 0, add_policy = 'owner' WHERE id = ?").run(bot.id));

    // The bot comes back, finds itself listed, joins by itself, and leaves.
    await helper.open();
    await helper.online();
    await waitFor(async () => !(await apiOf(bob).group(bobs)).members.some((member) => member.user_id === bot.id), "the bot to leave bob's group", 30_000);
    expect(inGroup(helper, bobs)).toBe(false);
    // Still in its owner's group, which its owner added it to.
    expect(inGroup(helper, shared)).toBe(true);
  });
});
