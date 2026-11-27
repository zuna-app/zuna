// Whose key a group's history is sealed to, when someone is added, with a server set on reading it.
// These drive real clients against a real server, which the tests stand in for where it lies to one device.

import { describe, expect, it } from "vitest";
import { ApiError, type ApiUser } from "../src/api";
import { openHistoryGrant, signHpkeKey } from "../src/crypto";
import { toBase64 } from "../src/encoding";
import { TestApp, waitFor } from "./helpers";
import { alice, apiOf, groupWith, person, sentAndSeen, sessionOf, startServer } from "./security-setup";

startServer({ perTest: true });

/** Every history grant `app`'s device sends with a commit. */
function grantsSentBy(app: TestApp): { user_id: string; data: Uint8Array }[] {
  const api = apiOf(app) as any;
  const commit = api.commit;
  const grants: { user_id: string; data: Uint8Array }[] = [];
  api.commit = (groupId: string, body: { history_grants?: { user_id: string; data: Uint8Array }[] }) => {
    grants.push(...(body.history_grants ?? []));
    return commit(groupId, body);
  };
  return grants;
}

/** Whether any of the grants made out to `userId` opens with `secret`. */
const opensWith = (grants: { user_id: string; data: Uint8Array }[], groupId: string, userId: string, secret: Uint8Array) =>
  grants
    .filter((grant) => grant.user_id === userId)
    .some((grant) => {
      try {
        return Object.keys(openHistoryGrant(secret, groupId, userId, grant.data).keys).length > 0;
      } catch {
        return false;
      }
    });

const historyOf = async (app: TestApp, groupId: string) => (await app.session.loadMessages(groupId)).messages.map((item) => item.text);

describe("a history grant", () => {
  it("is never sealed to a key the server lists for someone this device holds no pin for (Z-26)", async () => {
    const ann = await person("ann");
    const carl = await person("carl");
    // An account of the server's own, whose keys it lists for whoever ann hasn't met yet.
    const xavier = await person("xavier");
    const groupId = await groupWith(ann, [carl], true, "History");
    await sentAndSeen(ann, [carl], groupId, "said before anyone new came");

    const session = sessionOf(ann);
    const api = apiOf(ann) as any;
    const core = sessionOf(xavier).account.core;
    const known = new Set([alice.userId, ann.userId, carl.userId, xavier.userId]);
    const forged = (user: ApiUser): ApiUser =>
      !user || known.has(user.id)
        ? user
        : {
            ...user,
            identity_key: toBase64(core.identityPublic),
            key_generation: 0,
            hpke_key: toBase64(core.hpkePublic),
            hpke_key_sig: toBase64(signHpkeKey(core.identitySecret, core.hpkePublic)),
          };
    const real = { log: api.log, user: api.user, users: api.users, onFrame: session.onFrame };
    // From here ann's device is given no more of the log, so it can't take anyone new's key from it.
    api.log = async () => {
      throw new ApiError(503, "unavailable", "The log can't be read just now.");
    };
    api.user = async (id: string) => forged(await real.user(id));
    api.users = async (since?: number) => {
      const answer = await real.users(since);
      return { ...answer, users: answer.users.map(forged) };
    };
    session.onFrame = (frame: { t: string; d: any }) => real.onFrame.call(session, frame.t === "user" ? { ...frame, d: forged(frame.d) } : frame);
    const grants = grantsSentBy(ann);
    let bob: TestApp;
    try {
      bob = await person("bob");
      await session.ensureUser(bob.userId, true);
      expect(session.pinnedIdentity(bob.userId)).toBeNull();

      // Alice, whom ann's device knows, comes in with bob, whom it doesn't.
      const refused = await ann.session.addMembers(groupId, [alice.userId, bob.userId]).then(
        () => null,
        (error: unknown) => error,
      );
      expect(opensWith(grants, groupId, bob.userId, core.hpkeSecret)).toBe(false);
      expect(refused).toMatchObject({ code: "unchecked_member" });
    } finally {
      api.log = real.log;
      api.user = real.user;
      api.users = real.users;
      session.onFrame = real.onFrame;
    }

    // With the log read, bob's key is the one it names, and both are added with what came before.
    await ann.session.addMembers(groupId, [alice.userId, bob.userId]);
    expect(opensWith(grants, groupId, bob.userId, core.hpkeSecret)).toBe(false);
    await waitFor(async () => (await historyOf(bob, groupId)).includes("said before anyone new came"), "the history to reach bob", 30_000);
    await waitFor(async () => (await historyOf(alice, groupId)).includes("said before anyone new came"), "the history to reach alice", 30_000);
  });

  it("is never sealed to a key someone left behind, while the server keeps back the link the log names (Z-26)", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const dora = await person("dora");
    const groupId = await groupWith(ann, [dora], true, "History");
    await sentAndSeen(ann, [dora], groupId, "said before bob came");

    const session = sessionOf(ann);
    const api = apiOf(ann) as any;
    await session.ensureUser(bob.userId, true);
    expect(session.pinnedIdentity(bob.userId)).not.toBeNull();
    // What the server listed of bob before he replaced his keys, and the key he left behind, which someone who
    // stole his old device could hold.
    const before: ApiUser = await api.user(bob.userId);
    const left = sessionOf(bob).account.core.hpkeSecret.slice();
    const real = { user: api.user, users: api.users, identityLinks: api.identityLinks, onFrame: session.onFrame };
    const stale = (user: ApiUser): ApiUser => (user?.id === bob.userId ? { ...user, identity_key: before.identity_key, key_generation: 0, hpke_key: before.hpke_key, hpke_key_sig: before.hpke_key_sig } : user);
    api.user = async (id: string) => stale(await real.user(id));
    api.users = async (since?: number) => {
      const answer = await real.users(since);
      return { ...answer, users: answer.users.map(stale) };
    };
    api.identityLinks = async (id: string, after: number) => (id === bob.userId ? [] : real.identityLinks(id, after));
    session.onFrame = (frame: { t: string; d: any }) => real.onFrame.call(session, frame.t === "user" ? { ...frame, d: stale(frame.d) } : frame);
    const grants = grantsSentBy(ann);
    try {
      await bob.session.rotate();
      await waitFor(() => session.loggedGeneration(bob.userId) === 1, "ann's device to read in the log that bob's keys were replaced", 30_000);
      expect(session.headGeneration(bob.userId)).toBe(0);

      const refused = await ann.session.addMembers(groupId, [alice.userId, bob.userId]).then(
        () => null,
        (error: unknown) => error,
      );
      expect(opensWith(grants, groupId, bob.userId, left)).toBe(false);
      expect(refused).toMatchObject({ code: "unchecked_member" });
    } finally {
      api.user = real.user;
      api.users = real.users;
      api.identityLinks = real.identityLinks;
      session.onFrame = real.onFrame;
    }

    // With the link handed over, the grant is sealed to the key bob has now.
    await ann.session.addMembers(groupId, [alice.userId, bob.userId]);
    expect(session.headGeneration(bob.userId)).toBe(1);
    expect(opensWith(grants, groupId, bob.userId, left)).toBe(false);
    await waitFor(async () => (await historyOf(bob, groupId)).includes("said before bob came"), "the history to reach bob", 30_000);
  });
});
