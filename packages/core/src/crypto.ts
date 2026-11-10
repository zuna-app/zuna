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
import type { SlotKind, SlotPublic } from "./generations";
import { SAFETY_EMOJI } from "./safety-emoji";

export const CONTENT_LABEL = "zuna/content/v1";

export interface KdfParams {
  salt: Uint8Array;
  memory: number;
  iterations: number;
  parallelism: number;
}

// Clients refuse to derive keys with less than this, so that a malicious server
// can't weaken a user's password protection by handing out cheap parameters. Every
// account has used at least these from the start. The most is what servers accept,
// so a malicious server can't make the app run out of memory either.
const MIN_KDF_MEMORY = 64 << 10;
const MIN_KDF_ITERATIONS = 3;
const MAX_KDF_MEMORY = 1 << 20;
const MAX_KDF_ITERATIONS = 16;
const MAX_KDF_PARALLELISM = 8;
const KDF_SALT_BYTES = 16;

export const DEFAULT_KDF = { memory: 64 << 10, iterations: 3, parallelism: 1 };

const label = (text: string) => utf8(text);
const NO_SALT = new Uint8Array(0);

export const randomId = (): string => toHex(wasm.randomBytes(16));

/** What a long-term key protects. Each gets a key of its own, so no two kinds of data are ever under one key. */
export type KeyPurpose = "vault-core" | "vault-item" | "read" | "profile" | "channel" | "sound";

export const subkey = (key: Uint8Array, purpose: KeyPurpose): Uint8Array => wasm.hkdfSha256(key, NO_SALT, label(`zuna/subkey/v1|${purpose}`), 32);

/** Who a sign-in key is for. It's only any use on that server, for that account. */
export interface SignInTarget {
  serverUrl: string;
  username: string;
}

const signInContext = ({ serverUrl, username }: SignInTarget) => `${serverUrl}|${username.toLowerCase()}`;

export interface PasswordKeys {
  /** Sent to the server to sign in. Bound to it, so another server can't reuse it. */
  authKey: Uint8Array;
  /** Opens this secret's slot. */
  slotKey: Uint8Array;
}

export function derivePasswordKeys(password: string, kdf: KdfParams, target: SignInTarget): PasswordKeys {
  const valid =
    kdf.memory >= MIN_KDF_MEMORY &&
    kdf.memory <= MAX_KDF_MEMORY &&
    kdf.iterations >= MIN_KDF_ITERATIONS &&
    kdf.iterations <= MAX_KDF_ITERATIONS &&
    kdf.parallelism >= 1 &&
    kdf.parallelism <= MAX_KDF_PARALLELISM &&
    kdf.salt.length === KDF_SALT_BYTES;
  if (!valid) throw new Error("The server asked for unsafe password settings. Not continuing.");
  const master = wasm.argon2id(utf8(password.normalize("NFKC")), kdf.salt, kdf.memory, kdf.iterations, kdf.parallelism, 32);
  return {
    authKey: wasm.hkdfSha256(master, NO_SALT, label(`zuna/auth/v2|${signInContext(target)}`), 32),
    slotKey: wasm.hkdfSha256(master, NO_SALT, label(`zuna/slot/v1|password|${signInContext(target)}`), 32),
  };
}

export interface RecoveryKeys {
  authKey: Uint8Array;
  slotKey: Uint8Array;
}

export function deriveRecoveryKeys(recoveryKey: Uint8Array, target: SignInTarget): RecoveryKeys {
  return {
    authKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label(`zuna/recovery-auth/v2|${signInContext(target)}`), 32),
    slotKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label(`zuna/slot/v1|recovery|${signInContext(target)}`), 32),
  };
}

/**
 * The secrets every device of an account shares, stored on the server encrypted.
 * The identity and HPKE keys are those of this generation. Everything below
 * them is about older ones, and an account that never rotated has none of it.
 */
export interface VaultCore {
  identityPublic: Uint8Array;
  identitySecret: Uint8Array;
  hpkePublic: Uint8Array;
  hpkeSecret: Uint8Array;
  communityKey: Uint8Array;
  generation: number;
  /** The identity key the account began with, where its chain starts. */
  rootPublic: Uint8Array;
  /** Shows that a core is really the account's when someone signs in (`holdsRoot`). */
  rootSecret: Uint8Array;
  /** Account keys of generations that may still have items in the vault. */
  olderKeys: Record<number, Uint8Array>;
  /** A contact who hasn't heard yet may still seal a grant to one of these. */
  olderHpkeSecrets: Uint8Array[];
  /** Nothing from before this generation is believed any more. */
  closedBelow: number;
  /** What to seal the account key to for a password and recovery key. */
  slots: Partial<Record<SlotKind, SlotPublic>>;
  /** The vault's manifest had reached at least this when the core was sealed, so a new device knows not to settle for less. */
  manifest?: number;
}

const slotToJson = (slot: SlotPublic | undefined) => slot && { seal: toBase64(slot.seal), sign: toBase64(slot.sign) };
const slotFromJson = (slot: { seal: string; sign: string } | undefined) => slot && { seal: fromBase64(slot.seal), sign: fromBase64(slot.sign) };

export function coreToJson(core: VaultCore) {
  return {
    identityPublic: toBase64(core.identityPublic),
    identitySecret: toBase64(core.identitySecret),
    hpkePublic: toBase64(core.hpkePublic),
    hpkeSecret: toBase64(core.hpkeSecret),
    communityKey: toBase64(core.communityKey),
    generation: core.generation,
    rootPublic: toBase64(core.rootPublic),
    rootSecret: toBase64(core.rootSecret),
    olderKeys: Object.fromEntries(Object.entries(core.olderKeys).map(([generation, key]) => [generation, toBase64(key)])),
    olderHpkeSecrets: core.olderHpkeSecrets.map(toBase64),
    closedBelow: core.closedBelow,
    slots: { password: slotToJson(core.slots.password), recovery: slotToJson(core.slots.recovery) },
    manifest: core.manifest ?? 0,
  };
}

export function coreFromJson(json: any): VaultCore {
  const slots: VaultCore["slots"] = {};
  const password = slotFromJson(json.slots?.password);
  const recovery = slotFromJson(json.slots?.recovery);
  if (password) slots.password = password;
  if (recovery) slots.recovery = recovery;
  return {
    identityPublic: fromBase64(json.identityPublic),
    identitySecret: fromBase64(json.identitySecret),
    hpkePublic: fromBase64(json.hpkePublic),
    hpkeSecret: fromBase64(json.hpkeSecret),
    communityKey: fromBase64(json.communityKey),
    generation: json.generation,
    rootPublic: fromBase64(json.rootPublic),
    rootSecret: fromBase64(json.rootSecret),
    olderKeys: Object.fromEntries(Object.entries<string>(json.olderKeys).map(([generation, key]) => [generation, fromBase64(key)])),
    olderHpkeSecrets: json.olderHpkeSecrets.map(fromBase64),
    closedBelow: json.closedBelow,
    slots,
    manifest: Number.isSafeInteger(json.manifest) ? json.manifest : 0,
  };
}

/** A generation's label says which account it's for. The first one's doesn't need to, since no link names its key. */
const coreLabel = (generation: number, userId: string) => label(generation > 0 ? `zuna/vault-core/v2|${userId}|${generation}` : "zuna/vault-core/v1");

export function sealVaultCore(accountKey: Uint8Array, core: VaultCore, userId = ""): Uint8Array {
  return wasm.aeadSeal(subkey(accountKey, "vault-core"), utf8(JSON.stringify(coreToJson(core))), coreLabel(core.generation, userId));
}

export function openVaultCore(accountKey: Uint8Array, sealed: Uint8Array, generation = 0, userId = ""): VaultCore {
  return coreFromJson(JSON.parse(fromUtf8(wasm.aeadOpen(subkey(accountKey, "vault-core"), sealed, coreLabel(generation, userId)))));
}

const vaultItemLabel = (id: string, generation: number) => label(generation > 0 ? `zuna/vault-item/v2|${generation}|${id}` : `zuna/vault-item/${id}`);

export const sealVaultItem = (accountKey: Uint8Array, id: string, data: Uint8Array, generation = 0) =>
  wasm.aeadSeal(subkey(accountKey, "vault-item"), data, vaultItemLabel(id, generation));

export const openVaultItem = (accountKey: Uint8Array, id: string, sealed: Uint8Array, generation = 0) =>
  wasm.aeadOpen(subkey(accountKey, "vault-item"), sealed, vaultItemLabel(id, generation));

/** The vault item listing everything an account trusts, or its first part (manifest.ts). */
export const MANIFEST_ID = "manifest";

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
  /** Which generation's identity key this is signed by. */
  generation?: number;
}

/**
 * A device certificate is the MLS credential of each device. It is signed by the
 * user's identity key of the generation it names, and names the key that device
 * signs with. Certificates are public, so holding one proves nothing: a leaf only
 * belongs to a device if it really uses the signing key its certificate names.
 */
export function createCertificate(identitySecret: Uint8Array, cert: DeviceCertificate): Uint8Array {
  const payload = utf8(JSON.stringify({ v: 1, user: cert.userId, device: cert.deviceId, key: toBase64(cert.signatureKey), gen: cert.generation ?? 0 }));
  const signature = wasm.sign(identitySecret, concat(label("zuna/device-cert/v2"), payload));
  return utf8(JSON.stringify({ p: toBase64(payload), h: toBase64(signature) }));
}

export function parseCertificate(bytes: Uint8Array): (DeviceCertificate & { generation: number; payload: Uint8Array; signature: Uint8Array }) | null {
  try {
    const outer = JSON.parse(fromUtf8(bytes));
    const payload = fromBase64(outer.p);
    const inner = JSON.parse(fromUtf8(payload));
    if (inner.v !== 1 || typeof inner.user !== "string" || typeof inner.device !== "string" || typeof inner.key !== "string" || typeof outer.h !== "string") return null;
    const generation = inner.gen;
    if (!Number.isSafeInteger(generation) || generation < 0) return null;
    return {
      userId: inner.user,
      deviceId: inner.device,
      signatureKey: fromBase64(inner.key),
      generation,
      payload,
      signature: fromBase64(outer.h),
    };
  } catch {
    return null;
  }
}

/** Checks a certificate against the identity key of the generation it names. */
export function verifyCertificate(identityPublic: Uint8Array, bytes: Uint8Array): DeviceCertificate | null {
  const cert = parseCertificate(bytes);
  if (!cert) return null;
  return wasm.verify(identityPublic, concat(label("zuna/device-cert/v2"), cert.payload), cert.signature) ? cert : null;
}

// --- Encrypted profiles ---

/** Profiles are readable by server members only, and signed by their owner. */
export function sealProfile(communityKey: Uint8Array, identitySecret: Uint8Array, username: string, profile: object): Uint8Array {
  const ciphertext = wasm.aeadSeal(subkey(communityKey, "profile"), utf8(JSON.stringify(profile)), label(`zuna/profile/v1/${username.toLowerCase()}`));
  const signature = wasm.sign(identitySecret, concat(label("zuna/profile-sig/v1"), ciphertext));
  return concat(signature, ciphertext);
}

export function openProfile<T>(communityKey: Uint8Array, identityPublic: Uint8Array, username: string, sealed: Uint8Array): T | null {
  if (sealed.length < 64) return null;
  const signature = sealed.subarray(0, 64);
  const ciphertext = sealed.subarray(64);
  if (!wasm.verify(identityPublic, concat(label("zuna/profile-sig/v1"), ciphertext), signature)) return null;
  try {
    return JSON.parse(fromUtf8(wasm.aeadOpen(subkey(communityKey, "profile"), ciphertext, label(`zuna/profile/v1/${username.toLowerCase()}`))));
  } catch {
    return null;
  }
}

const profileHeadInput = (userId: string, generation: number, ciphertext: Uint8Array) => concat(label(`zuna/profile-sig/v2|${userId}|${generation}|`), ciphertext);

/**
 * The signature inside a sealed profile only counts before an account's first
 * rotation, which can't seal it again. From then on, this one by the current key does.
 */
export const signProfileAtGeneration = (identitySecret: Uint8Array, userId: string, generation: number, sealed: Uint8Array) =>
  wasm.sign(identitySecret, profileHeadInput(userId, generation, sealed.subarray(64)));

export function openProfileAtGeneration<T>(communityKey: Uint8Array, identityPublic: Uint8Array, userId: string, username: string, generation: number, sealed: Uint8Array, signature: Uint8Array): T | null {
  if (sealed.length < 64) return null;
  const ciphertext = sealed.subarray(64);
  if (!wasm.verify(identityPublic, profileHeadInput(userId, generation, ciphertext), signature)) return null;
  try {
    return JSON.parse(fromUtf8(wasm.aeadOpen(subkey(communityKey, "profile"), ciphertext, label(`zuna/profile/v1/${username.toLowerCase()}`))));
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

export type ContentKind = "message" | "reaction" | "meta" | "read" | "typing" | "deletion" | "pin" | "channel" | "sound" | "play";

const contentAad = (kind: ContentKind, groupId: string, itemId: string, epoch: number) =>
  concat(label(`zuna/${kind}/v1|${groupId}|${itemId}|`), u64Bytes(epoch));

/** The envelope's version, the first byte inside its encryption. */
const ENVELOPE_VERSION = 3;

/**
 * Binds a signature to the very key it's under. The authenticated data and body alone
 * would let a member seal someone's signed body again under a key of their choosing,
 * and a key from a history grant proves itself by what it opens (`keyProvedItself`).
 */
const keyCommitment = (epochKey: Uint8Array) => wasm.hkdfSha256(epochKey, NO_SALT, label("zuna/envelope-commit/v1"), 32);

/**
 * What a device signs: whose device it's from, what the content is about, which key
 * it's under, and what it says. Nothing proves a device's key isn't also named in
 * another account's certificate, so the signature itself says whose it is.
 */
const signatureInput = (aad: Uint8Array, commitment: Uint8Array, body: Uint8Array, signer: Signer) =>
  concat(label(`zuna/envelope-sig/v3|${signer.userId}|${signer.deviceId}|`), wasm.sha256(aad), commitment, wasm.sha256(body));

/**
 * Encrypts content under an epoch key, signed with the sender's device key. All
 * members share the epoch key, so only the signature proves who wrote it, and it's
 * inside the encryption with who signed, so that the server can't try each
 * member's key on it to find out whose it is.
 * Wire format: nonce || XChaCha20-Poly1305(pad(version || user || device || signature(64) || body)).
 */
export function sealEnvelope(
  epochKey: Uint8Array,
  deviceSecret: Uint8Array,
  kind: ContentKind,
  groupId: string,
  itemId: string,
  epoch: number,
  value: unknown,
  signer: Signer,
): Uint8Array {
  const aad = contentAad(kind, groupId, itemId, epoch);
  const body = utf8(JSON.stringify(value));
  const user = utf8(signer.userId);
  const device = utf8(signer.deviceId);
  if (user.length > 255 || device.length > 255) throw new Error("That account or device ID is too long.");
  const signature = wasm.sign(deviceSecret, signatureInput(aad, keyCommitment(epochKey), body, signer));
  const inner = concat(new Uint8Array([ENVELOPE_VERSION, user.length]), user, new Uint8Array([device.length]), device, signature, body);
  return wasm.aeadSeal(epochKey, pad(inner), aad);
}

/**
 * The authenticated data says what a message is, not who wrote it, so a body says
 * that itself, under the signature.
 */
export function namesItsSender(body: unknown, user: string, device: string): boolean {
  const by = (body as { by?: { user?: unknown; device?: unknown } } | null)?.by;
  return by?.user === user && by?.device === device;
}

/** An envelope opened: who it says it's from, which only `signedBy` proves, and what it says. */
export interface OpenedEnvelope<T> {
  signer: Signer;
  /** What it says, or undefined if that isn't JSON, which nobody's app makes. */
  value: T | undefined;
  /** Whether this device key signed it, as the device it names. */
  signedBy(devicePublic: Uint8Array): boolean;
}

/** Opens an envelope, or gives null for one that doesn't open under this key or isn't one. */
export function openEnvelope<T>(epochKey: Uint8Array, kind: ContentKind, groupId: string, itemId: string, epoch: number, sealed: Uint8Array): OpenedEnvelope<T> | null {
  const aad = contentAad(kind, groupId, itemId, epoch);
  let inner: Uint8Array;
  try {
    inner = unpad(wasm.aeadOpen(epochKey, sealed, aad));
  } catch {
    return null;
  }
  if (inner.length < 2 || inner[0] !== ENVELOPE_VERSION) return null;
  const userEnd = 2 + inner[1]!;
  if (inner.length <= userEnd) return null;
  const deviceEnd = userEnd + 1 + inner[userEnd]!;
  if (inner.length < deviceEnd + 64) return null;
  const signer = { userId: fromUtf8(inner.subarray(2, userEnd)), deviceId: fromUtf8(inner.subarray(userEnd + 1, deviceEnd)) };
  const signature = inner.subarray(deviceEnd, deviceEnd + 64);
  const body = inner.subarray(deviceEnd + 64);
  let value: T | undefined;
  try {
    value = JSON.parse(fromUtf8(body));
  } catch {
    value = undefined;
  }
  return { signer, value, signedBy: (devicePublic) => wasm.verify(devicePublic, signatureInput(aad, keyCommitment(epochKey), body, signer), signature) };
}

/** What became of an envelope this device tried to open and check. */
export type CheckedEnvelope<T> =
  /** Opened, and a device this one knows signed it: what it says is theirs. */
  | { state: "signed"; signer: Signer; value: T }
  /** Opened, naming a device this one doesn't know yet. */
  | { state: "unknown"; signer: Signer }
  /** Opened, but nobody it names signed it, or it isn't well formed: it's nobody's. */
  | { state: "forged" }
  /** Doesn't open under this key. */
  | { state: "closed" };

/** Opens an envelope and checks its signature with the key `device` gives for whoever it names, if any. */
export function checkEnvelope<T>(
  epochKey: Uint8Array,
  kind: ContentKind,
  groupId: string,
  itemId: string,
  epoch: number,
  sealed: Uint8Array,
  device: (signer: Signer) => Uint8Array | undefined,
): CheckedEnvelope<T> {
  const opened = openEnvelope<T>(epochKey, kind, groupId, itemId, epoch, sealed);
  if (!opened) return { state: "closed" };
  if (opened.value === undefined) return { state: "forged" };
  const key = device(opened.signer);
  if (!key) return { state: "unknown", signer: opened.signer };
  return opened.signedBy(key) ? { state: "signed", signer: opened.signer, value: opened.value } : { state: "forged" };
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

const SIGNED_SIGNAL = 3;

/**
 * A reaction, pin, deletion, read position or typing signal, as an envelope its
 * device signed, with the epoch it's under. Who it's from is inside the envelope,
 * and what it's about is in its authenticated data, so the server can't pass it
 * off as someone else's or move it to another message.
 */
export function frameSigned(epoch: number, envelope: Uint8Array): Uint8Array {
  return concat(new Uint8Array([SIGNED_SIGNAL]), u32Bytes(epoch), envelope);
}

/** What `frameSigned` made, or null for what isn't one. */
export function readSigned(framed: Uint8Array): { epoch: number; envelope: Uint8Array } | null {
  if (framed[0] !== SIGNED_SIGNAL || framed.length < 5) return null;
  return { epoch: readU32(framed.subarray(1)), envelope: framed.subarray(5) };
}

// --- History sharing ---

/** A device, for saying who signed something. */
export interface Signer {
  userId: string;
  deviceId: string;
}

const grantSignatureInput = (groupId: string, recipient: string, signer: Signer, keys: string) =>
  concat(label(`zuna/history-grant-sig/v2|${groupId}|${recipient}|${signer.userId}|${signer.deviceId}|`), wasm.sha256(utf8(keys)));

/**
 * Hands older epoch keys to someone joining. Anyone can seal to a public key, so
 * the granting device signs what it's handing over, and to whom.
 */
export function sealHistoryGrant(
  recipientHpke: Uint8Array,
  groupId: string,
  recipient: string,
  signer: Signer,
  deviceSecret: Uint8Array,
  keys: Record<number, string>,
): Uint8Array {
  const text = JSON.stringify(keys);
  const signature = wasm.sign(deviceSecret, grantSignatureInput(groupId, recipient, signer, text));
  const grant = { v: 2, keys: text, user: signer.userId, device: signer.deviceId, signature: toBase64(signature) };
  return wasm.hpkeSeal(recipientHpke, label("zuna/history-grant/v2"), label(groupId), utf8(JSON.stringify(grant)));
}

export interface OpenedHistoryGrant {
  signer: Signer;
  keys: Record<string, string>;
  /** Whether a device key really signed this grant, for this recipient. */
  signedBy(devicePublic: Uint8Array): boolean;
}

export function openHistoryGrant(hpkeSecret: Uint8Array, groupId: string, recipient: string, sealed: Uint8Array): OpenedHistoryGrant {
  const grant = JSON.parse(fromUtf8(wasm.hpkeOpen(hpkeSecret, label("zuna/history-grant/v2"), label(groupId), sealed)));
  if (grant?.v !== 2 || typeof grant.keys !== "string" || typeof grant.user !== "string" || typeof grant.device !== "string" || typeof grant.signature !== "string") {
    throw new Error("That history grant isn't valid.");
  }
  const signer = { userId: grant.user, deviceId: grant.device };
  const keys = JSON.parse(grant.keys);
  if (!keys || typeof keys !== "object") throw new Error("That history grant isn't valid.");
  return {
    signer,
    keys,
    signedBy: (devicePublic) => wasm.verify(devicePublic, grantSignatureInput(groupId, recipient, signer, grant.keys), fromBase64(grant.signature)),
  };
}

// --- Group details ---

/** What signed details are of: a group, a channel or a sound. Each has a label of its own, so one can't be taken for another. */
export type DetailsKind = "group" | "channel" | "sound";

const detailsSignatureInput = (kind: DetailsKind, id: string, version: number, signer: Signer, details: string) =>
  concat(label(`zuna/${kind}-details-sig/v1|${id}|${version}|${signer.userId}|${signer.deviceId}|`), wasm.sha256(utf8(details)));

/**
 * A group's details, or a channel's or sound's, signed by the device that set them,
 * with a version so an older copy can't be served again.
 */
export function signGroupDetails(groupId: string, details: object, version: number, signer: Signer, deviceSecret: Uint8Array, kind: DetailsKind = "group"): object {
  const text = JSON.stringify(details);
  const signature = wasm.sign(deviceSecret, detailsSignatureInput(kind, groupId, version, signer, text));
  return { signed: { details: text, version, user: signer.userId, device: signer.deviceId, signature: toBase64(signature) } };
}

export interface SignedGroupDetails {
  details: unknown;
  version: number;
  signer: Signer;
  signedBy(devicePublic: Uint8Array): boolean;
}

/** The signed part of a group's details, or null if there's none or it's malformed. */
export function readSignedGroupDetails(groupId: string, value: unknown, kind: DetailsKind = "group"): SignedGroupDetails | null {
  const signed = (value as { signed?: Record<string, unknown> } | null)?.signed;
  if (!signed || typeof signed !== "object") return null;
  const { details, version, user, device, signature } = signed;
  if (typeof details !== "string" || typeof version !== "number" || typeof user !== "string" || typeof device !== "string" || typeof signature !== "string") return null;
  try {
    const signer = { userId: user, deviceId: device };
    return {
      details: JSON.parse(details),
      version,
      signer,
      signedBy: (devicePublic) => wasm.verify(devicePublic, detailsSignatureInput(kind, groupId, version, signer, details), fromBase64(signature)),
    };
  } catch {
    return null;
  }
}

// --- Emoji verification ---

const SAFETY_EMOJI_COUNT = 16;
const safetyCache = new Map<string, { emoji: string; name: string }[]>();

/**
 * The anti-MITM check. Both people see the same emoji only if each of their
 * apps holds the other's real identity key. Sixteen emoji from a set of 64 give
 * 96 bits, from Argon2id, which makes each attempt at keys whose emoji match
 * cost memory as well as time.
 */
export function safetyEmoji(ownIdentity: Uint8Array, peerIdentity: Uint8Array): { emoji: string; name: string }[] {
  const cacheKey = `${toHex(ownIdentity)}|${toHex(peerIdentity)}`;
  const cached = safetyCache.get(cacheKey);
  if (cached) return cached;
  const digest = wasm.safetyDigest(ownIdentity, peerIdentity);
  const out: { emoji: string; name: string }[] = [];
  let bitOffset = 0;
  for (let i = 0; i < SAFETY_EMOJI_COUNT; i++) {
    const byteIndex = bitOffset >> 3;
    const shift = bitOffset & 7;
    const value = ((digest[byteIndex]! | (digest[byteIndex + 1]! << 8)) >> shift) & 63;
    out.push(SAFETY_EMOJI[value]!);
    bitOffset += 6;
  }
  // Argon2id takes a moment, and the same pair is asked for again whenever trust is.
  if (safetyCache.size >= 64) safetyCache.delete(safetyCache.keys().next().value!);
  safetyCache.set(cacheKey, out);
  return out;
}

export { equalBytes };
