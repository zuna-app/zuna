// What a person changes of their account, their groups and their server, end to end through a
// real server, in the ways the other tests don't take: pictures added without a type and taken
// away, the export naming each kind of chat as this device does, roles and members an admin
// can't change, verification asked of someone unknown or compared against the wrong thing, and
// an admin's roles, icon and open sign-ups.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCrypto, png, TestApp, TestServer, waitFor } from "./helpers";

let server: TestServer;
let alice: TestApp;
let bob: TestApp;
let carol: TestApp;

const picture = () => new Blob([png(4, 4) as BlobPart]);

beforeAll(async () => {
  loadCrypto();
  server = new TestServer();
  await server.start();
  alice = await new TestApp("alice").open();
  await alice.register(server.setupLink, "alice");
  const invite = await alice.session.createInvite(0, 0);
  bob = await new TestApp("bob").open();
  await bob.register(invite, "bob");
  carol = await new TestApp("carol").open();
  await carol.register(invite, "carol");
  await waitFor(() => alice.session.getUsers().length === 3 && bob.session.getUsers().length === 3, "everyone to see everyone");
});

afterAll(async () => {
  for (const app of [alice, bob, carol]) app?.client.stop();
  await server?.stop();
});

describe("a person's own picture and devices", () => {
  it("takes a picture without a type as WebP, and takes it away again", async () => {
    await alice.session.updateProfile({ bio: "hello" }, picture());
    await waitFor(() => !!bob.session.getUsers().find((user) => user.id === alice.userId)?.avatar, "bob to see alice's picture");
    expect(bob.session.getUsers().find((user) => user.id === alice.userId)?.avatar?.mime).toBe("image/webp");
    await alice.session.updateProfile({}, null);
    await waitFor(() => bob.session.getUsers().find((user) => user.id === alice.userId)?.avatar === null, "bob to see it gone");
    expect(bob.session.getUsers().find((user) => user.id === alice.userId)?.bio).toBe("hello");
  });

  it("asks nothing of a device it doesn't know that someone says wasn't theirs", async () => {
    const devices = alice.session.getDevices();
    await alice.session.answerNewDevice("not-a-device", false);
    await alice.session.answerNewDevice("not-a-device", true);
    expect(alice.session.getDevices()).toEqual(devices);
    expect(devices).toEqual([expect.objectContaining({ isCurrent: true, name: expect.any(String) })]);
  });
});

describe("the export, in this device's words", () => {
  it("names each chat as this device calls it, and none it can't", async () => {
    // A chat with oneself, one with someone, a named group and a channel.
    await alice.session.sendMessage(`user:${alice.userId}`, { text: "a note to self" });
    await alice.session.sendMessage(`user:${carol.userId}`, { text: "hi carol" });
    const group = await alice.session.createGroup("Book club", [bob.userId], false);
    const channel = await alice.session.createChannel({ type: "text", name: "general" });
    await waitFor(() => alice.session.getChannels().some((item) => item.id === channel && !!item.name), "the channel");
    const exported = await alice.session.exportServerData();
    const notes = exported.sections.find((section) => section.id === "conversations")!.rows.map((row) => row.note ?? "");
    expect(notes.some((note) => note.startsWith("On your devices: “Book club”."))).toBe(true);
    expect(notes.some((note) => note.startsWith("On your devices: “general”."))).toBe(true);
    expect(notes.some((note) => note.startsWith("On your devices: “carol”."))).toBe(true);
    // The chat with oneself has no name but its own.
    const saved = exported.sections.find((section) => section.id === "conversations")!.rows.find((row) => row.label === "Your saved messages")!;
    expect(saved.note).not.toContain("On your devices");
    expect(group).toBeTruthy();
  });
});

describe("a group's details and who runs it", () => {
  let group = "";

  beforeAll(async () => {
    group = await alice.session.createGroup("Trip", [bob.userId], true, picture());
    await waitFor(() => bob.session.getConversations().some((chat) => chat.groupId === group), "bob to be in the trip");
  });

  it("takes a group's picture without a type, then takes it away, and changes who sees its history", async () => {
    expect(alice.session.getConversations().find((chat) => chat.groupId === group)?.avatar?.mime).toBe("image/webp");
    await alice.session.updateGroupMeta(group, {}, picture());
    await alice.session.updateGroupMeta(group, { name: "Trip 2" }, null, false);
    await waitFor(() => bob.session.getConversations().find((chat) => chat.groupId === group)?.title === "Trip 2", "bob to see the new name");
    const shown = bob.session.getConversations().find((chat) => chat.groupId === group)!;
    expect(shown.avatar).toBeNull();
    // A group it doesn't have changes nothing.
    await alice.session.updateGroupMeta("no-such-group", { name: "x" });
  });

  it("lets only an admin change who's an admin, and only of someone in the group", async () => {
    await expect(bob.session.setGroupRole(group, bob.userId, "admin")).rejects.toThrow("Only an admin of this group can change who its admins are.");
    await expect(alice.session.setGroupRole(group, carol.userId, "admin")).rejects.toThrow("They aren't in this group.");
    await expect(bob.session.addMembers(group, [carol.userId])).rejects.toThrow("Only an admin of this group can add people.");
    await alice.session.setGroupRole(group, bob.userId, "admin");
    await waitFor(() => bob.session.getConversations().find((chat) => chat.groupId === group)?.members.find((member) => member.userId === bob.userId)?.role === "admin", "bob to be an admin");
    await alice.session.setGroupRole(group, bob.userId, "member");
    await waitFor(() => bob.session.getConversations().find((chat) => chat.groupId === group)?.members.find((member) => member.userId === bob.userId)?.role === "member", "bob to be a member again");
  });
});

describe("verifying someone", () => {
  it("has nothing to compare for someone unknown, and takes no comparison of another kind", async () => {
    expect(alice.session.safetyCheck("nobody")).toBeNull();
    await alice.session.markVerified("nobody", "heads:AAAA");
    await alice.session.clearVerification("nobody");
    await expect(alice.session.markVerified(bob.userId, "keys:AAAA")).rejects.toThrow("Compare the emoji again.");
    await expect(alice.session.markVerified(bob.userId, "heads:AAAA")).rejects.toThrow("Compare the emoji again.");
    expect(alice.session.getUsers().find((user) => user.id === bob.userId)?.trust).not.toBe("verified");
  });
});

describe("running a server", () => {
  it("changes the server's icon, someone's role, and opens sign-ups with the community's key", async () => {
    await alice.session.updateServerIcon(picture());
    await waitFor(async () => (await fetch(`${server.url}/api/icon`)).ok, "the icon");
    await alice.session.setServerRole(carol.userId, "admin");
    await waitFor(() => carol.session.getSelf().role === "admin", "carol to be an admin");
    await alice.session.setServerRole(carol.userId, "member");
    await alice.session.updateServerSettings({ registration: "open" });
    const info = await (await fetch(`${server.url}/api/info`)).json();
    expect(info.registration).toBe("open");
    await alice.session.updateServerSettings({ registration: "invite" });
  });

  it("refuses a wrong password to delete an account, and the account stays", async () => {
    await expect(carol.session.deleteAccount("not my password")).rejects.toThrow();
    await carol.session.sendMessage(`user:${alice.userId}`, { text: "still here" });
    await waitFor(() => alice.texts(`user:${carol.userId}`).includes("still here"), "carol's message");
  });
});
