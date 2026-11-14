// A group's roster: who its admins are and who has been let in. It lives in the
// group's MLS context (ROSTER_EXTENSION in crypto/src/mls.rs), so every member holds
// the same one and only a commit can change it. Each version is signed by the device
// that wrote it and names the one before, so a device holding one version can tell
// whether the next could have come from someone allowed to write it. The server's
// list of who's in a group, and who's its admin, only decides what the server does.
//
// A direct message and a channel have a charter there instead, which says what the
// conversation is, and for a direct message who it's between. It's written once, by
// whoever starts the conversation, and never changes. So what a conversation is comes
// from its own state, which the server can't write, and never from the server's word.

import * as wasm from "@zuna/crypto";
import { concat, fromBase64, fromUtf8, toBase64, utf8 } from "./encoding";
import type { Signer } from "./crypto";

export interface Roster {
  group: string;
  version: number;
  admins: string[];
  /** In the order they were let in. */
  members: string[];
  /** The hash of the version before, empty for the first. */
  prev: string;
  by: Signer;
}

export interface SignedRoster {
  roster: Roster;
  bytes: Uint8Array;
  signedBy(devicePublic: Uint8Array): boolean;
}

/** What may change a roster from one version to the next, besides an admin. */
export interface RosterContext {
  /** Whether any of the earlier version's admins is still in the group, as the server lists it. */
  adminPresent: boolean;
  /** Whether the server lists whoever signed the next version as an admin. */
  signerServerAdmin: boolean;
}

const LABEL = "zuna/group-roster/v1";
const MAX_PEOPLE = 10_000;

const signatureInput = (group: string, text: string) => concat(utf8(`${LABEL}|${group}|`), wasm.sha256(utf8(text)));

export const rosterHash = (bytes: Uint8Array): string => toBase64(wasm.sha256(bytes));

/**
 * A roster as a device holds one to compare the next with: what it says, and its hash. A device
 * holds the signed bytes themselves, and an account's manifest keeps this much of each group's
 * for its other devices, which is all that judging the next one takes.
 */
export interface HeldRoster {
  roster: Pick<Roster, "group" | "version" | "admins" | "members">;
  hash: string;
}

export const heldRoster = (signed: SignedRoster): HeldRoster => ({ roster: signed.roster, hash: rosterHash(signed.bytes) });

/**
 * Whether going from `held` back to `older` would let nobody in again, and make nobody an
 * admin again: everyone the older one names, the held one names too.
 */
export const readmitsNobody = (older: Pick<Roster, "admins" | "members">, held: Pick<Roster, "admins" | "members">): boolean =>
  older.members.every((id) => held.members.includes(id)) && older.admins.every((id) => held.admins.includes(id));

/** Signs a roster as the device given, for a group's context. */
export function sealRoster(roster: Roster, deviceSecret: Uint8Array): Uint8Array {
  const text = JSON.stringify({ v: 1, ...roster, admins: [...roster.admins].sort() });
  return utf8(JSON.stringify({ r: text, s: toBase64(wasm.sign(deviceSecret, signatureInput(roster.group, text))) }));
}

const people = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_PEOPLE && value.every((id) => typeof id === "string" && id.length > 0) && new Set(value).size === value.length;

/** What a group's roster says, without believing it, or null if it isn't one for this group. */
export function readRoster(groupId: string, bytes: Uint8Array): SignedRoster | null {
  try {
    const outer = JSON.parse(fromUtf8(bytes));
    if (typeof outer?.r !== "string" || typeof outer.s !== "string") return null;
    const raw = JSON.parse(outer.r);
    const fine =
      raw?.v === 1 &&
      raw.kind === undefined &&
      raw.group === groupId &&
      Number.isSafeInteger(raw.version) &&
      raw.version >= 1 &&
      people(raw.admins) &&
      people(raw.members) &&
      raw.admins.every((id: string) => raw.members.includes(id)) &&
      typeof raw.prev === "string" &&
      typeof raw.by?.userId === "string" &&
      typeof raw.by?.deviceId === "string";
    if (!fine) return null;
    const roster: Roster = { group: raw.group, version: raw.version, admins: raw.admins, members: raw.members, prev: raw.prev, by: { userId: raw.by.userId, deviceId: raw.by.deviceId } };
    const signature = fromBase64(outer.s);
    return { roster, bytes, signedBy: (devicePublic) => wasm.verify(devicePublic, signatureInput(groupId, outer.r), signature) };
  } catch {
    return null;
  }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => b[index] === id);

/**
 * Why `next` can't directly follow `prev`, or null if it can. An admin may change
 * anything. Anyone may take themselves out. With none of the admins left in the
 * group, whoever the server made its admin may take over, and change nothing else.
 * The signature is the caller's to check.
 */
export function rosterStep(prev: HeldRoster, next: SignedRoster, context: RosterContext): string | null {
  const before = prev.roster;
  const after = next.roster;
  const signer = after.by.userId;
  if (after.group !== before.group || after.version !== before.version + 1 || after.prev !== prev.hash) {
    return "it doesn't follow from the version before";
  }
  if (before.admins.includes(signer)) return null;
  const without = (list: string[]) => list.filter((id) => id !== signer);
  if (before.members.includes(signer) && sameList(after.members, without(before.members)) && sameSet(after.admins, without(before.admins))) return null;
  if (before.members.includes(signer) && !context.adminPresent && context.signerServerAdmin && sameList(after.members, before.members) && sameSet(after.admins, [signer])) return null;
  return "whoever made it wasn't allowed to";
}

/**
 * Why a device holding `held` can't take on `next`, which came with a group it's
 * joining again: the same version, the one right after it, or a later one an admin
 * of the held version signed. Never an older one.
 */
export function rosterJump(held: HeldRoster, next: SignedRoster, context: RosterContext): string | null {
  if (next.roster.version === held.roster.version) return rosterHash(next.bytes) === held.hash ? null : "it's another version of the one held";
  if (next.roster.version < held.roster.version) return "it's older than the one held";
  if (next.roster.version === held.roster.version + 1) return rosterStep(held, next, context);
  return held.roster.admins.includes(next.roster.by.userId) ? null : "whoever made it wasn't an admin when this device last knew";
}

/** What a direct message or a channel is, as the charter in its MLS context says. */
export interface Charter {
  group: string;
  kind: "dm" | "channel";
  /** A direct message's people: both, or the one for saved messages. A channel has none. */
  people: string[];
  by: Signer;
}

export interface SignedCharter {
  charter: Charter;
  bytes: Uint8Array;
  signedBy(devicePublic: Uint8Array): boolean;
}

const CHARTER_LABEL = "zuna/conversation-charter/v1";

const charterInput = (group: string, text: string) => concat(utf8(`${CHARTER_LABEL}|${group}|`), wasm.sha256(utf8(text)));

/** Signs a direct message's or a channel's charter as the device given, for its context. */
export function sealCharter(charter: Charter, deviceSecret: Uint8Array): Uint8Array {
  const text = JSON.stringify({ v: 1, kind: charter.kind, group: charter.group, people: [...charter.people].sort(), by: charter.by });
  return utf8(JSON.stringify({ r: text, s: toBase64(wasm.sign(deviceSecret, charterInput(charter.group, text))) }));
}

/** What a charter says, without believing it, or null if it isn't one for this conversation. */
export function readCharter(groupId: string, bytes: Uint8Array): SignedCharter | null {
  try {
    const outer = JSON.parse(fromUtf8(bytes));
    if (typeof outer?.r !== "string" || typeof outer.s !== "string") return null;
    const raw = JSON.parse(outer.r);
    const fine =
      raw?.v === 1 &&
      (raw.kind === "dm" || raw.kind === "channel") &&
      raw.group === groupId &&
      people(raw.people) &&
      (raw.kind === "dm" ? raw.people.length >= 1 && raw.people.length <= 2 : raw.people.length === 0) &&
      typeof raw.by?.userId === "string" &&
      typeof raw.by?.deviceId === "string";
    if (!fine) return null;
    const charter: Charter = { group: raw.group, kind: raw.kind, people: raw.people, by: { userId: raw.by.userId, deviceId: raw.by.deviceId } };
    const signature = fromBase64(outer.s);
    return { charter, bytes, signedBy: (devicePublic) => wasm.verify(devicePublic, charterInput(groupId, outer.r), signature) };
  } catch {
    return null;
  }
}

/** What a conversation's MLS context says it is: a group, by its roster, or what its charter says. */
export type Founding = { kind: "group"; signed: SignedRoster } | { kind: "dm" | "channel"; signed: SignedCharter };

/** Reads whatever a conversation's context holds, or null if it's neither a roster nor a charter. */
export function readFounding(groupId: string, bytes: Uint8Array): Founding | null {
  const roster = readRoster(groupId, bytes);
  if (roster) return { kind: "group", signed: roster };
  const charter = readCharter(groupId, bytes);
  return charter ? { kind: charter.charter.kind, signed: charter } : null;
}

/** Who signed what a conversation's context holds. */
export const foundingSigner = (founding: Founding): Signer => (founding.kind === "group" ? founding.signed.roster.by : founding.signed.charter.by);
