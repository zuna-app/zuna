// What someone signs about a message (a reaction, a pin, a deletion), and whether it counts
// at the message's place: what honest devices sign has to keep coming through, late, racing a
// commit, or from before the device reading it joined.

import { describe, expect, it } from "vitest";
import { TestApp, waitFor } from "./helpers";
import { apiOf, groupWith, person, sessionOf, startServer } from "./security-setup";

startServer({ perTest: true });

const THUMBS_UP = "\u{1F44D}";

const reactorsOn = (app: TestApp, groupId: string, id: string): string[] =>
  (sessionOf(app).storedBody(sessionOf(app).messageRow(groupId, id))?.reactions ?? []).flatMap((reaction: { userIds: string[] }) => reaction.userIds);

const pinnedOn = async (app: TestApp, groupId: string): Promise<string[]> => (await app.session.loadPins(groupId)).map((message) => message.id);

async function sent(from: TestApp, to: TestApp[], groupId: string, text: string): Promise<string> {
  const { id } = from.session.sendMessage(`group:${groupId}`, { text });
  for (const app of to) await waitFor(() => app.texts(`group:${groupId}`).includes(text) && sessionOf(app).messageRow(groupId, id)?.seq !== null, "delivery");
  return id;
}

describe("what an honest device signs about a message", () => {
  it("shows what was signed before this device joined, and before its signer left", async () => {
    const owner = await person("nia");
    const member = await person("oli");
    const groupId = await groupWith(owner, [member], true);
    const id = await sent(owner, [member], groupId, "from the start");
    const own = await sent(member, [owner], groupId, "for the owner to pin");
    await member.session.toggleReaction(groupId, id, THUMBS_UP);
    await member.session.setPinned(groupId, id, true);
    // And what someone still in the group signed before the newcomer came.
    await owner.session.toggleReaction(groupId, own, THUMBS_UP);
    await owner.session.setPinned(groupId, own, true);
    await waitFor(() => reactorsOn(owner, groupId, id).includes(member.userId), "the reaction");
    // A few commits later, the member leaves, and someone new comes in with the group's history.
    for (let i = 0; i < 2; i++) await sessionOf(owner).withLock(groupId, () => sessionOf(owner).commitWithRetry(groupId, async () => ({ kind: "update" })));
    await member.session.leaveGroup(groupId);
    const later = await person("pax");
    await owner.session.addMembers(groupId, [later.userId]);
    await waitFor(() => later.texts(`group:${groupId}`).includes("from the start"), "the history");
    await waitFor(() => reactorsOn(later, groupId, id).includes(member.userId), "the reaction from before");
    await waitFor(async () => (await pinnedOn(later, groupId)).includes(id), "the pin from before");
    await waitFor(() => reactorsOn(later, groupId, own).includes(owner.userId), "the owner's reaction from before");
    await waitFor(async () => (await pinnedOn(later, groupId)).includes(own), "the owner's pin from before");
    // And on a device that was there all along, read again whole.
    sessionOf(owner).db.run("UPDATE messages SET updated_seq = 0 WHERE group_id = ? AND id = ?", [groupId, id]);
    sessionOf(owner).ingest(await apiOf(owner).message(groupId, id), false);
    expect(reactorsOn(owner, groupId, id)).toContain(member.userId);
    expect(await pinnedOn(owner, groupId)).toContain(id);
  });
});
