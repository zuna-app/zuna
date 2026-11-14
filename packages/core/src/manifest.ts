// The vault's manifest: everything in it that decides who an account trusts, written as one
// unit, and how it goes into vault items. An account that has seen thousands of people has a
// manifest larger than one item holds, so it goes in parts, and a device takes it only once
// every part of one write is in: leaving out a part then leaves out the whole manifest, as
// leaving out its one item would, never one person's pin or verification.

import * as wasm from "@zuna/crypto";
import { MANIFEST_ID } from "./crypto";
import { concat, fromUtf8, toBase64, utf8 } from "./encoding";

/**
 * Every pin and verification, by user, as base64 keys, an empty one for a cleared
 * verification, under a number that only goes up.
 */
export interface TrustManifest {
  v: number;
  pins: Record<string, string>;
  verified: Record<string, string>;
  /** How far along each person's chain of keys this account has got. */
  chains: Record<string, { gen: number; hash: string }>;
  /** Up to which generation of their keys each person's verification holds. */
  trust: Record<string, number>;
  prefs?: unknown;
  /**
   * The key the server's log of keys is signed with, and the newest head of it the writing device
   * held, so that a new device of this account starts from what its others checked.
   */
  log?: { key: string; era: number; size: number; root: string };
  /**
   * Each group's roster as this account's devices hold it: its version, hash, admins and
   * members. A device that holds none for a group, as a new one does, holds the one it's
   * given to this, so who's in a group is never the server's to say the first time either.
   */
  rosters?: Record<string, ManifestRoster>;
}

export interface ManifestRoster {
  v: number;
  h: string;
  a: string[];
  m: string[];
}

/** The most of a manifest one vault item holds: with its header and once sealed, well under the server's 256 KiB for an item. */
export const MANIFEST_PART_BYTES = 192 << 10;
/** The most parts a manifest goes in, which with the rest of a rotation stays inside the server's 4 MiB for a request. */
export const MANIFEST_MOST_PARTS = 12;

export interface ManifestPart {
  /** The manifest's number. */
  v: number;
  part: number;
  parts: number;
  /** The SHA-256 of the whole manifest, as base64, so parts of different writes can't be put together. */
  hash: string;
  bytes: Uint8Array;
}

/** The vault item a part goes in: the first in the manifest's own, the rest after it. */
export const manifestPartId = (part: number): string => (part === 0 ? MANIFEST_ID : `${MANIFEST_ID}:${part}`);

export const isManifestPart = (id: string): boolean => id === MANIFEST_ID || id.startsWith(`${MANIFEST_ID}:`);

export function parseManifest(value: unknown): TrustManifest | null {
  const manifest = value as Partial<TrustManifest> | null;
  const record = <T>(value: unknown, fits: (item: unknown) => item is T): value is Record<string, T> =>
    !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(fits);
  const key = (item: unknown): item is string => typeof item === "string";
  const generation = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;
  const position = (item: unknown): item is { gen: number; hash: string } =>
    !!item && typeof item === "object" && generation((item as { gen?: unknown }).gen) && typeof (item as { hash?: unknown }).hash === "string";
  if (!manifest || !Number.isSafeInteger(manifest.v) || manifest.v! < 1 || !record(manifest.pins, key) || !record(manifest.verified, key)) return null;
  if (!record(manifest.chains, position) || !record(manifest.trust, generation)) return null;
  const parsed: TrustManifest = { v: manifest.v!, pins: manifest.pins, verified: manifest.verified, chains: manifest.chains, trust: manifest.trust, prefs: manifest.prefs };
  const log = manifest.log;
  if (log && typeof log === "object" && key(log.key) && generation(log.era) && log.era > 0 && generation(log.size) && key(log.root)) {
    parsed.log = { key: log.key, era: log.era, size: log.size, root: log.root };
  }
  const ids = (item: unknown): item is string[] => Array.isArray(item) && item.every(key);
  const roster = (item: unknown): item is ManifestRoster => {
    const held = item as Partial<ManifestRoster> | null;
    return !!held && typeof held === "object" && generation(held.v) && key(held.h) && ids(held.a) && ids(held.m);
  };
  if (record(manifest.rosters, roster)) {
    parsed.rosters = Object.fromEntries(Object.entries(manifest.rosters).map(([id, held]) => [id, { v: held.v, h: held.h, a: held.a, m: held.m }]));
  }
  return parsed;
}

/**
 * A manifest as the vault items that hold it, usually one, each with the manifest's number as
 * its version. Every part starts with a line naming the manifest's number, which part it is, how
 * many there are and the hash of the whole, then its share of the manifest's bytes. Null if it
 * would take more than MANIFEST_MOST_PARTS.
 */
export function manifestParts(manifest: TrustManifest): { id: string; data: Uint8Array; version: number }[] | null {
  const whole = utf8(JSON.stringify(manifest));
  const parts = Math.max(1, Math.ceil(whole.length / MANIFEST_PART_BYTES));
  if (parts > MANIFEST_MOST_PARTS) return null;
  const hash = toBase64(wasm.sha256(whole));
  return Array.from({ length: parts }, (_, part) => ({
    id: manifestPartId(part),
    data: concat(utf8(`${JSON.stringify({ v: manifest.v, part, parts, hash })}\n`), whole.subarray(part * MANIFEST_PART_BYTES, (part + 1) * MANIFEST_PART_BYTES)),
    version: manifest.v,
  }));
}

/** A part as read from the vault item `id`, or null if it isn't one, or is in an item that isn't its own. */
export function readManifestPart(id: string, data: Uint8Array): ManifestPart | null {
  const end = data.indexOf(0x0a);
  if (end < 0) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(fromUtf8(data.subarray(0, end)));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  const { v, part, parts, hash } = header;
  if (!Number.isSafeInteger(v) || (v as number) < 1 || typeof hash !== "string") return null;
  if (!Number.isSafeInteger(parts) || (parts as number) < 1 || (parts as number) > MANIFEST_MOST_PARTS) return null;
  if (!Number.isSafeInteger(part) || (part as number) < 0 || (part as number) >= (parts as number) || manifestPartId(part as number) !== id) return null;
  return { v: v as number, part: part as number, parts: parts as number, hash, bytes: data.subarray(end + 1) };
}

/**
 * The whole manifest from all its parts, in any order, or null unless there's every part of one
 * write and they make up the manifest their hash names.
 */
export function joinManifestParts(parts: ManifestPart[]): Uint8Array | null {
  const first = parts[0];
  if (!first || parts.length !== first.parts) return null;
  const ordered: (ManifestPart | undefined)[] = new Array(first.parts);
  for (const part of parts) {
    if (part.v !== first.v || part.parts !== first.parts || part.hash !== first.hash || ordered[part.part]) return null;
    ordered[part.part] = part;
  }
  if (ordered.some((part) => !part)) return null;
  const whole = concat(...ordered.map((part) => part!.bytes));
  return toBase64(wasm.sha256(whole)) === first.hash ? whole : null;
}
