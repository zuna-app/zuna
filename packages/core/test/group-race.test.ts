// Group creation races: everything a member receives can arrive in any order,
// while other conversations are being set up and messages are already flowing.

import { afterAll, beforeAll, expect, it } from "vitest";
import { TestApp, TestServer, atOneEpoch, loadCrypto, waitFor } from "./helpers";

let server: TestServer;
let owner: TestApp;
let creator: TestApp;
let members: TestApp[];

const titleOf = (app: TestApp, groupId: string) => app.session.getConversations().find((item) => item.groupId === groupId)?.title;

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  owner = await new TestApp("owner").open();
  await owner.register(server.setupLink, "owner");
  const invite = await owner.session.createInvite(0, 0);
  creator = await new TestApp("creator").open();
  await creator.register(invite, "creator");
  members = [];
  for (const name of ["mina", "noor", "omar"]) {
    const app = await new TestApp(name).open();
    await app.register(invite, name);
    members.push(app);
  }
  await waitFor(() => creator.session.getUsers().length === 5, "the creator to see everyone");
  await waitFor(() => members[0]!.session.getUsers().length === 5, "the others to see everyone");
});

afterAll(async () => {
  for (const app of [owner, creator, ...members]) app?.client.stop();
  await server?.stop();
});

it("gives every member new groups' names and messages, however events interleave", async () => {
  const everyone = [owner, creator, ...members];
  const founders = [creator, members[0]!, members[1]!];
  for (let round = 0; round < 8; round++) {
    // Several groups at once, so one group's welcome is handled while another's arrives.
    const groups = await Promise.all(
      founders.map(async (founder, index) => {
        const name = `Round ${round}.${index}`;
        const others = everyone.filter((app) => app !== founder).map((app) => app.userId);
        const groupId = await founder.session.createGroup(name, others, false);
        // Sending straight away means messages can overtake a member's join.
        founder.session.sendMessage(`group:${groupId}`, { text: `first ${name}` });
        founder.session.sendMessage(`group:${groupId}`, { text: `second ${name}` });
        return { name, groupId };
      }),
    );
    for (const { name, groupId } of groups) {
      for (const app of everyone) {
        await waitFor(() => titleOf(app, groupId) === name, `${app.name} to see ${name}`, 8000);
        await waitFor(() => app.texts(`group:${groupId}`).includes(`second ${name}`), `${app.name} to read ${name}`, 8000);
        expect(app.texts(`group:${groupId}`)).toEqual([`first ${name}`, `second ${name}`]);
      }
    }
  }
}, 120_000);

it("keeps a group that arrives while the list of groups is on its way", async () => {
  const [mina] = members as [TestApp];
  const session = mina.session as any;
  const fetchGroups = session.api.groups;
  let groupId = "";
  session.api.groups = async () => {
    const stale = await fetchGroups();
    groupId = await creator.session.createGroup("Arrived late", [mina.userId], false);
    await waitFor(() => titleOf(mina, groupId) === "Arrived late", "the group to arrive");
    return stale;
  };
  try {
    await session.syncAll();
  } finally {
    session.api.groups = fetchGroups;
  }
  expect(titleOf(mina, groupId)).toBe("Arrived late");
  creator.session.sendMessage(`group:${groupId}`, { text: "still here" });
  await waitFor(() => mina.texts(`group:${groupId}`).includes("still here"), "the message");
});

it("shows the name to someone who had to join without a Welcome", async () => {
  const [, noor] = members as [TestApp, TestApp];
  const session = noor.session as any;
  const fetchWelcomes = session.api.welcomes;
  session.api.welcomes = async () => [];
  try {
    const groupId = await creator.session.createGroup("No welcome", [noor.userId], false);
    await waitFor(() => titleOf(noor, groupId) === "No welcome", "the name to reach the late joiner");
    creator.session.sendMessage(`group:${groupId}`, { text: "can you read this?" });
    await waitFor(() => noor.texts(`group:${groupId}`).includes("can you read this?"), "the message");
  } finally {
    session.api.welcomes = fetchWelcomes;
  }
});

it("reads what changed again, rather than joining again, for a commit the server took while it read", async () => {
  const mina = members[0]!;
  const groupId = await creator.session.createGroup("Read again", [mina.userId], false);
  await waitFor(() => atOneEpoch(groupId, creator, mina), "mina to join");
  const session = mina.session as any;
  const other = creator.session as any;
  const { changes, joinExternal } = { changes: session.api.changes, joinExternal: session.joinExternal };
  let joinedAgain = false;
  session.joinExternal = (id: string) => {
    joinedAgain = true;
    return joinExternal.call(session, id);
  };
  let first = true;
  session.api.changes = async (id: string, after: number) => {
    const page = await changes.call(session.api, id, after);
    if (id !== groupId || !first) return page;
    first = false;
    // After this page was read, a commit, and a message under the epoch it makes.
    await other.withLock(groupId, () => other.commitWithRetry(groupId, async () => ({ kind: "update" })));
    creator.session.sendMessage(`group:${groupId}`, { text: "under the new epoch" });
    await waitFor(() => creator.texts(`group:${groupId}`).includes("under the new epoch"), "it to be sent");
    // Meanwhile something else of mina's app hears from the server where the group is now.
    session.applyGroup(await session.api.group(groupId));
    return page;
  };
  try {
    await session.withLock(groupId, () => session.pullChanges(groupId));
    // Joining again would have left mina with no key for the epoch it's under.
    await waitFor(() => mina.texts(`group:${groupId}`).includes("under the new epoch"), "the message");
    expect(joinedAgain).toBe(false);
  } finally {
    session.api.changes = changes;
    session.joinExternal = joinExternal;
  }
});
