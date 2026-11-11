// The log of who holds which keys, as devices read it: the tree a server hashes its
// entries into, as RFC 6962 hashes one, the records everyone gets and the tags in them,
// the heads the server signs, and the bodies of entries. Pure functions on the
// `sha256` and `verify` every host gives. The server's half is server/internal/merkle,
// held to the same vectors (test/fixtures/log-vectors.json), and the design is
// docs/KEY_TRANSPARENCY_PLAN.md.

import * as wasm from "@zuna/crypto";
import { concat, equalBytes, fromBase64, fromBase64Url, fromUtf8, toBase64, toBase64Url, u32Bytes, u64Bytes, utf8 } from "./encoding";

export const HASH_BYTES = 32;
export const NONCE_BYTES = 16;
export const TAG_BYTES = 16;
export const RECORD_BYTES = NONCE_BYTES + 2 * TAG_BYTES + HASH_BYTES;

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

/** The root of a tree with nothing in it. */
export const emptyRoot = (): Uint8Array => wasm.sha256(new Uint8Array(0));

export const leafHash = (record: Uint8Array): Uint8Array => wasm.sha256(concat(LEAF, record));

export const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array => wasm.sha256(concat(NODE, left, right));

/**
 * A tree of some size, as the roots of the full subtrees it's made of, the largest
 * first: one for each bit of its size. It's all a device keeps to add to the tree and
 * work out its root.
 */
export class Frontier {
  constructor(
    public size = 0,
    public roots: Uint8Array[] = [],
  ) {}

  append(leaf: Uint8Array): void {
    this.roots.push(leaf);
    // Each subtree the new leaf completes joins the one before it.
    for (let n = this.size; n % 2 === 1; n = Math.floor(n / 2)) {
      const right = this.roots.pop()!;
      const left = this.roots.pop()!;
      this.roots.push(nodeHash(left, right));
    }
    this.size++;
  }

  /** Its subtrees joined from the smallest, which is where RFC 6962 splits a tree: at the largest power of two below its size. */
  root(): Uint8Array {
    if (this.roots.length === 0) return emptyRoot();
    let root = this.roots[this.roots.length - 1]!;
    for (let i = this.roots.length - 2; i >= 0; i--) root = nodeHash(this.roots[i]!, root);
    return root;
  }

  clone(): Frontier {
    return new Frontier(this.size, [...this.roots]);
  }

  toJSON(): { size: number; roots: string[] } {
    return { size: this.size, roots: this.roots.map(toBase64) };
  }

  /** Null unless it has as many roots as its size has bits. */
  static from(value: { size: number; roots: string[] }): Frontier | null {
    if (!Number.isSafeInteger(value?.size) || value.size < 0 || !Array.isArray(value.roots)) return null;
    let bits = 0;
    for (let n = value.size; n > 0; n = Math.floor(n / 2)) bits += n % 2;
    if (value.roots.length !== bits) return null;
    const roots = value.roots.map(fromBase64);
    return roots.every((root) => root.length === HASH_BYTES) ? new Frontier(value.size, roots) : null;
  }
}

// --- Records ---

export interface RecordParts {
  nonce: Uint8Array;
  userTag: Uint8Array;
  nameTag: Uint8Array;
  bodyHash: Uint8Array;
}

export function readRecord(record: Uint8Array): RecordParts | null {
  if (record.length !== RECORD_BYTES) return null;
  return {
    nonce: record.subarray(0, NONCE_BYTES),
    userTag: record.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES),
    nameTag: record.subarray(NONCE_BYTES + TAG_BYTES, NONCE_BYTES + 2 * TAG_BYTES),
    bodyHash: record.subarray(NONCE_BYTES + 2 * TAG_BYTES),
  };
}

const tagOf = (label: string, value: string, nonce: Uint8Array) => wasm.sha256(concat(utf8(`${label}${value}|`), nonce)).subarray(0, TAG_BYTES);

/** What says a record is about an account, to whoever knows its ID, and nobody else. */
export const userTag = (user: string, nonce: Uint8Array): Uint8Array => tagOf("zuna/log/user/v1|", user, nonce);

/** What says an account's first record is under a username, to whoever knows the name. Another entry's is random. */
export const nameTag = (username: string, nonce: Uint8Array): Uint8Array => tagOf("zuna/log/name/v1|", username.toLowerCase(), nonce);

export const bodyHash = (nonce: Uint8Array, body: Uint8Array): Uint8Array => wasm.sha256(concat(utf8("zuna/log/body/v1|"), nonce, body));

// --- Bodies ---

/** What an entry says, as its JSON gives it, with hashes and keys as bytes. */
export type LogBody =
  | { t: "account"; user: string; username: string; root: Uint8Array; hpke: Uint8Array; hpkeSig: Uint8Array }
  | { t: "device"; user: string; device: string; key: Uint8Array; cert: Uint8Array; enroll: Uint8Array; seal: Uint8Array }
  | { t: "certificate"; user: string; device: string; cert: Uint8Array }
  | { t: "seal"; user: string; device: string; gen: number; seal: Uint8Array }
  | { t: "revoked"; user: string; device: string }
  | { t: "link"; user: string; gen: number; link: Uint8Array }
  | { t: "deleted"; user: string };

const ID = /^[0-9a-f]{32}$/;

/** A body as the server sent it, every field held to what it can be, or null. */
export function parseBody(bytes: Uint8Array): LogBody | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fromUtf8(bytes));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.v !== 1 || typeof raw.user !== "string" || !ID.test(raw.user)) return null;
  const user = raw.user;
  const bytesOf = (value: unknown, length: number): Uint8Array | null => {
    if (typeof value !== "string") return null;
    try {
      const decoded = fromBase64(value);
      return decoded.length === length ? decoded : null;
    } catch {
      return null;
    }
  };
  const device = typeof raw.device === "string" && ID.test(raw.device) ? raw.device : null;
  const hash = (field: string) => bytesOf(raw[field], HASH_BYTES);
  switch (raw.t) {
    case "account": {
      const root = bytesOf(raw.root, 32);
      const hpke = bytesOf(raw.hpke, 32);
      const hpkeSig = bytesOf(raw.hpke_sig, 64);
      // A deleted account's username is gone when the log is written again.
      if (typeof raw.username !== "string" || raw.username.length > 64 || !root || !hpke || !hpkeSig) return null;
      return { t: "account", user, username: raw.username, root, hpke, hpkeSig };
    }
    case "device": {
      const key = bytesOf(raw.key, 32);
      const [cert, enroll, seal] = [hash("cert"), hash("enroll"), hash("seal")];
      return device && key && cert && enroll && seal ? { t: "device", user, device, key, cert, enroll, seal } : null;
    }
    case "certificate": {
      const cert = hash("cert");
      return device && cert ? { t: "certificate", user, device, cert } : null;
    }
    case "seal": {
      const seal = hash("seal");
      return device && seal && Number.isSafeInteger(raw.gen) && (raw.gen as number) >= 0 ? { t: "seal", user, device, gen: raw.gen as number, seal } : null;
    }
    case "revoked":
      return device ? { t: "revoked", user, device } : null;
    case "link": {
      const link = hash("link");
      return link && Number.isSafeInteger(raw.gen) && (raw.gen as number) >= 1 ? { t: "link", user, gen: raw.gen as number, link } : null;
    }
    case "deleted":
      return { t: "deleted", user };
  }
  return null;
}

/**
 * Whether a body is the one its record is for: it hashes to it, the account it names
 * is the one its user tag is for, and an account's username the one its name tag is
 * for. So a server can't file an entry about someone under a tag they wouldn't know.
 */
export function bodyFits(parts: RecordParts, bytes: Uint8Array, body: LogBody): boolean {
  if (!equalBytes(bodyHash(parts.nonce, bytes), parts.bodyHash)) return false;
  if (!equalBytes(userTag(body.user, parts.nonce), parts.userTag)) return false;
  return body.t !== "account" || equalBytes(nameTag(body.username, parts.nonce), parts.nameTag);
}

/** What an entry holds of a certificate, an enrollment proof or a link's payload. */
export const entryHash = (data: Uint8Array): Uint8Array => wasm.sha256(data);

/** What an entry holds of a device's seal key: the key, its generation and the device's proof of the two. */
export const sealHash = (key: Uint8Array, generation: number, proof: Uint8Array): Uint8Array => wasm.sha256(concat(key, u64Bytes(generation), proof));

// --- Heads ---

/** The log at some size. One the server gives is signed with its log key. */
export interface LogHead {
  era: number;
  size: number;
  root: Uint8Array;
  sig?: Uint8Array;
}

export const headInput = (era: number, size: number, root: Uint8Array): Uint8Array => concat(utf8("zuna/log/head/v1|"), u64Bytes(era), u64Bytes(size), root);

export function headSigned(key: Uint8Array, head: LogHead): boolean {
  return !!head.sig && head.root.length === HASH_BYTES && wasm.verify(key, headInput(head.era, head.size, head.root), head.sig);
}

/** A head as signed messages carry it. */
export interface WireHead {
  e: number;
  n: number;
  r: string;
  s: string;
}

export const toWireHead = (head: LogHead): WireHead => ({ e: head.era, n: head.size, r: toBase64(head.root), s: toBase64(head.sig ?? new Uint8Array(0)) });

export function fromWireHead(value: unknown): LogHead | null {
  const wire = value as Partial<WireHead> | null;
  if (!wire || typeof wire !== "object" || !Number.isSafeInteger(wire.e) || !Number.isSafeInteger(wire.n) || wire.e! < 1 || wire.n! < 0) return null;
  if (typeof wire.r !== "string" || typeof wire.s !== "string") return null;
  try {
    const root = fromBase64(wire.r);
    const sig = fromBase64(wire.s);
    return root.length === HASH_BYTES && sig.length === 64 ? { era: wire.e!, size: wire.n!, root, sig } : null;
  } catch {
    return null;
  }
}

/** The log's key and a head an inviter held, as an invite link carries them after `&log=`. */
export interface PinnedHead {
  key: Uint8Array;
  era: number;
  size: number;
  root: Uint8Array;
}

export const linkHead = (head: PinnedHead): string => toBase64Url(concat(head.key, u32Bytes(head.era), u64Bytes(head.size), head.root));

export function parseLinkHead(text: string | null | undefined): PinnedHead | null {
  if (!text) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(text);
  } catch {
    return null;
  }
  if (bytes.length !== 32 + 4 + 8 + HASH_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const era = view.getUint32(32);
  const size = Number(view.getBigUint64(36));
  if (era < 1 || !Number.isSafeInteger(size)) return null;
  return { key: bytes.slice(0, 32), era, size, root: bytes.slice(44) };
}
