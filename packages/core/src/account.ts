// Creating accounts and bringing an account's keys onto a device.

import * as wasm from "@zuna/crypto";
import { Api, ApiError, decode, normalizeServerUrl } from "./api";
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
  type SignInTarget,
  type VaultCore,
} from "./crypto";
import { fromBase64, fromBase64Url, fromRecoveryText, toBase64, toBase64Url, toRecoveryText } from "./encoding";
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

async function createDevice(api: Api, identitySecret: Uint8Array, userId: string) {
  const device = wasm.signingKeygen();
  const deviceId = randomId();
  const certificate = createCertificate(identitySecret, {
    userId,
    deviceId,
    signatureKey: device.publicKey,
  });
  await api.addDevice(deviceId, certificate, device.publicKey);
  return { deviceId, devicePublic: device.publicKey as Uint8Array, deviceSecret: device.secretKey as Uint8Array, certificate };
}

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
  };

  const created = await api.register({
    invite_code: input.invite?.code ?? "",
    username: input.username,
    kdf: { salt: toBase64(kdf.salt), memory: kdf.memory, iterations: kdf.iterations, parallelism: kdf.parallelism },
    auth_key: password.authKey,
    recovery_auth_key: recovery.authKey,
    wrapped_key_password: wrapAccountKey(password.wrapKey, accountKey, "password"),
    wrapped_key_recovery: wrapAccountKey(recovery.wrapKey, accountKey, "recovery"),
    identity_key: core.identityPublic,
    hpke_key: core.hpkePublic,
    hpke_key_sig: signHpkeKey(core.identitySecret, core.hpkePublic),
    vault_core: sealVaultCore(accountKey, core),
    profile: sealProfile(communityKey, core.identitySecret, input.username, input.profile),
  });
  api.token = created.token;

  const device = await createDevice(api, core.identitySecret, created.user_id);
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
      if (upgradeError instanceof ApiError && upgradeError.code === "invalid_credentials") throw error;
      throw upgradeError;
    }
    return action();
  }
}

export async function login(serverUrlInput: string, username: string, passwordText: string): Promise<AccountState> {
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
  const accountKey = unwrapAccountKey(password.wrapKey, decode(session.wrapped_key), "password");
  const core = openVaultCore(accountKey, decode(session.vault_core));
  const device = await createDevice(api, core.identitySecret, session.user_id);
  return {
    serverUrl,
    userId: session.user_id,
    username: session.username,
    role: session.role,
    token: session.token,
    ...device,
    accountKey,
    core,
  };
}

export interface RecoverResult {
  account: AccountState;
  recoveryAuthKey: Uint8Array;
}

/** Signs in with the recovery key, then sets a new password. */
export async function recover(
  serverUrlInput: string,
  username: string,
  recoveryText: string,
  newPassword: string,
): Promise<AccountState> {
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
  const accountKey = unwrapAccountKey(recovery.wrapKey, decode(session.wrapped_key), "recovery");
  const core = openVaultCore(accountKey, decode(session.vault_core));

  const kdf: KdfParams = { salt: wasm.randomBytes(16), ...DEFAULT_KDF };
  const password = derivePasswordKeys(newPassword, kdf, target);
  await api.changePassword({
    recovery_auth_key: recovery.authKey,
    kdf: { salt: toBase64(kdf.salt), memory: kdf.memory, iterations: kdf.iterations, parallelism: kdf.parallelism },
    auth_key: password.authKey,
    wrapped_key_password: wrapAccountKey(password.wrapKey, accountKey, "password"),
  });

  const device = await createDevice(api, core.identitySecret, session.user_id);
  return {
    serverUrl,
    userId: session.user_id,
    username: session.username,
    role: session.role,
    token: session.token,
    ...device,
    accountKey,
    core,
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
