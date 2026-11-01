// Generations of an account's keys: what moves an account from one to the next,
// and how a new account key reaches whoever should have it. The design, and what
// this can't do, is in docs/ACCOUNT_KEY_ROTATION.md.

import * as wasm from "@zuna/crypto";
import { concat, equalBytes, fromBase64, fromUtf8, toBase64, utf8 } from "./encoding";

/** What a client and a server say they understand, to speak about generations at all. */
export const ACCOUNT_PROTOCOL = 2;

const label = (text: string) => utf8(text);
const NO_SALT = new Uint8Array(0);
const NOTHING = new Uint8Array(0);

export const hash = (data: Uint8Array): Uint8Array => wasm.sha256(data);

// --- Slots ---

export type SlotKind = "password" | "recovery";

/**
 * The public half of a public-key wrapper for a password or recovery key. Anyone
 * can seal to it. Only someone who knows that secret can open what it unlocks.
 */
export interface SlotPublic {
  seal: Uint8Array;
  sign: Uint8Array;
}

/** A slot as it's first published. */
export interface NewSlot extends SlotPublic {
  kind: SlotKind;
  sealedSecret: Uint8Array;
}

export interface SlotSecrets {
  seal: Uint8Array;
  sign: Uint8Array;
  /**
   * The key the account began with. Anyone can seal a key to a slot, so this is what
   * says whose account that key opens. Only a slot from before this has none.
   */
  root: Uint8Array | null;
}

/** Makes a slot. Its secrets are only ever kept encrypted under the key the secret derives. */
export function createSlot(kind: SlotKind, slotKey: Uint8Array, root: Uint8Array): { slot: NewSlot; secrets: SlotSecrets } {
  const seal = wasm.hpkeKeygen();
  const sign = wasm.signingKeygen();
  const secrets: SlotSecrets = { seal: seal.secretKey as Uint8Array, sign: sign.secretKey as Uint8Array, root };
  const json = JSON.stringify({ seal: toBase64(secrets.seal), sign: toBase64(secrets.sign), root: toBase64(root) });
  return {
    slot: {
      kind,
      seal: seal.publicKey as Uint8Array,
      sign: sign.publicKey as Uint8Array,
      sealedSecret: wasm.aeadSeal(slotKey, utf8(json), label(`zuna/account-slot/v1/secret|${kind}`)),
    },
    secrets,
  };
}

export function openSlot(kind: SlotKind, slotKey: Uint8Array, sealedSecret: Uint8Array): SlotSecrets {
  const json = JSON.parse(fromUtf8(wasm.aeadOpen(slotKey, sealedSecret, label(`zuna/account-slot/v1/secret|${kind}`))));
  return { seal: fromBase64(json.seal), sign: fromBase64(json.sign), root: json.root ? fromBase64(json.root) : null };
}

const slotInfo = (kind: SlotKind, who: string, generation: number) => label(`zuna/account-slot/v1/key|${kind}|${who.toLowerCase()}|${generation}`);

/** `who` is the username, since a new account's slots are made before it has an ID. */
export const sealToSlot = (seal: Uint8Array, kind: SlotKind, who: string, generation: number, linkHash: Uint8Array, accountKey: Uint8Array) =>
  wasm.hpkeSeal(seal, slotInfo(kind, who, generation), linkHash, accountKey);

export const openFromSlot = (seal: Uint8Array, kind: SlotKind, who: string, generation: number, linkHash: Uint8Array, sealed: Uint8Array) =>
  wasm.hpkeOpen(seal, slotInfo(kind, who, generation), linkHash, sealed);

const slotBytes = (slot: SlotPublic | undefined) => (slot ? concat(new Uint8Array([1]), slot.seal, slot.sign) : new Uint8Array([0]));

/** Commits a link to the slots a device should go on sealing to. */
export const slotsHash = (slots: Partial<Record<SlotKind, SlotPublic>>): Uint8Array =>
  hash(concat(label("zuna/account-slots/v1"), slotBytes(slots.password), slotBytes(slots.recovery)));

// --- Devices ---

const sealKeyInput = (user: string, device: string, seal: Uint8Array) => concat(label(`zuna/device-seal/v1|${user}|${device}|`), seal);

export const signSealKey = (deviceSecret: Uint8Array, user: string, device: string, seal: Uint8Array) =>
  wasm.sign(deviceSecret, sealKeyInput(user, device, seal));

export const verifySealKey = (devicePublic: Uint8Array, user: string, device: string, seal: Uint8Array, signature: Uint8Array) =>
  wasm.verify(devicePublic, sealKeyInput(user, device, seal), signature);

// What a device has signed since seal keys said which generation they're from, so
// that a server can't offer an older one again. The one above stays for older apps.
const sealProofInput = (user: string, device: string, generation: number, seal: Uint8Array) => concat(label(`zuna/device-seal/v2|${user}|${device}|${generation}|`), seal);

export const signSealProof = (deviceSecret: Uint8Array, user: string, device: string, generation: number, seal: Uint8Array) =>
  wasm.sign(deviceSecret, sealProofInput(user, device, generation, seal));

export const verifySealProof = (devicePublic: Uint8Array, user: string, device: string, generation: number, seal: Uint8Array, signature: Uint8Array) =>
  wasm.verify(devicePublic, sealProofInput(user, device, generation, seal), signature);

const enrollInput = (user: string, device: string, signingKey: Uint8Array) => concat(label(`zuna/device-enroll/v1|${user}|${device}|`), signingKey);

/**
 * Signed with a slot's key while signing in, so this account's other devices can
 * tell that whoever made this device opened the slot. A certificate couldn't show
 * that: someone holding a stolen identity key can make as many of those as they like.
 */
export const signEnrollment = (slotSign: Uint8Array, user: string, device: string, signingKey: Uint8Array) =>
  wasm.sign(slotSign, enrollInput(user, device, signingKey));

export const verifyEnrollment = (slotSign: Uint8Array, user: string, device: string, signingKey: Uint8Array, proof: Uint8Array) =>
  wasm.verify(slotSign, enrollInput(user, device, signingKey), proof);

const bundleInfo = (user: string, device: string, generation: number) => label(`zuna/account-bundle/v1|${user}|${device}|${generation}`);

export const sealBundle = (seal: Uint8Array, user: string, device: string, generation: number, linkHash: Uint8Array, accountKey: Uint8Array) =>
  wasm.hpkeSeal(seal, bundleInfo(user, device, generation), linkHash, accountKey);

export const openBundle = (seal: Uint8Array, user: string, device: string, generation: number, linkHash: Uint8Array, sealed: Uint8Array) =>
  wasm.hpkeOpen(seal, bundleInfo(user, device, generation), linkHash, sealed);

const bridgeLabel = (user: string, generation: number) => label(`zuna/account-bridge/v1|${user}|${generation}`);

/**
 * Carries a new account key forward for a wrapper that can't be converted without
 * its secret. Anyone holding the first account key and the server's data can open
 * this, which is why it only exists while an account lacks a slot.
 */
export const sealBridge = (firstKey: Uint8Array, user: string, generation: number, accountKey: Uint8Array) =>
  wasm.aeadSeal(firstKey, accountKey, bridgeLabel(user, generation));

export const openBridge = (firstKey: Uint8Array, user: string, generation: number, sealed: Uint8Array) =>
  wasm.aeadOpen(firstKey, sealed, bridgeLabel(user, generation));

/** XChaCha20-Poly1305 doesn't commit to its key, so a link says which key it means. */
export const keyCommitment = (accountKey: Uint8Array, user: string, generation: number) =>
  wasm.hkdfSha256(accountKey, NO_SALT, label(`zuna/account-key-commit/v1|${user}|${generation}`), 32);

// --- Links ---

const LINK_LABEL = "zuna/identity-link/v1";

export interface LinkDevice {
  id: string;
  key: Uint8Array;
}

export interface LinkFields {
  user: string;
  gen: number;
  prev: Uint8Array;
  identity: Uint8Array;
  hpke: Uint8Array;
  keyCommit: Uint8Array;
  slotsHash: Uint8Array;
  devices: LinkDevice[];
  removed: string[];
  signer: string;
}

/** As it travels. The payload is signed as these exact bytes, so nothing has to be made canonical. */
export interface SignedLink {
  payload: Uint8Array;
  byPrev: Uint8Array;
  byNew: Uint8Array;
  byDevice: Uint8Array;
}

/** A link whose signatures have been checked. */
export interface Link extends LinkFields, SignedLink {
  hash: Uint8Array;
}

/** What the first link has to follow from: the key the account began with. */
export const rootHash = (user: string, root: Uint8Array) => hash(concat(label(`zuna/identity-chain/v1/root|${user}|`), root));

const linkInput = (payload: Uint8Array) => concat(label(LINK_LABEL), payload);

export function buildLink(fields: LinkFields, prevSecret: Uint8Array, newSecret: Uint8Array, deviceSecret: Uint8Array): SignedLink {
  const payload = utf8(
    JSON.stringify({
      v: 1,
      user: fields.user,
      gen: fields.gen,
      prev: toBase64(fields.prev),
      identity: toBase64(fields.identity),
      hpke: toBase64(fields.hpke),
      key_commit: toBase64(fields.keyCommit),
      slots_hash: toBase64(fields.slotsHash),
      devices: [...fields.devices].sort((a, b) => (a.id < b.id ? -1 : 1)).map((device) => ({ id: device.id, key: toBase64(device.key) })),
      removed: fields.removed,
      signer: fields.signer,
    }),
  );
  const input = linkInput(payload);
  return { payload, byPrev: wasm.sign(prevSecret, input), byNew: wasm.sign(newSecret, input), byDevice: wasm.sign(deviceSecret, input) };
}

/** Reads what a link says, without believing it. */
export function parseLinkPayload(payload: Uint8Array): LinkFields | null {
  try {
    const raw = JSON.parse(fromUtf8(payload));
    const fine =
      raw.v === 1 &&
      typeof raw.user === "string" &&
      Number.isSafeInteger(raw.gen) &&
      raw.gen > 0 &&
      typeof raw.prev === "string" &&
      typeof raw.identity === "string" &&
      typeof raw.hpke === "string" &&
      typeof raw.key_commit === "string" &&
      typeof raw.slots_hash === "string" &&
      Array.isArray(raw.devices) &&
      Array.isArray(raw.removed) &&
      typeof raw.signer === "string" &&
      raw.removed.every((id: unknown) => typeof id === "string") &&
      raw.devices.every((device: { id?: unknown; key?: unknown }) => typeof device?.id === "string" && typeof device?.key === "string");
    if (!fine) return null;
    return {
      user: raw.user,
      gen: raw.gen,
      prev: fromBase64(raw.prev),
      identity: fromBase64(raw.identity),
      hpke: fromBase64(raw.hpke),
      keyCommit: fromBase64(raw.key_commit),
      slotsHash: fromBase64(raw.slots_hash),
      devices: raw.devices.map((device: { id: string; key: string }) => ({ id: device.id, key: fromBase64(device.key) })),
      removed: raw.removed,
      signer: raw.signer,
    };
  } catch {
    return null;
  }
}

/** A link already held, whose signatures were checked when it was accepted. */
export function readHeldLink(signed: SignedLink): Link | null {
  const fields = parseLinkPayload(signed.payload);
  return fields ? { ...fields, ...signed, hash: hash(signed.payload) } : null;
}

/**
 * Checks that a link really follows from the one before: its generation is the
 * next, it names the previous link, the previous identity key authorized it, the
 * new one proved it's held, and the device it names signed it. Whether that device
 * means anything is for the caller to decide.
 */
export function verifyLink(signed: SignedLink, expected: { user: string; gen: number; prev: Uint8Array; prevIdentity: Uint8Array }): Link | null {
  const link = readHeldLink(signed);
  if (!link || link.user !== expected.user || link.gen !== expected.gen || !equalBytes(link.prev, expected.prev)) return null;
  if (link.identity.length !== 32 || link.hpke.length !== 32) return null;
  const signer = link.devices.find((device) => device.id === link.signer);
  if (!signer) return null;
  const input = linkInput(signed.payload);
  const signedBy = (key: Uint8Array, signature: Uint8Array) => wasm.verify(key, input, signature);
  return signedBy(expected.prevIdentity, signed.byPrev) && signedBy(link.identity, signed.byNew) && signedBy(signer.key, signed.byDevice) ? link : null;
}

export const carries = (link: LinkFields, device: LinkDevice): boolean =>
  link.devices.some((item) => item.id === device.id && equalBytes(item.key, device.key));

/** What a rotation does besides making new keys, if anything: all of it happens together. */
export interface RotationPlan {
  /** Slots that are new, or replace what was there. */
  slots?: NewSlot[];
  /** New password material, and the proof of being allowed to set it. */
  password?: {
    current_auth_key?: Uint8Array;
    recovery_auth_key?: Uint8Array;
    kdf: { salt: Uint8Array; memory: number; iterations: number; parallelism: number };
    auth_key: Uint8Array;
  };
  /** A new recovery key's sign-in key, and the proof. */
  recovery?: { current_auth_key: Uint8Array; recovery_auth_key: Uint8Array };
  /** Not to be sent again after a restart, since nobody would learn the recovery key it sets. */
  once?: boolean;
}

const optional = (bytes: Uint8Array | undefined) => bytes && toBase64(bytes);
const optionalBytes = (text: string | undefined) => (text ? fromBase64(text) : undefined);

/** A plan as it's kept with a rotation under way, so what it was for survives losing to another device. */
export function planToJson(plan: RotationPlan) {
  return {
    slots: plan.slots?.map((slot) => ({ kind: slot.kind, seal: toBase64(slot.seal), sign: toBase64(slot.sign), sealedSecret: toBase64(slot.sealedSecret) })),
    password: plan.password && {
      current_auth_key: optional(plan.password.current_auth_key),
      recovery_auth_key: optional(plan.password.recovery_auth_key),
      kdf: { ...plan.password.kdf, salt: toBase64(plan.password.kdf.salt) },
      auth_key: toBase64(plan.password.auth_key),
    },
    recovery: plan.recovery && { current_auth_key: toBase64(plan.recovery.current_auth_key), recovery_auth_key: toBase64(plan.recovery.recovery_auth_key) },
    once: plan.once,
  };
}

export function planFromJson(json: ReturnType<typeof planToJson>): RotationPlan {
  return {
    slots: json.slots?.map((slot) => ({ kind: slot.kind, seal: fromBase64(slot.seal), sign: fromBase64(slot.sign), sealedSecret: fromBase64(slot.sealedSecret) })),
    password: json.password && {
      current_auth_key: optionalBytes(json.password.current_auth_key),
      recovery_auth_key: optionalBytes(json.password.recovery_auth_key),
      kdf: { ...json.password.kdf, salt: fromBase64(json.password.kdf.salt) },
      auth_key: fromBase64(json.password.auth_key),
    },
    recovery: json.recovery && { current_auth_key: fromBase64(json.recovery.current_auth_key), recovery_auth_key: fromBase64(json.recovery.recovery_auth_key) },
    once: json.once,
  };
}

export const EMPTY_LINK_HASH = NOTHING;
