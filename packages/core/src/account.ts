// Creating accounts and bringing an account's keys onto a device.

import * as wasm from "@zuna/crypto";
import { Api, ApiError, decode, normalizeServerUrl, type LoginResponse } from "./api";
import {
  DEFAULT_KDF,
  MANIFEST_ID,
  createCertificate,
  derivePasswordKeys,
  deriveRecoveryKeys,
  openVaultCore,
  randomId,
  sealProfile,
  sealVaultCore,
  sealVaultItem,
  signHpkeKey,
  type KdfParams,
  type PasswordKeys,
  type RecoveryKeys,
  type SignInTarget,
  type VaultCore,
} from "./crypto";
import { equalBytes, fromBase64, fromBase64Url, fromRecoveryText, toBase64, toBase64Url, toRecoveryText, utf8 } from "./encoding";
import {
  EMPTY_LINK_HASH,
  createSlot,
  hash,
  keyCommitment,
  openFromSlot,
  openSlot,
  parseLinkPayload,
  sealToSlot,
  signEnrollment,
  signSealProof,
  type NewSlot,
  type RotationPlan,
  type SlotKind,
} from "./generations";
import type { InvitePreview, Profile, Role } from "./types";

/** Everything a device needs to act for its account. Stored encrypted at rest. */
export interface AccountState {
  serverUrl: string;
  userId: string;
  username: string;
  role: Role;
  token: string;
  deviceId: string;
  devicePublic: Uint8Array;
  deviceSecret: Uint8Array;
  certificate: Uint8Array;
  accountKey: Uint8Array;
  core: VaultCore;
  /** What to seal this account's keys to for this device. */
  sealPublic: Uint8Array;
  sealSecret: Uint8Array;
  /** The last seal key, which a rotation already on its way may have used. */
  sealOlder?: Uint8Array;
}

/** A device signed in, and whatever has to happen next, in one go, for it to count. */
export interface SignedIn {
  account: AccountState;
  plan?: RotationPlan;
}

const RECOVERY_KEY_BYTES = 25;

export interface ParsedInvite {
  url: string;
  code: string;
  communityKey: string | null;
}

/** Understands https invite links, zuna:// deep links and bare server addresses with a code. */
export function parseInviteLink(input: string): ParsedInvite | null {
  let text = input.trim();
  if (text.startsWith("zuna://")) {
    try {
      const deep = new URL(text);
      const link = deep.searchParams.get("link");
      if (!link) return null;
      text = link;
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const parsed = new URL(text);
    const match = parsed.pathname.match(/^(.*)\/invite\/([^/]+)\/?$/);
    if (!match) return null;
    const url = normalizeServerUrl(`${parsed.protocol}//${parsed.host}${match[1]}`);
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    return { url, code: decodeURIComponent(match[2]!), communityKey: fragment.get("k") };
  } catch {
    return null;
  }
}

export async function previewInvite(link: string): Promise<InvitePreview> {
  const parsed = parseInviteLink(link);
  if (!parsed) return previewOpenServer(link);
  const details = await new Api(parsed.url).inviteInfo(parsed.code);
  return { ...parsed, setup: details.setup, server: details.server };
}

/** A plain server address works too, if that server has open sign-ups. */
async function previewOpenServer(address: string): Promise<InvitePreview> {
  let url: string;
  try {
    url = normalizeServerUrl(address);
  } catch {
    throw new Error("That doesn't look like a Zuna invite link.");
  }
  let server;
  try {
    server = await new Api(url).info();
  } catch {
    throw new Error("That doesn't look like a Zuna invite link.");
  }
  if (server.registration !== "open") {
    throw new Error(`${server.name} only accepts invite links. Ask a member for one.`);
  }
  return { url, code: "", communityKey: server.community_key ?? null, setup: false, server };
}

export const inviteLink = (serverUrl: string, code: string, communityKey: Uint8Array): string =>
  `${serverUrl}/invite/${encodeURIComponent(code)}#k=${toBase64Url(communityKey)}`;

/** Makes this device, and shows it came from someone who could open a slot. */
async function createDevice(api: Api, core: VaultCore, userId: string, slotSign: Uint8Array) {
  const device = wasm.signingKeygen();
  const deviceId = randomId();
  const certificate = createCertificate(core.identitySecret, { userId, deviceId, signatureKey: device.publicKey, generation: core.generation });
  const seal = wasm.hpkeKeygen();
  await api.addDevice(deviceId, certificate, device.publicKey, {
    generation: core.generation,
    seal_key: seal.publicKey,
    seal_generation: core.generation,
    seal_proof: signSealProof(device.secretKey, userId, deviceId, core.generation, seal.publicKey),
    enroll_proof: signEnrollment(slotSign, userId, deviceId, device.publicKey),
  });
  return {
    deviceId,
    devicePublic: device.publicKey as Uint8Array,
    deviceSecret: device.secretKey as Uint8Array,
    certificate,
    sealPublic: seal.publicKey as Uint8Array,
    sealSecret: seal.secretKey as Uint8Array,
  };
}

const slotBody = (slot: NewSlot, sealedKey: Uint8Array) => ({
  kind: slot.kind,
  seal_key: slot.seal,
  sign_key: slot.sign,
  sealed_secret: slot.sealedSecret,
  sealed_key: sealedKey,
});

export interface RegisterInput {
  invite: InvitePreview | null;
  serverUrl: string;
  username: string;
  password: string;
  profile: Profile;
}

export interface RegisterResult {
  account: AccountState;
  /** Shown once. It's the only way back in if the password is forgotten. */
  recoveryKey: string;
}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const api = new Api(serverUrl);

  const target = { serverUrl, username: input.username };
  const kdf: KdfParams = { salt: wasm.randomBytes(16), ...DEFAULT_KDF };
  const password = derivePasswordKeys(input.password, kdf, target);
  const accountKey = wasm.randomBytes(32);
  const recoveryKey = wasm.randomBytes(RECOVERY_KEY_BYTES);
  const recovery = deriveRecoveryKeys(recoveryKey, target);

  // The community key encrypts profiles. It travels in the invite link's
  // fragment, which never reaches the server; the first user creates it.
  let communityKey: Uint8Array;
  if (input.invite?.communityKey) {
    communityKey = fromBase64Url(input.invite.communityKey);
  } else if (input.invite?.server.community_key) {
    communityKey = fromBase64Url(input.invite.server.community_key);
  } else if (input.invite?.setup) {
    communityKey = wasm.randomBytes(32);
  } else {
    const info = await api.info();
    if (!info.community_key) throw new Error("This invite link is incomplete. Ask for the full link.");
    communityKey = fromBase64Url(info.community_key);
  }

  const identity = wasm.signingKeygen();
  const hpke = wasm.hpkeKeygen();
  const core: VaultCore = {
    identityPublic: identity.publicKey,
    identitySecret: identity.secretKey,
    hpkePublic: hpke.publicKey,
    hpkeSecret: hpke.secretKey,
    communityKey,
    generation: 0,
    rootPublic: identity.publicKey,
    rootSecret: identity.secretKey,
    olderKeys: {},
    olderHpkeSecrets: [],
    closedBelow: 0,
    slots: {},
    // The account starts with a manifest of what it trusts, so a new device always expects one.
    manifest: 1,
  };
  const manifest = utf8(JSON.stringify({ v: 1, pins: {}, verified: {}, chains: {}, trust: {} }));
  const passwordSlot = createSlot("password", password.slotKey, core.rootPublic);
  const recoverySlot = createSlot("recovery", recovery.slotKey, core.rootPublic);
  core.slots = { password: { seal: passwordSlot.slot.seal, sign: passwordSlot.slot.sign }, recovery: { seal: recoverySlot.slot.seal, sign: recoverySlot.slot.sign } };

  const created = await api.register({
    invite_code: input.invite?.code ?? "",
    username: input.username,
    kdf: { salt: toBase64(kdf.salt), memory: kdf.memory, iterations: kdf.iterations, parallelism: kdf.parallelism },
    auth_key: password.authKey,
    recovery_auth_key: recovery.authKey,
    slots: [passwordSlot, recoverySlot].map(({ slot }) => slotBody(slot, sealToSlot(slot.seal, slot.kind, input.username, 0, EMPTY_LINK_HASH, accountKey))),
    identity_key: core.identityPublic,
    hpke_key: core.hpkePublic,
    hpke_key_sig: signHpkeKey(core.identitySecret, core.hpkePublic),
    vault_core: sealVaultCore(accountKey, core),
    items: [{ id: MANIFEST_ID, data: sealVaultItem(accountKey, MANIFEST_ID, manifest, 0) }],
    profile: sealProfile(communityKey, core.identitySecret, input.username, input.profile),
  });
  api.token = created.token;

  const device = await createDevice(api, core, created.user_id, passwordSlot.secrets.sign);
  return {
    account: {
      serverUrl,
      userId: created.user_id,
      username: input.username,
      role: created.role,
      token: created.token,
      ...device,
      accountKey,
      core,
    },
    recoveryKey: toRecoveryText(recoveryKey),
  };
}

interface OpenedAccount {
  accountKey: Uint8Array;
  core: VaultCore;
  /** Signs this device in as someone who could open the slot. */
  slotSign: Uint8Array;
}

const ROOT_CHECK = utf8("zuna/account-slot/v1/root-check");

/** Whether this core is really the account's: it has the key the account began with, and can sign with it. */
const holdsRoot = (core: VaultCore, root: Uint8Array): boolean =>
  equalBytes(core.rootPublic, root) && wasm.verify(root, ROOT_CHECK, wasm.sign(core.rootSecret, ROOT_CHECK));

/** Opens what a sign-in handed over, through the slot for the secret that was used. */
function openAccount(target: SignInTarget, kind: SlotKind, keys: PasswordKeys | RecoveryKeys, session: LoginResponse): OpenedAccount {
  const unfit = new Error("What the server sent for this account doesn't fit together. Not continuing.");
  if (!session.slot) throw unfit;
  const { generation } = session;
  const payload = session.head_link ? decode(session.head_link.payload) : null;
  const linkHash = payload ? hash(payload) : EMPTY_LINK_HASH;
  const secrets = openSlot(kind, keys.slotKey, decode(session.slot.sealed_secret));
  const accountKey = openFromSlot(secrets.seal, kind, target.username, generation, linkHash, decode(session.slot.sealed_key));
  if (generation > 0) {
    const link = payload && parseLinkPayload(payload);
    if (!link || link.gen !== generation || link.user !== session.user_id || !equalBytes(link.keyCommit, keyCommitment(accountKey, session.user_id, generation))) throw unfit;
  }
  const core = openVaultCore(accountKey, decode(session.vault_core), generation, session.user_id);
  if (core.generation !== generation || !holdsRoot(core, secrets.root)) throw unfit;
  return { accountKey, core, slotSign: secrets.sign };
}

/**
 * A rotation may get in between fetching the keys and registering with them. It
 * ends sessions with no device, or this device is told it's behind, and it starts again.
 */
async function retryingStaleSignIn<T>(signIn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await signIn();
    } catch (error) {
      if (!(error instanceof ApiError) || (error.code !== "stale_generation" && error.code !== "unauthorized") || attempt >= 3) throw error;
    }
  }
}

export function login(serverUrlInput: string, username: string, passwordText: string): Promise<SignedIn> {
  return retryingStaleSignIn(async () => {
    const serverUrl = normalizeServerUrl(serverUrlInput);
    const api = new Api(serverUrl);
    const target = { serverUrl, username };
    const params = await api.prelogin(username);
    const password = derivePasswordKeys(
      passwordText,
      {
        salt: fromBase64(params.salt),
        memory: params.memory,
        iterations: params.iterations,
        parallelism: params.parallelism,
      },
      target,
    );
    const session = await api.login(username, password.authKey);
    api.token = session.token;
    const { accountKey, core, slotSign } = openAccount(target, "password", password, session);
    const device = await createDevice(api, core, session.user_id, slotSign);
    return {
      account: {
        serverUrl,
        userId: session.user_id,
        username: session.username,
        role: session.role,
        token: session.token,
        ...device,
        accountKey,
        core,
      },
    };
  });
}

/**
 * Signs in with the recovery key, then sets a new password. The password changes
 * as part of a rotation, which takes a device, so the device comes first: stopping
 * before that leaves the old password working.
 */
export function recover(
  serverUrlInput: string,
  username: string,
  recoveryText: string,
  newPassword: string,
): Promise<SignedIn> {
  return retryingStaleSignIn(async () => {
    const serverUrl = normalizeServerUrl(serverUrlInput);
    const recoveryKey = fromRecoveryText(recoveryText);
    if (!recoveryKey || recoveryKey.length !== RECOVERY_KEY_BYTES) {
      throw new Error("That recovery key isn't complete. Check it and try again.");
    }
    const target = { serverUrl, username };
    const recovery = deriveRecoveryKeys(recoveryKey, target);
    const api = new Api(serverUrl);
    const session = await api.recover(username, recovery.authKey);
    api.token = session.token;
    const { accountKey, core, slotSign } = openAccount(target, "recovery", recovery, session);

    const kdf: KdfParams = { salt: wasm.randomBytes(16), ...DEFAULT_KDF };
    const password = derivePasswordKeys(newPassword, kdf, target);
    const plan: RotationPlan = {
      slots: [createSlot("password", password.slotKey, core.rootPublic).slot],
      password: { recovery_auth_key: recovery.authKey, kdf: { ...kdf }, auth_key: password.authKey },
    };

    const device = await createDevice(api, core, session.user_id, slotSign);
    return {
      account: {
        serverUrl,
        userId: session.user_id,
        username: session.username,
        role: session.role,
        token: session.token,
        ...device,
        accountKey,
        core,
      },
      plan,
    };
  });
}

/** What a rotation has to do to change the password, which proves the current one. */
export async function planPasswordChange(api: Api, username: string, current: string, next: string, core: VaultCore): Promise<RotationPlan> {
  const target = { serverUrl: api.baseUrl, username };
  const params = await api.prelogin(username);
  const keys = derivePasswordKeys(
    current,
    {
      salt: fromBase64(params.salt),
      memory: params.memory,
      iterations: params.iterations,
      parallelism: params.parallelism,
    },
    target,
  );
  const kdf: KdfParams = { salt: wasm.randomBytes(16), ...DEFAULT_KDF };
  const nextKeys = derivePasswordKeys(next, kdf, target);
  return { slots: [createSlot("password", nextKeys.slotKey, core.rootPublic).slot], password: { current_auth_key: keys.authKey, kdf: { ...kdf }, auth_key: nextKeys.authKey } };
}

/** What a rotation has to do to replace the recovery key, which is shown once. */
export async function planRecoveryChange(api: Api, username: string, current: string, core: VaultCore): Promise<{ plan: RotationPlan; recoveryKey: string }> {
  const target = { serverUrl: api.baseUrl, username };
  const params = await api.prelogin(username);
  const keys = derivePasswordKeys(
    current,
    {
      salt: fromBase64(params.salt),
      memory: params.memory,
      iterations: params.iterations,
      parallelism: params.parallelism,
    },
    target,
  );
  const recoveryKey = wasm.randomBytes(RECOVERY_KEY_BYTES);
  const recovery = deriveRecoveryKeys(recoveryKey, target);
  return {
    plan: { slots: [createSlot("recovery", recovery.slotKey, core.rootPublic).slot], recovery: { current_auth_key: keys.authKey, recovery_auth_key: recovery.authKey }, once: true },
    recoveryKey: toRecoveryText(recoveryKey),
  };
}

