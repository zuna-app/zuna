// A server that keeps what the log says of someone from one person, under the one signed head
// everyone holds: it sends that account's records bare, and fails or trims the request for their
// bodies. Whoever it does that to holds that account's devices as unchecked, and is told.

import { describe, expect, it } from "vitest";
import { ApiError, decode, type ApiUser } from "../src/api";
import { TestApp, sleep, waitFor } from "./helpers";
import { logSize } from "./log-setup";
import { groupWith, person, securityEvents, sessionOf, startServer } from "./security-setup";

startServer({ perTest: true });

const WITHHELD = "The server is withholding part of someone's key record from this device.";

/** Erin with a second device that dave counts as hers, and what the server answers dave with, to change. */
async function setUp() {
  const dave = await person("dave");
  const erin = await person("erin");
  const session = sessionOf(dave);
  await waitFor(() => session.users.has(erin.userId), "dave to know erin");
  const phone = await new TestApp("erin-phone").open();
  await phone.login(sessionOf(erin).account.serverUrl, erin.session.getSelf().username);
  const phoneId = phone.session.getSelf().deviceId;
  await waitFor(() => session.users.get(erin.userId)?.devices.get(phoneId)?.revoked === false, "dave to count erin's phone");
  await session.syncLog();
  const listed = (await session.api.user(erin.userId)).devices.find((device: { id: string }) => device.id === phoneId)!;
  const real = { log: session.api.log, logBodies: session.api.logBodies, user: session.api.user, users: session.api.users, identityLinks: session.api.identityLinks, onFrame: session.onFrame };
  const restore = () => {
    Object.assign(session.api, { log: real.log, logBodies: real.logBodies, user: real.user, users: real.users, identityLinks: real.identityLinks });
    session.onFrame = real.onFrame;
  };
  /** From here records about erin come to dave without their bodies. */
  const bare = () => {
    session.api.log = async (...args: Parameters<typeof real.log>) => {
      const page = await real.log.apply(session.api, args);
      return { ...page, records: page.records.map((record: { body?: string | null }) => (record.body && atob(record.body).includes(erin.userId) ? { ...record, body: null } : record)) };
    };
  };
  const readToEnd = () =>
    waitFor(async () => {
      await session.syncLog();
      return session.logState().frontier.size === logSize();
    }, "dave to read the log to its end");
  return { dave, erin, phone, phoneId, session, listed, real, restore, bare, readToEnd };
}

const withheldWarnings = (app: TestApp, from: number) => securityEvents(app).slice(from).filter((event) => (event as { message: string }).message === WITHHELD);

describe("what the log says of someone, kept back from one person", () => {
  for (const [how, refuse] of [
    ["a 500", () => Promise.reject(new ApiError(500, "internal", "Something went wrong."))],
    ["a network error", () => Promise.reject(new ApiError(0, "network", "Couldn't reach the server."))],
  ] as const) {
    it(`holds their devices unchecked, and warns, when asking for it fails with ${how}`, async () => {
      const { dave, erin, phone, phoneId, session, listed, real, restore, bare, readToEnd } = await setUp();
      const groupId = await groupWith(dave, [erin], false, "Dave and Erin");
      const key = `group:${groupId}`;
      await waitFor(() => sessionOf(phone).hasMlsGroup(groupId), "erin's phone to come into the group");
      const snapshot: ApiUser = await real.user.call(session.api, erin.userId);
      // Erin's own app would take the phone out of the group itself; the server refuses it that.
      const erinsApi = sessionOf(erin).api;
      const commit = erinsApi.commit;
      erinsApi.commit = async (id: string, body: unknown) => {
        if (id === groupId) throw new ApiError(503, "unavailable", "The server is busy.");
        return commit.call(erinsApi, id, body);
      };
      let asked = 0;
      bare();
      session.api.logBodies = async () => {
        asked++;
        return refuse();
      };
      // What the server says of erin outside the log stays what it was, as it always could.
      session.api.user = async (id: string) => (id === erin.userId ? snapshot : real.user.call(session.api, id));
      session.api.users = async (...args: Parameters<typeof real.users>) => {
        const response = await real.users.apply(session.api, args);
        return { ...response, users: response.users.map((user: ApiUser) => (user.id === erin.userId ? snapshot : user)) };
      };
      session.api.identityLinks = async (id: string, after: number) => (id === erin.userId ? [] : real.identityLinks.call(session.api, id, after));
      session.onFrame = (frame: { t: string; d: { id?: string } }) => {
        if (frame.t === "user" && frame.d?.id === erin.userId) return;
        real.onFrame.call(session, frame);
      };
      const warningsBefore = securityEvents(dave).length;
      try {
        await erin.session.revokeDevice(phoneId);
        await waitFor(() => sessionOf(erin).account.core.generation === 1, "erin's keys to be replaced", 40_000);
        await sessionOf(erin).syncLog();
        await readToEnd();
        expect(asked).toBeGreaterThan(0);
        expect(session.withheldUsers.has(erin.userId)).toBe(true);

        // Nothing goes to erin's devices, and none of her key packages is taken.
        const leaf = session.treeMembers(groupId).find((member: { deviceId: string }) => member.deviceId === phoneId);
        expect(leaf).toMatchObject({ unchecked: true, genuine: false });
        const sent = dave.session.sendMessage(key, { text: "while the log is kept back" });
        await expect(session.claimKeyPackages(erin.userId, groupId)).rejects.toMatchObject({ code: "unchecked_member" });
        // Asked again, as often as it fails, and dave is told.
        await waitFor(
          async () => {
            session.lookForWithheld([erin.userId]);
            await sleep(100);
            return withheldWarnings(dave, warningsBefore).length > 0;
          },
          "dave to be told",
          30_000,
        );
        expect(session.messageRow(groupId, sent.id)?.status).toBe("sending");
        expect(await session.api.message(groupId, sent.id).catch(() => null)).toBeNull();

        // Given the bodies, dave knows the phone is gone, and what waited goes, without it.
        restore();
        session.lookForWithheld();
        const certificate = decode(listed.certificate);
        await waitFor(() => session.logStanding(erin.userId, phoneId, decode(listed.signature_key), certificate) === "gone", "dave to learn of the removal");
        expect(session.withheldUsers.has(erin.userId)).toBe(false);
        await waitFor(() => erin.texts(key).includes("while the log is kept back"), "erin to read it", 60_000);
        expect(session.treeMembers(groupId).map((member: { deviceId: string }) => member.deviceId)).not.toContain(phoneId);
      } finally {
        restore();
        erinsApi.commit = commit;
        phone.client.stop();
      }
    });
  }

  it("takes no answer that leaves out what was read before", async () => {
    const { dave, erin, phone, phoneId, session, listed, real, restore, bare, readToEnd } = await setUp();
    try {
      // Dave reads erin's removal of the phone, with its body.
      await erin.session.revokeDevice(phoneId);
      await waitFor(() => sessionOf(erin).account.core.generation === 1, "erin's keys to be replaced", 40_000);
      await readToEnd();
      const signatureKey = decode(listed.signature_key);
      const certificate = decode(listed.certificate);
      await waitFor(() => session.logStanding(erin.userId, phoneId, signatureKey, certificate) === "gone", "dave to read the removal");
      const removal = (await real.logBodies.call(session.api, erin.userId)).bodies.find((item: { body: string }) => {
        const body = JSON.parse(atob(item.body)) as { t: string; device?: string };
        return body.t === "revoked" && body.device === phoneId;
      })!.idx;

      // What the log says of erin next comes bare, and her bodies come back without the removal.
      bare();
      session.api.logBodies = async (id: string) => {
        const answer = await real.logBodies.call(session.api, id);
        return id === erin.userId ? { ...answer, bodies: answer.bodies.filter((item: { idx: number }) => item.idx !== removal) } : answer;
      };
      const warningsBefore = securityEvents(dave).length;
      const laptop = await new TestApp("erin-laptop").open();
      await laptop.login(sessionOf(erin).account.serverUrl, erin.session.getSelf().username);
      laptop.client.stop();
      await readToEnd();
      await waitFor(() => withheldWarnings(dave, warningsBefore).length > 0, "dave to be told");
      expect(session.logStanding(erin.userId, phoneId, signatureKey, certificate)).toBe("gone");
      expect(session.withheldUsers.has(erin.userId)).toBe(true);
    } finally {
      restore();
      phone.client.stop();
    }
  });
});
