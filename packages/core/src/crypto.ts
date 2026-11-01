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

/** Who a sign-in key is for. It's only any use on that server, for that account. */
export interface SignInTarget {
  serverUrl: string;
  username: string;
}

const signInContext = ({ serverUrl, username }: SignInTarget) => `${serverUrl}|${username.toLowerCase()}`;

export interface PasswordKeys {
  /** Sent to the server to sign in. Bound to it, so another server can't reuse it. */
  authKey: Uint8Array;
  /** Accounts from before that have a hash of this, which is never sent. */
  legacyAuthKey: Uint8Array;
  wrapKey: Uint8Array;
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
    legacyAuthKey: wasm.hkdfSha256(master, NO_SALT, label("zuna/auth/v1"), 32),
    wrapKey: wasm.hkdfSha256(master, NO_SALT, label("zuna/wrap/v1"), 32),
    slotKey: wasm.hkdfSha256(master, NO_SALT, label(`zuna/slot/v1|password|${signInContext(target)}`), 32),
  };
}

export interface RecoveryKeys {
  authKey: Uint8Array;
  legacyAuthKey: Uint8Array;
  wrapKey: Uint8Array;
  slotKey: Uint8Array;
}

export function deriveRecoveryKeys(recoveryKey: Uint8Array, target: SignInTarget): RecoveryKeys {
  return {
    authKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label(`zuna/recovery-auth/v2|${signInContext(target)}`), 32),
    legacyAuthKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label("zuna/recovery-auth/v1"), 32),
    wrapKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label("zuna/recovery-wrap/v1"), 32),
    slotKey: wasm.hkdfSha256(recoveryKey, NO_SALT, label(`zuna/slot/v1|recovery|${signInContext(target)}`), 32),
  };
}

/**
 * Proves knowing an older sign-in key without sending it, in a way that's only
 * good for this server and this challenge, so an account can move to a new key.
 */
export function upgradeProof(kind: "password" | "recovery", legacyKey: Uint8Array, salt: Uint8Array, challenge: Uint8Array, target: SignInTarget): Uint8Array {
  const stored = wasm.sha256(concat(salt, legacyKey));
  const info = `zuna/auth-upgrade/v1|${kind}|${target.serverUrl}|${target.username.toLowerCase()}|${toBase64(challenge)}`;
  return wasm.hkdfSha256(stored, NO_SALT, utf8(info), 32);
}

export const wrapAccountKey = (wrapKey: Uint8Array, accountKey: Uint8Array, kind: "password" | "recovery") =>
  wasm.aeadSeal(wrapKey, accountKey, label(`zuna/account-key/${kind}`));

export const unwrapAccountKey = (wrapKey: Uint8Array, wrapped: Uint8Array, kind: "password" | "recovery") =>
  wasm.aeadOpen(wrapKey, wrapped, label(`zuna/account-key/${kind}`));

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
  /** The identity key the account began with, which clients from before generations still go by. */
  rootPublic: Uint8Array;
  rootSecret: Uint8Array;
  /** Account keys of generations that may still have items in the vault. */
  olderKeys: Record<number, Uint8Array>;
  /** A contact who hasn't heard yet may still seal a grant to one of these. */
  olderHpkeSecrets: Uint8Array[];
  /** The account key the old kind of wrapper opens, while one of them is left. */
  firstKey: Uint8Array | null;
  /** Nothing from before this generation is believed any more. */
  closedBelow: number;
  /** What to seal the account key to for a password and recovery key. */
  slots: Partial<Record<SlotKind, SlotPublic>>;
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
    firstKey: core.firstKey && toBase64(core.firstKey),
    closedBelow: core.closedBelow,
    slots: { password: slotToJson(core.slots.password), recovery: slotToJson(core.slots.recovery) },
  };
}

/** Reads a core, including one from before generations, which has only the first five fields. */
export function coreFromJson(json: any): VaultCore {
  const identityPublic = fromBase64(json.identityPublic);
  const identitySecret = fromBase64(json.identitySecret);
  const slots: VaultCore["slots"] = {};
  const password = slotFromJson(json.slots?.password);
  const recovery = slotFromJson(json.slots?.recovery);
  if (password) slots.password = password;
  if (recovery) slots.recovery = recovery;
  return {
    identityPublic,
    identitySecret,
    hpkePublic: fromBase64(json.hpkePublic),
    hpkeSecret: fromBase64(json.hpkeSecret),
    communityKey: fromBase64(json.communityKey),
    generation: json.generation ?? 0,
    rootPublic: json.rootPublic ? fromBase64(json.rootPublic) : identityPublic,
    rootSecret: json.rootSecret ? fromBase64(json.rootSecret) : identitySecret,
    olderKeys: Object.fromEntries(Object.entries<string>(json.olderKeys ?? {}).map(([generation, key]) => [generation, fromBase64(key)])),
    olderHpkeSecrets: (json.olderHpkeSecrets ?? []).map(fromBase64),
    firstKey: json.firstKey ? fromBase64(json.firstKey) : null,
    closedBelow: json.closedBelow ?? 0,
    slots,
  };
}

/** A generation's label says which account it's for. The first keeps the one from before there were any. */
const coreLabel = (generation: number, userId: string) => label(generation > 0 ? `zuna/vault-core/v2|${userId}|${generation}` : "zuna/vault-core/v1");

export function sealVaultCore(accountKey: Uint8Array, core: VaultCore, userId = ""): Uint8Array {
  return wasm.aeadSeal(accountKey, utf8(JSON.stringify(coreToJson(core))), coreLabel(core.generation, userId));
}

export function openVaultCore(accountKey: Uint8Array, sealed: Uint8Array, generation = 0, userId = ""): VaultCore {
  return coreFromJson(JSON.parse(fromUtf8(wasm.aeadOpen(accountKey, sealed, coreLabel(generation, userId)))));
}

const vaultItemLabel = (id: string, generation: number) => label(generation > 0 ? `zuna/vault-item/v2|${generation}|${id}` : `zuna/vault-item/${id}`);

export const sealVaultItem = (accountKey: Uint8Array, id: string, data: Uint8Array, generation = 0) =>
  wasm.aeadSeal(accountKey, data, vaultItemLabel(id, generation));

export const openVaultItem = (accountKey: Uint8Array, id: string, sealed: Uint8Array, generation = 0) =>
  wasm.aeadOpen(accountKey, sealed, vaultItemLabel(id, generation));

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
 * user's identity key and names the key that device signs with. Certificates are
 * public, so holding one proves nothing: a leaf only belongs to a device if it
 * really uses the signing key its certificate names.
 *
 * `rootSecret` signs for clients from before generations, which know no other
 * identity key. `headSecret`, the identity key of the generation the certificate
 * names, signs for those that follow them. A certificate without it is what a
 * client from before generations made.
 */
export function createCertificate(rootSecret: Uint8Array, cert: DeviceCertificate, headSecret?: Uint8Array): Uint8Array {
  const fields = { v: 1, user: cert.userId, device: cert.deviceId, key: toBase64(cert.signatureKey) };
  const payload = utf8(JSON.stringify(headSecret ? { ...fields, gen: cert.generation ?? 0 } : fields));
  const signature = wasm.sign(rootSecret, concat(label("zuna/device-cert/v1"), payload));
  if (!headSecret) return utf8(JSON.stringify({ p: toBase64(payload), s: toBase64(signature) }));
  const head = wasm.sign(headSecret, concat(label("zuna/device-cert/v2"), payload));
  return utf8(JSON.stringify({ p: toBase64(payload), s: toBase64(signature), h: toBase64(head) }));
}

export function parseCertificate(bytes: Uint8Array): (DeviceCertificate & { generation: number; payload: Uint8Array; signature: Uint8Array; headSignature: Uint8Array | null }) | null {
  try {
    const outer = JSON.parse(fromUtf8(bytes));
    const payload = fromBase64(outer.p);
    const inner = JSON.parse(fromUtf8(payload));
    if (inner.v !== 1 || typeof inner.user !== "string" || typeof inner.device !== "string" || typeof inner.key !== "string") return null;
    const generation = inner.gen ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0) return null;
    return {
      userId: inner.user,
      deviceId: inner.device,
      signatureKey: fromBase64(inner.key),
      generation,
      payload,
      signature: fromBase64(outer.s),
      headSignature: typeof outer.h === "string" ? fromBase64(outer.h) : null,
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

/** Checks a certificate against the identity key of the generation it names. */
export function verifyCertificateAtGeneration(identityPublic: Uint8Array, bytes: Uint8Array): DeviceCertificate | null {
  const cert = parseCertificate(bytes);
  if (!cert?.headSignature) return null;
  return wasm.verify(identityPublic, concat(label("zuna/device-cert/v2"), cert.payload), cert.headSignature) ? cert : null;
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

const profileHeadInput = (userId: string, generation: number, ciphertext: Uint8Array) => concat(label(`zuna/profile-sig/v2|${userId}|${generation}|`), ciphertext);

/** A sealed profile keeps its signature by the first identity key. This one is by the current key. */
export const signProfileAtGeneration = (identitySecret: Uint8Array, userId: string, generation: number, sealed: Uint8Array) =>
  wasm.sign(identitySecret, profileHeadInput(userId, generation, sealed.subarray(64)));

export function openProfileAtGeneration<T>(communityKey: Uint8Array, identityPublic: Uint8Array, userId: string, username: string, generation: number, sealed: Uint8Array, signature: Uint8Array): T | null {
  if (sealed.length < 64) return null;
  const ciphertext = sealed.subarray(64);
  if (!wasm.verify(identityPublic, profileHeadInput(userId, generation, ciphertext), signature)) return null;
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

/**
 * The authenticated data says what a message is, not who wrote it, so a body says
 * that itself, under the signature. A body from before this says nothing, which is fine.
 */
export function namesItsSender(body: unknown, user: string, device: string): boolean {
  const by = (body as { by?: { user?: unknown; device?: unknown } } | null)?.by;
  return by === undefined || (by?.user === user && by?.device === device);
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

const SIGNED_SIGNAL = 2;

/**
 * A reaction or a read position, as an envelope its device signed. What says whose
 * it is, and what it's about, is the signature and the authenticated data, so the
 * server can't pass it off as someone else's or move it to another message.
 */
export function frameSigned(deviceId: string, epoch: number, envelope: Uint8Array): Uint8Array {
  const device = utf8(deviceId);
  return concat(new Uint8Array([SIGNED_SIGNAL, device.length]), device, u32Bytes(epoch), envelope);
}

/** What `frameSigned` made, or null for what isn't one: anything from before, whose first byte is never this. */
export function readSigned(framed: Uint8Array): { deviceId: string; epoch: number; envelope: Uint8Array } | null {
  if (framed[0] !== SIGNED_SIGNAL || framed.length < 2) return null;
  const end = 2 + framed[1]!;
  if (framed.length < end + 4) return null;
  return { deviceId: fromUtf8(framed.subarray(2, end)), epoch: readU32(framed.subarray(end)), envelope: framed.subarray(end + 4) };
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

const detailsSignatureInput = (groupId: string, version: number, signer: Signer, details: string) =>
  concat(label(`zuna/group-details-sig/v1|${groupId}|${version}|${signer.userId}|${signer.deviceId}|`), wasm.sha256(utf8(details)));

/**
 * A group's details, signed by the admin's device that set them, with a version
 * so an older copy can't be served again. The details are readable outside the
 * signed part too, for clients from before they were signed.
 */
export function signGroupDetails(groupId: string, details: object, version: number, signer: Signer, deviceSecret: Uint8Array): object {
  const text = JSON.stringify(details);
  const signature = wasm.sign(deviceSecret, detailsSignatureInput(groupId, version, signer, text));
  return { ...details, signed: { details: text, version, user: signer.userId, device: signer.deviceId, signature: toBase64(signature) } };
}

export interface SignedGroupDetails {
  details: unknown;
  version: number;
  signer: Signer;
  signedBy(devicePublic: Uint8Array): boolean;
}

/** The signed part of a group's details, or null if there's none or it's malformed. */
export function readSignedGroupDetails(groupId: string, value: unknown): SignedGroupDetails | null {
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
      signedBy: (devicePublic) => wasm.verify(devicePublic, detailsSignatureInput(groupId, version, signer, details), fromBase64(signature)),
    };
  } catch {
    return null;
  }
}

// --- Reactions ---

/** The ID of a reaction from before they were signed. Anyone could work out what one was from it, so new ones have a random ID. */
export function reactionId(userId: string, messageId: string, key: string): string {
  return toHex(wasm.sha256(utf8(`zuna/reaction/v1|${userId}|${messageId}|${key}`)).subarray(0, 16));
}

// --- Emoji verification ---

const SAFETY_EMOJI_COUNT = 16;
const safetyCache = new Map<string, { emoji: string; name: string }[]>();

/**
 * The anti-MITM check. Both people see the same emoji only if each of their
 * apps holds the other's real identity key. Sixteen emoji from a set of 64 give
 * 96 bits, from Argon2id, which makes each attempt at keys whose emoji match
 * cost memory as well as time. Apps from before showed twelve, so the count
 * itself shows when one side needs updating.
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
