// Creating accounts and bringing an account's keys onto a device.

import * as wasm from "@zuna/crypto";
import { Api, ApiError, decode, normalizeServerUrl, type LoginResponse } from "./api";
import {
  DEFAULT_KDF,
  createCertificate,
  derivePasswordKeys,
  deriveRecoveryKeys,
  openVaultCore,
  randomId,
  sealProfile,
  sealVaultCore,
  signHpkeKey,
  unwrapAccountKey,
  upgradeProof,
  wrapAccountKey,
  type KdfParams,
  type PasswordKeys,
  type RecoveryKeys,
  type SignInTarget,
  type VaultCore,
} from "./crypto";
import { equalBytes, fromBase64, fromBase64Url, fromRecoveryText, toBase64, toBase64Url, toRecoveryText } from "./encoding";
import {
  ACCOUNT_PROTOCOL,
  EMPTY_LINK_HASH,
  createSlot,
  hash,
  keyCommitment,
  openBridge,
  openFromSlot,
  openSlot,
  parseLinkPayload,
  sealToSlot,
  signEnrollment,
  signSealKey,
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
  /** What to seal this account's keys to for this device. A device gets one the first time it can use it. */
  sealPublic?: Uint8Array;
  sealSecret?: Uint8Array;
  /** The last seal key, which a rotation already on its way may have used. */
  sealOlder?: Uint8Array;
  /** Set once this server has been seen keeping generations of keys. */
  protocol?: number;
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

/** Makes this device, and shows it came from someone who could open a slot, if the server wants to know. */
async function createDevice(api: Api, core: VaultCore, userId: string, slotSign: Uint8Array | null, protocol?: number) {
  const device = wasm.signingKeygen();
  const deviceId = randomId();
  const made = { deviceId, devicePublic: device.publicKey as Uint8Array, deviceSecret: device.secretKey as Uint8Array };
  if (!protocol) {
    const certificate = createCertificate(core.identitySecret, { userId, deviceId, signatureKey: device.publicKey });
    await api.addDevice(deviceId, certificate, device.publicKey);
    return { ...made, certificate };
  }
  const certificate = createCertificate(core.rootSecret, { userId, deviceId, signatureKey: device.publicKey, generation: core.generation }, core.identitySecret);
  const seal = wasm.hpkeKeygen();
  await api.addDevice(deviceId, certificate, device.publicKey, {
    generation: core.generation,
    seal_key: seal.publicKey,
    seal_sig: signSealKey(device.secretKey, userId, deviceId, seal.publicKey),
    enroll_proof: slotSign ? signEnrollment(slotSign, userId, deviceId, device.publicKey) : undefined,
  });
  return { ...made, certificate, sealPublic: seal.publicKey as Uint8Array, sealSecret: seal.secretKey as Uint8Array, protocol };
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
    firstKey: null,
    closedBelow: 0,
    slots: {},
  };

  // A server that keeps generations gets slots from the start, and none of the
  // wrappers that can't be sealed to later.
  const server = input.invite?.server ?? (await api.info());
  const protocol = (server.account_protocol ?? 0) >= ACCOUNT_PROTOCOL ? ACCOUNT_PROTOCOL : undefined;
  const passwordSlot = protocol ? createSlot("password", password.slotKey) : null;
  const recoverySlot = protocol ? createSlot("recovery", recovery.slotKey) : null;
  if (passwordSlot && recoverySlot) {
    core.slots = { password: { seal: passwordSlot.slot.seal, sign: passwordSlot.slot.sign }, recovery: { seal: recoverySlot.slot.seal, sign: recoverySlot.slot.sign } };
  }
  const wrappers =
    passwordSlot && recoverySlot
      ? {
          slots: [passwordSlot, recoverySlot].map(({ slot }) =>
            slotBody(slot, sealToSlot(slot.seal, slot.kind, input.username, 0, EMPTY_LINK_HASH, accountKey)),
          ),
        }
      : {
          wrapped_key_password: wrapAccountKey(password.wrapKey, accountKey, "password"),
          wrapped_key_recovery: wrapAccountKey(recovery.wrapKey, accountKey, "recovery"),
        };

  const created = await api.register({
    invite_code: input.invite?.code ?? "",
    username: input.username,
    keys_bound: true,
    kdf: { salt: toBase64(kdf.salt), memory: kdf.memory, iterations: kdf.iterations, parallelism: kdf.parallelism },
    auth_key: password.authKey,
    recovery_auth_key: recovery.authKey,
    ...wrappers,
    identity_key: core.identityPublic,
    hpke_key: core.hpkePublic,
    hpke_key_sig: signHpkeKey(core.identitySecret, core.hpkePublic),
    vault_core: sealVaultCore(accountKey, core),
    profile: sealProfile(communityKey, core.identitySecret, input.username, input.profile),
  });
  api.token = created.token;

  const device = await createDevice(api, core, created.user_id, passwordSlot?.secrets.sign ?? null, protocol);
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

/**
 * Does something that proves who you are with a sign-in key. An account from
 * before those keys were bound to a server won't know the new one yet, so if it's
 * refused, the account moves to it (without ever sending the old one) and it's
 * tried again.
 */
async function withCurrentKey<T>(
  api: Api,
  target: SignInTarget,
  kind: "password" | "recovery",
  keys: { authKey: Uint8Array; legacyAuthKey: Uint8Array },
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "invalid_credentials") throw error;
    await upgradeSignInKey(api, target, kind, keys, error);
    return action();
  }
}

/** Moves an account from before sign-in keys were bound to a server, if that's why one was refused. */
export async function upgradeSignInKey(
  api: Api,
  target: SignInTarget,
  kind: "password" | "recovery",
  keys: { authKey: Uint8Array; legacyAuthKey: Uint8Array },
  refusal: unknown,
): Promise<void> {
  const { salt, challenge } = await api.upgradeChallenge(target.username, kind);
  const decoded = decode(challenge);
  try {
    await api.upgradeKey({
      username: target.username,
      kind,
      origin: target.serverUrl,
      challenge: decoded,
      proof: upgradeProof(kind, keys.legacyAuthKey, decode(salt), decoded, target),
      auth_key: keys.authKey,
    });
  } catch (upgradeError) {
    // The key really was wrong, and that's the message to show.
    if (upgradeError instanceof ApiError && upgradeError.code === "invalid_credentials") throw refusal;
    throw upgradeError;
  }
}

interface OpenedAccount {
  accountKey: Uint8Array;
  core: VaultCore;
  /** Signs this device in as someone who could open the slot. */
  slotSign: Uint8Array | null;
  /** The slot the secret just used should have, if it has none yet. */
  newSlot: NewSlot | null;
  protocol?: number;
}

/** Opens what a sign-in handed over, by whichever way this secret's account key is wrapped now. */
function openAccount(target: SignInTarget, kind: SlotKind, keys: PasswordKeys | RecoveryKeys, session: LoginResponse): OpenedAccount {
  if ((session.protocol ?? 0) < ACCOUNT_PROTOCOL) {
    const accountKey = unwrapAccountKey(keys.wrapKey, decode(session.wrapped_key), kind);
    return { accountKey, core: openVaultCore(accountKey, decode(session.vault_core)), slotSign: null, newSlot: null };
  }
  const generation = session.generation ?? 0;
  const payload = session.head_link ? decode(session.head_link.payload) : null;
  const linkHash = payload ? hash(payload) : EMPTY_LINK_HASH;
  let accountKey: Uint8Array;
  let slotSign: Uint8Array;
  let newSlot: NewSlot | null = null;
  if (session.slot) {
    const secrets = openSlot(kind, keys.slotKey, decode(session.slot.sealed_secret));
    accountKey = openFromSlot(secrets.seal, kind, target.username, generation, linkHash, decode(session.slot.sealed_key));
    slotSign = secrets.sign;
  } else {
    const first = unwrapAccountKey(keys.wrapKey, decode(session.wrapped_key), kind);
    accountKey = generation > 0 ? openBridge(first, session.user_id, generation, decode(session.bridge)) : first;
    // The secret is in hand, which is the only time this wrapper can become a slot.
    const made = createSlot(kind, keys.slotKey);
    newSlot = made.slot;
    slotSign = made.secrets.sign;
  }
  if (generation > 0) {
    const link = payload && parseLinkPayload(payload);
    if (!link || link.gen !== generation || link.user !== session.user_id || !equalBytes(link.keyCommit, keyCommitment(accountKey, session.user_id, generation))) {
      throw new Error("What the server sent for this account doesn't fit together. Not continuing.");
    }
  }
  const core = openVaultCore(accountKey, decode(session.vault_core), generation, session.user_id);
  if (core.generation !== generation) throw new Error("What the server sent for this account doesn't fit together. Not continuing.");
  return { accountKey, core, slotSign, newSlot, protocol: ACCOUNT_PROTOCOL };
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
    const session = await withCurrentKey(api, target, "password", password, () => api.login(username, password.authKey));
    api.token = session.token;
    const { accountKey, core, slotSign, newSlot, protocol } = openAccount(target, "password", password, session);
    const device = await createDevice(api, core, session.user_id, slotSign, protocol);
    let plan: RotationPlan | undefined;
    if (newSlot && core.generation > 0) {
      plan = { slots: [newSlot] };
    } else if (newSlot) {
      core.slots = { ...core.slots, password: { seal: newSlot.seal, sign: newSlot.sign } };
      const body = slotBody(newSlot, sealToSlot(newSlot.seal, "password", username, 0, EMPTY_LINK_HASH, accountKey));
      await api.addFirstSlot(body, sealVaultCore(accountKey, core)).catch((error) => console.warn("[zuna] saving a slot", error));
    }
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

/**
 * Signs in with the recovery key, then sets a new password. Where the server keeps
 * generations the password changes as part of a rotation, which takes a device,
 * so the device comes first: stopping before that leaves the old password working.
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
    const session = await withCurrentKey(api, target, "recovery", recovery, () => api.recover(username, recovery.authKey));
    api.token = session.token;
    const { accountKey, core, slotSign, newSlot, protocol } = openAccount(target, "recovery", recovery, session);

    const kdf: KdfParams = { salt: wasm.randomBytes(16), ...DEFAULT_KDF };
    const password = derivePasswordKeys(newPassword, kdf, target);
    const kdfBody = { salt: toBase64(kdf.salt), memory: kdf.memory, iterations: kdf.iterations, parallelism: kdf.parallelism };
    let plan: RotationPlan | undefined;
    if (protocol) {
      const slots = [createSlot("password", password.slotKey).slot];
      if (newSlot) slots.push(newSlot);
      plan = { slots, password: { recovery_auth_key: recovery.authKey, kdf: { ...kdf }, auth_key: password.authKey } };
    } else {
      await api.changePassword({
        recovery_auth_key: recovery.authKey,
        kdf: kdfBody,
        auth_key: password.authKey,
        wrapped_key_password: wrapAccountKey(password.wrapKey, accountKey, "password"),
      });
    }

    const device = await createDevice(api, core, session.user_id, slotSign, protocol);
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

/** What a rotation has to do to change the password, along with what proves the current one. */
export async function planPasswordChange(api: Api, username: string, current: string, next: string): Promise<{ plan: RotationPlan; keys: PasswordKeys }> {
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
  return {
    plan: { slots: [createSlot("password", nextKeys.slotKey).slot], password: { current_auth_key: keys.authKey, kdf: { ...kdf }, auth_key: nextKeys.authKey } },
    keys,
  };
}

/**
 * What a rotation has to do to replace the recovery key, which is shown once. The
 * password is in hand too, so if it has no slot yet, this is when it gets one.
 */
export async function planRecoveryChange(api: Api, username: string, current: string, core: VaultCore): Promise<{ plan: RotationPlan; keys: PasswordKeys; recoveryKey: string }> {
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
  const slots = [createSlot("recovery", recovery.slotKey).slot];
  if (!core.slots.password) slots.push(createSlot("password", keys.slotKey).slot);
  return {
    plan: { slots, recovery: { current_auth_key: keys.authKey, recovery_auth_key: recovery.authKey }, once: true },
    keys,
    recoveryKey: toRecoveryText(recoveryKey),
  };
}

/** Changes the password. Message history isn't re-encrypted: only the wrapper changes. */
export async function changePassword(api: Api, username: string, accountKey: Uint8Array, current: string, next: string): Promise<void> {
  const target = { serverUrl: api.baseUrl, username };
  const params = await api.prelogin(username);
  const currentKeys = derivePasswordKeys(
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
  try {
    await withCurrentKey(api, target, "password", currentKeys, () =>
      api.changePassword({
        current_auth_key: currentKeys.authKey,
        kdf: { salt: toBase64(kdf.salt), memory: kdf.memory, iterations: kdf.iterations, parallelism: kdf.parallelism },
        auth_key: nextKeys.authKey,
        wrapped_key_password: wrapAccountKey(nextKeys.wrapKey, accountKey, "password"),
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_credentials") {
      throw new Error("Your current password isn't correct.");
    }
    throw error;
  }
}

/** Replaces the recovery key. The old one stops working immediately. */
export async function regenerateRecoveryKey(api: Api, username: string, accountKey: Uint8Array, current: string): Promise<string> {
  const target = { serverUrl: api.baseUrl, username };
  const params = await api.prelogin(username);
  const currentKeys = derivePasswordKeys(
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
  await withCurrentKey(api, target, "password", currentKeys, () =>
    api.changeRecoveryKey({
      current_auth_key: currentKeys.authKey,
      recovery_auth_key: recovery.authKey,
      wrapped_key_recovery: wrapAccountKey(recovery.wrapKey, accountKey, "recovery"),
    }),
  );
  return toRecoveryText(recoveryKey);
}
