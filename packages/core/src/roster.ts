// A group's roster: who its admins are and who has been let in. It lives in the
// group's MLS context (ROSTER_EXTENSION in crypto/src/mls.rs), so every member holds
// the same one and only a commit can change it. Each version is signed by the device
// that wrote it and names the one before, so a device holding one version can tell
// whether the next could have come from someone allowed to write it. The server's
// list of who's in a group, and who's its admin, only decides what the server does.

import * as wasm from "@zuna/crypto";
import { concat, equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from "./encoding";
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
export function rosterStep(prev: SignedRoster, next: SignedRoster, context: RosterContext): string | null {
  const before = prev.roster;
  const after = next.roster;
  const signer = after.by.userId;
  if (after.group !== before.group || after.version !== before.version + 1 || after.prev !== rosterHash(prev.bytes)) {
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
export function rosterJump(held: SignedRoster, next: SignedRoster, context: RosterContext): string | null {
  if (next.roster.version === held.roster.version) return equalBytes(next.bytes, held.bytes) ? null : "it's another version of the one held";
  if (next.roster.version < held.roster.version) return "it's older than the one held";
  if (next.roster.version === held.roster.version + 1) return rosterStep(held, next, context);
  return held.roster.admins.includes(next.roster.by.userId) ? null : "whoever made it wasn't an admin when this device last knew";
}
