// Key derivation and message framing. The primitives themselves live in Rust;
// this file decides which keys protect what, and binds ciphertext to its context.

import * as wasm from "@zuna/crypto";
import {
  concat,
  equalBytes,
  fromBase64,
  fromUtf8,
  readU32,
  toBase64,
  toHex,
  u32Bytes,
  u64Bytes,
  utf8,
} from "./encoding";
import { SAFETY_EMOJI } from "./safety-emoji";

export const CONTENT_LABEL = "zuna/content/v1";

export interface KdfParams {
  salt: Uint8Array;
  memory: number;
  iterations: number;
  parallelism: number;
}

// Clients refuse to derive keys with less than this, so that a malicious server
// can't weaken a user's password protection by handing out cheap parameters.
const MIN_KDF_MEMORY = 32 << 10;
const MIN_KDF_ITERATIONS = 2;

export const DEFAULT_KDF = { memory: 64 << 10, iterations: 3, parallelism: 1 };

const label = (text: string) => utf8(text);
const NO_SALT = new Uint8Array(0);

export const randomId = (): string => toHex(wasm.randomBytes(16));

export interface PasswordKeys {
  authKey: Uint8Array;
  wrapKey: Uint8Array;
}

export function derivePasswordKeys(password: string, kdf: KdfParams): PasswordKeys {
  if (kdf.memory < MIN_KDF_MEMORY || kdf.iterations < MIN_KDF_ITERATIONS || kdf.parallelism < 1) {
    throw new Error("The server asked for unsafely weak password settings. Not continuing.");
  }
  const master = wasm.argon2id(utf8(password.normalize("NFKC")), kdf.salt, kdf.memory, kdf.iterations, kdf.parallelism, 32);
  return {
    authKey: wasm.hkdfSha256(master, NO_SALT, label("zuna/auth/v1"), 32),
    wrapKey: wasm.hkdfSha256(master, NO_SALT, label("zuna/wrap/v1"), 32),
  };
}

export interface RecoveryKeys {
  authKey: Uint8Array;
  wrapKey: Uint8Array;
}

export function deriveRecoveryKeys(recoveryKey: Uint8Array): RecoveryKeys {
  return {
    authKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label("zuna/recovery-auth/v1"), 32),
    wrapKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label("zuna/recovery-wrap/v1"), 32),
  };
}

export const wrapAccountKey = (wrapKey: Uint8Array, accountKey: Uint8Array, kind: "password" | "recovery") =>
  wasm.aeadSeal(wrapKey, accountKey, label(`zuna/account-key/${kind}`));

export const unwrapAccountKey = (wrapKey: Uint8Array, wrapped: Uint8Array, kind: "password" | "recovery") =>
  wasm.aeadOpen(wrapKey, wrapped, label(`zuna/account-key/${kind}`));

/** The secrets every device of an account shares, stored on the server encrypted. */
export interface VaultCore {
  identityPublic: Uint8Array;
  identitySecret: Uint8Array;
  hpkePublic: Uint8Array;
  hpkeSecret: Uint8Array;
  communityKey: Uint8Array;
}

export function sealVaultCore(accountKey: Uint8Array, core: VaultCore): Uint8Array {
  const json = JSON.stringify({
    identityPublic: toBase64(core.identityPublic),
    identitySecret: toBase64(core.identitySecret),
    hpkePublic: toBase64(core.hpkePublic),
    hpkeSecret: toBase64(core.hpkeSecret),
    communityKey: toBase64(core.communityKey),
  });
  return wasm.aeadSeal(accountKey, utf8(json), label("zuna/vault-core/v1"));
}

export function openVaultCore(accountKey: Uint8Array, sealed: Uint8Array): VaultCore {
  const json = JSON.parse(fromUtf8(wasm.aeadOpen(accountKey, sealed, label("zuna/vault-core/v1"))));
  return {
    identityPublic: fromBase64(json.identityPublic),
    identitySecret: fromBase64(json.identitySecret),
    hpkePublic: fromBase64(json.hpkePublic),
    hpkeSecret: fromBase64(json.hpkeSecret),
    communityKey: fromBase64(json.communityKey),
  };
}

export const sealVaultItem = (accountKey: Uint8Array, id: string, data: Uint8Array) =>
  wasm.aeadSeal(accountKey, data, label(`zuna/vault-item/${id}`));

export const openVaultItem = (accountKey: Uint8Array, id: string, sealed: Uint8Array) =>
  wasm.aeadOpen(accountKey, sealed, label(`zuna/vault-item/${id}`));

// --- Identity and device certificates ---

const hpkeSignatureInput = (hpkePublic: Uint8Array) => concat(label("zuna/hpke-key/v1"), hpkePublic);

export const signHpkeKey = (identitySecret: Uint8Array, hpkePublic: Uint8Array) =>
  wasm.sign(identitySecret, hpkeSignatureInput(hpkePublic));

export const verifyHpkeKey = (identityPublic: Uint8Array, hpkePublic: Uint8Array, signature: Uint8Array) =>
  wasm.verify(identityPublic, hpkeSignatureInput(hpkePublic), signature);

export interface DeviceCertificate {
  userId: string;
  deviceId: string;
  signatureKey: Uint8Array;
}

/**
 * A device certificate is the MLS credential of each device. It is signed by the
 * user's identity key, so a device can't be added to a group on someone's behalf
 * without that key, including by the server.
 */
export function createCertificate(identitySecret: Uint8Array, cert: DeviceCertificate): Uint8Array {
  const payload = utf8(
    JSON.stringify({ v: 1, user: cert.userId, device: cert.deviceId, key: toBase64(cert.signatureKey) }),
  );
  const signature = wasm.sign(identitySecret, concat(label("zuna/device-cert/v1"), payload));
  return utf8(JSON.stringify({ p: toBase64(payload), s: toBase64(signature) }));
}

export function parseCertificate(bytes: Uint8Array): (DeviceCertificate & { payload: Uint8Array; signature: Uint8Array }) | null {
  try {
    const outer = JSON.parse(fromUtf8(bytes));
    const payload = fromBase64(outer.p);
    const inner = JSON.parse(fromUtf8(payload));
    if (inner.v !== 1 || typeof inner.user !== "string" || typeof inner.device !== "string") return null;
    return {
      userId: inner.user,
      deviceId: inner.device,
      signatureKey: fromBase64(inner.key),
      payload,
      signature: fromBase64(outer.s),
    };
  } catch {
    return null;
  }
}

/** Checks a certificate against the identity key pinned for its user. */
export function verifyCertificate(identityPublic: Uint8Array, bytes: Uint8Array): DeviceCertificate | null {
  const cert = parseCertificate(bytes);
  if (!cert) return null;
  const valid = wasm.verify(identityPublic, concat(label("zuna/device-cert/v1"), cert.payload), cert.signature);
  return valid ? cert : null;
}

// --- Encrypted profiles ---

/** Profiles are readable by server members only, and signed by their owner. */
export function sealProfile(communityKey: Uint8Array, identitySecret: Uint8Array, username: string, profile: object): Uint8Array {
  const ciphertext = wasm.aeadSeal(communityKey, utf8(JSON.stringify(profile)), label(`zuna/profile/v1/${username.toLowerCase()}`));
  const signature = wasm.sign(identitySecret, concat(label("zuna/profile-sig/v1"), ciphertext));
  return concat(signature, ciphertext);
}

export function openProfile<T>(communityKey: Uint8Array, identityPublic: Uint8Array, username: string, sealed: Uint8Array): T | null {
  if (sealed.length < 64) return null;
  const signature = sealed.subarray(0, 64);
  const ciphertext = sealed.subarray(64);
  if (!wasm.verify(identityPublic, concat(label("zuna/profile-sig/v1"), ciphertext), signature)) return null;
  try {
    return JSON.parse(fromUtf8(wasm.aeadOpen(communityKey, ciphertext, label(`zuna/profile/v1/${username.toLowerCase()}`))));
  } catch {
    return null;
  }
}

// --- Message content ---

/** Padding hides the exact length of messages from the server. */
const PADDING_BLOCK = 256;

function pad(data: Uint8Array): Uint8Array {
  const total = Math.ceil((data.length + 4) / PADDING_BLOCK) * PADDING_BLOCK;
  const out = new Uint8Array(total);
  out.set(u32Bytes(data.length), 0);
  out.set(data, 4);
  return out;
}

function unpad(data: Uint8Array): Uint8Array {
  const length = readU32(data);
  if (length + 4 > data.length) throw new Error("bad padding");
  return data.subarray(4, 4 + length);
}

export type ContentKind = "message" | "reaction" | "meta" | "read" | "typing";

const contentAad = (kind: ContentKind, groupId: string, itemId: string, epoch: number) =>
  concat(label(`zuna/${kind}/v1|${groupId}|${itemId}|`), u64Bytes(epoch));

const signatureInput = (aad: Uint8Array, ciphertext: Uint8Array) =>
  concat(label("zuna/envelope-sig/v1"), wasm.sha256(aad), wasm.sha256(ciphertext));

/**
 * Encrypts content under an epoch key and signs it with the sender's device key.
 * All members share the epoch key, so only the signature proves who wrote this.
 * Wire format: signature(64) || nonce || ciphertext.
 */
export function sealEnvelope(
  epochKey: Uint8Array,
  deviceSecret: Uint8Array,
  kind: ContentKind,
  groupId: string,
  itemId: string,
  epoch: number,
  value: unknown,
): Uint8Array {
  const aad = contentAad(kind, groupId, itemId, epoch);
  const ciphertext = wasm.aeadSeal(epochKey, pad(utf8(JSON.stringify(value))), aad);
  return concat(wasm.sign(deviceSecret, signatureInput(aad, ciphertext)), ciphertext);
}

export type OpenResult<T> = { ok: true; value: T } | { ok: false; reason: "signature" | "decrypt" };

export function openEnvelope<T>(
  epochKey: Uint8Array,
  devicePublic: Uint8Array,
  kind: ContentKind,
  groupId: string,
  itemId: string,
  epoch: number,
  sealed: Uint8Array,
): OpenResult<T> {
  if (sealed.length < 64) return { ok: false, reason: "decrypt" };
  const signature = sealed.subarray(0, 64);
  const ciphertext = sealed.subarray(64);
  const aad = contentAad(kind, groupId, itemId, epoch);
  if (!wasm.verify(devicePublic, signatureInput(aad, ciphertext), signature)) {
    return { ok: false, reason: "signature" };
  }
  try {
    return { ok: true, value: JSON.parse(fromUtf8(unpad(wasm.aeadOpen(epochKey, ciphertext, aad)))) };
  } catch {
    return { ok: false, reason: "decrypt" };
  }
}

/** Unsigned sealing for short-lived signals where only members need to read it. */
export function sealSignal(key: Uint8Array, kind: ContentKind, groupId: string, epoch: number, value: unknown): Uint8Array {
  const body = wasm.aeadSeal(key, pad(utf8(JSON.stringify(value))), contentAad(kind, groupId, "signal", epoch));
  return concat(u32Bytes(epoch), body);
}

export function signalEpoch(sealed: Uint8Array): number {
  return readU32(sealed);
}

export function openSignal<T>(key: Uint8Array, kind: ContentKind, groupId: string, sealed: Uint8Array): T | null {
  try {
    const epoch = readU32(sealed);
    const plain = wasm.aeadOpen(key, sealed.subarray(4), contentAad(kind, groupId, "signal", epoch));
    return JSON.parse(fromUtf8(unpad(plain)));
  } catch {
    return null;
  }
}

// --- History sharing ---

export const sealHistoryGrant = (recipientHpke: Uint8Array, groupId: string, keys: Record<number, string>) =>
  wasm.hpkeSeal(recipientHpke, label("zuna/history-grant/v1"), label(groupId), utf8(JSON.stringify(keys)));

export function openHistoryGrant(hpkeSecret: Uint8Array, groupId: string, sealed: Uint8Array): Record<string, string> {
  return JSON.parse(fromUtf8(wasm.hpkeOpen(hpkeSecret, label("zuna/history-grant/v1"), label(groupId), sealed)));
}

// --- Reactions ---

/** A deterministic ID makes reacting idempotent: the same reaction can't exist twice. */
export function reactionId(userId: string, messageId: string, key: string): string {
  return toHex(wasm.sha256(utf8(`zuna/reaction/v1|${userId}|${messageId}|${key}`)).subarray(0, 16));
}

// --- Emoji verification ---

/**
 * The anti-MITM check. Both people see the same emoji only if each of their
 * apps holds the other's real identity key. Twelve emoji from a set of 64 give
 * 72 bits, on top of an iterated hash that makes grinding for a match expensive.
 */
export function safetyEmoji(ownIdentity: Uint8Array, peerIdentity: Uint8Array): { emoji: string; name: string }[] {
  const digest = wasm.safetyDigest(ownIdentity, peerIdentity);
  const out: { emoji: string; name: string }[] = [];
  let bitOffset = 0;
  for (let i = 0; i < 12; i++) {
    const byteIndex = bitOffset >> 3;
    const shift = bitOffset & 7;
    const value = ((digest[byteIndex]! | (digest[byteIndex + 1]! << 8)) >> shift) & 63;
    out.push(SAFETY_EMOJI[value]!);
    bitOffset += 6;
  }
  return out;
}

export { equalBytes };
