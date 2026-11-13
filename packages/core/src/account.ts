// Creating accounts and bringing an account's keys onto a device.

import * as wasm from "@zuna/crypto";
import { Api, ApiError, checkPinnable, decode, normalizeServerUrl, pinIn, type LoginResponse } from "./api";
import {
  DEFAULT_KDF,
  createCertificate,
  derivePasswordKeys,
  deriveRecoveryKeys,
  lastingKeyFromSeed,
  newDeviceKey,
  newLastingKey,
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
import { concat, equalBytes, fromBase64, fromBase64Url, fromRecoveryText, fromUtf8, toBase64, toBase64Url, toRecoveryText, utf8 } from "./encoding";
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
import { manifestParts } from "./manifest";
import { Frontier, bodyFits, headSigned, leafHash, linkHead, logKeyHash, parseBody, parseLinkHead, readRecord, userTag, type PinnedHead } from "./transparency";
import type { BotAdd, BotInfo, InvitePreview, Profile, Role } from "./types";

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
  /** The pin of a server that makes its own certificate, which the app trusts and nothing else. */
  pin?: string;
  /**
   * Set on the machine that runs a bot: whose it is, and who may see and add it. These are
   * its owner's rules, from its setup link and from its owner since, which it keeps itself
   * whatever a server says. `ownerKey` is its owner's identity key, as the link gave it.
   */
  bot?: BotInfo & { ownerKey?: string };
  /**
   * The key the server's log of who holds which keys is signed with, and a head that log has to
   * hold, as the invite link this device joined with carried them, or as signing in checked them,
   * all as base64. A device goes by these, and not by the server's first answer.
   */
  log?: { key: string; era: number; size: number; root: string };
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
  pin: string | null;
  /** The log of keys' key and the inviter's head of it, as `&log=` carries them (transparency.ts). */
  log: string | null;
  /** What a bot's setup link carries besides, for the bot it was made for. */
  bot: BotSetup | null;
}

/**
 * What a bot's setup link carries for its program, in the part after the #, which never
 * reaches the server: who the bot is, whose it is, and a key made for this link alone.
 */
export interface BotSetup {
  /** The ID the bot's account will have. */
  id: string;
  username: string;
  name: string;
  /**
   * The seed of a lasting key, which signs the bot's identity key, so that its owner's app
   * knows the key is the one this link made. Both halves of the hybrid key come from it,
   * so the link carries 32 bytes for it.
   */
  seed: Uint8Array;
  ownerId: string;
  /**
   * The hash of its owner's identity key (`ownerKeyHash`), which the bot goes by from the
   * start, whatever the server says it is: it signs up only if the key the server lists for
   * its owner is the one this names.
   */
  ownerKeyHash: Uint8Array;
  listed: boolean;
  add: BotAdd;
}

/** What a bot's setup link names its owner's identity key by: a hybrid key is two kilobytes. */
export const ownerKeyHash = (identityKey: Uint8Array): Uint8Array => wasm.sha256(concat(utf8("zuna/bot-owner/v1|"), identityKey));

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

function parseBotSetup(encoded: string | null): BotSetup | null {
  if (!encoded) return null;
  try {
    const raw = JSON.parse(fromUtf8(fromBase64Url(encoded))) as Record<string, unknown>;
    const { id, u, n, s, o, k, l, a } = raw;
    if (typeof id !== "string" || !ACCOUNT_ID.test(id) || typeof o !== "string" || !ACCOUNT_ID.test(o)) return null;
    if (typeof u !== "string" || typeof n !== "string" || typeof s !== "string" || typeof k !== "string") return null;
    const seed = fromBase64Url(s);
    const ownerHash = fromBase64Url(k);
    if (seed.length !== 32 || ownerHash.length !== 32) return null;
    const listed = l === 1;
    return { id, username: u, name: n, seed, ownerId: o, ownerKeyHash: ownerHash, listed, add: listed && (a === "admins" || a === "anyone") ? a : "owner" };
  } catch {
    return null;
  }
}

/** What a bot signs with its setup link's key: that this identity key is the account's the link was made for. */
export const botProofInput = (botId: string, identityKey: Uint8Array): Uint8Array => concat(utf8(`zuna/bot-setup/v1|${botId}|`), identityKey);

/** Understands https invite links, zuna:// deep links and bare server addresses with a code. */
export function parseInviteLink(input: string): ParsedInvite | null {
  const text = linkIn(input);
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^(.*)\/invite\/([^/]+)\/?$/);
  if (!match) return null;
  let url: string;
  try {
    url = normalizeServerUrl(`${parsed.protocol}//${parsed.host}${match[1]}`);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const pin = pinIn(parsed.hash);
  if (pin) checkPinnable(url);
  return { url, code: decodeURIComponent(match[2]!), communityKey: fragment.get("k"), pin, log: fragment.get("log"), bot: parseBotSetup(fragment.get("bot")) };
}

/** A server's address, from what someone entered: the address itself, maybe with a pin, or any of its invite links. */
export function parseServerAddress(input: string): { url: string; pin: string | null } {
  const invite = parseInviteLink(input);
  if (invite) return { url: invite.url, pin: invite.pin };
  const text = linkIn(input);
  if (!text) throw new Error("That doesn't look like a server's address.");
  const url = normalizeServerUrl(text);
  const pin = pinIn(new URL(text).hash);
  if (pin) checkPinnable(url);
  return { url, pin };
}

/** What a zuna:// deep link carries, or what was entered, with https:// if it has no scheme. */
function linkIn(input: string): string | null {
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
  return text;
}

/** What a link leads to. `pin` has the host trust a server's own certificate before anything reaches it. */
export async function previewInvite(link: string, pin: (url: string, pin: string) => Promise<void>): Promise<InvitePreview> {
  const parsed = parseInviteLink(link);
  if (!parsed) return previewOpenServer(link, pin);
  if (parsed.bot) throw new Error(BOT_LINK_ELSEWHERE);
  if (parsed.pin) await pin(parsed.url, parsed.pin);
  const details = await new Api(parsed.url).inviteInfo(parsed.code);
  if (details.bot) throw new Error(BOT_LINK_ELSEWHERE);
  return { ...parsed, setup: details.setup, server: details.server };
}

const BOT_LINK_ELSEWHERE = "That link sets up a bot. Give it to zuna-bot on the computer that will run the bot.";

/** A plain server address works too, if that server has open sign-ups. */
async function previewOpenServer(address: string, trust: (url: string, pin: string) => Promise<void>): Promise<InvitePreview> {
  let url: string;
  let pin: string | null;
  try {
    ({ url, pin } = parseServerAddress(address));
  } catch {
    throw new Error("That doesn't look like a Zuna invite link.");
  }
  if (pin) await trust(url, pin);
  let server;
  try {
    server = await new Api(url).info();
  } catch {
    throw new Error("That doesn't look like a Zuna invite link.");
  }
  if (server.registration !== "open") {
    throw new Error(`${server.name} only accepts invite links. Ask a member for one.`);
  }
  return { url, code: "", communityKey: server.community_key ?? null, pin, setup: false, server };
}

/**
 * An invite link. After the #, which never reaches the server, it carries the community key, a
 * server's own certificate's pin, and the hash of the key the server's log of keys is signed
 * with, with the inviter's head of it, which whoever joins holds the log they're given to.
 */
export const inviteLink = (serverUrl: string, code: string, communityKey: Uint8Array, pin: string | undefined, log?: PinnedHead): string =>
  `${serverUrl}/invite/${encodeURIComponent(code)}#k=${toBase64Url(communityKey)}${pin ? `&pin=${pin}` : ""}${log ? `&log=${linkHead(log)}` : ""}`;

/** A bot's setup link: its invite's, with who the bot is and the seed of the key that vouches for it after the #. */
export function botSetupLink(serverUrl: string, code: string, communityKey: Uint8Array, pin: string | undefined, bot: BotSetup, log?: PinnedHead): string {
  const carried = { id: bot.id, u: bot.username, n: bot.name, s: toBase64Url(bot.seed), o: bot.ownerId, k: toBase64Url(bot.ownerKeyHash), l: bot.listed ? 1 : 0, a: bot.add };
  return `${inviteLink(serverUrl, code, communityKey, pin, log)}&bot=${toBase64Url(utf8(JSON.stringify(carried)))}`;
}

/** The log's key and a head, as an account keeps them. */
const keptHead = (head: Omit<PinnedHead, "keyHash"> & { key: Uint8Array }): NonNullable<AccountState["log"]> => ({ key: toBase64(head.key), era: head.era, size: head.size, root: toBase64(head.root) });

/** Makes this device, and shows it came from someone who could open a slot. */
async function createDevice(api: Api, core: VaultCore, userId: string, slotSign: Uint8Array) {
  const device = newDeviceKey();
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
  /** For a bot signing up through its setup link. */
  bot?: BotSetup;
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

  const identity = newLastingKey();
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
  const manifest = manifestParts({ v: 1, pins: {}, verified: {}, chains: {}, trust: {} })!;
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
    items: manifest.map(({ id, data, version }) => ({ id, data: sealVaultItem(accountKey, id, data, 0), version })),
    profile: sealProfile(communityKey, core.identitySecret, input.username, input.profile),
    bot_proof: input.bot ? wasm.sign(lastingKeyFromSeed(input.bot.seed).secretKey, botProofInput(input.bot.id, core.identityPublic)) : undefined,
  });
  if (input.bot && created.user_id !== input.bot.id) throw new Error("The server created a different account than this link is for, so Zuna stopped.");
  api.token = created.token;
  // What the link says the log held, which the server never saw, and which this device holds it to.
  // The link names the log's key by its hash, which the key the server gives a session has to have.
  const linked = parseLinkHead(input.invite?.log);
  let head: Parameters<typeof keptHead>[0] | null = null;
  if (linked) {
    const info = await api.info();
    const key = info.log_key ? fromBase64(info.log_key) : null;
    if (!key || !equalBytes(logKeyHash(key), linked.keyHash)) {
      throw new Error("This server's record of keys doesn't match the invite link, so Zuna stopped.");
    }
    head = { key, era: linked.era, size: linked.size, root: linked.root };
  }

  const device = await createDevice(api, core, created.user_id, passwordSlot.secrets.sign);
  // A bot goes by its owner's identity key from the start: the one the link names by its hash.
  let ownerKey: Uint8Array | null = null;
  if (input.bot) {
    ownerKey = decode((await api.user(input.bot.ownerId)).identity_key);
    if (!equalBytes(ownerKeyHash(ownerKey), input.bot.ownerKeyHash)) {
      throw new Error("The server shows a different key for this bot's owner than the setup link does, so Zuna stopped.");
    }
  }
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
      ...(input.bot && ownerKey ? { bot: { ownerId: input.bot.ownerId, listed: input.bot.listed, add: input.bot.add, ownerKey: toBase64(ownerKey) } } : {}),
      ...(head ? { log: keptHead(head) } : {}),
    },
    recoveryKey: toRecoveryText(recoveryKey),
  };
}

/**
 * Signs a bot up through its setup link, on the machine that will run it. Its password
 * is 32 random bytes nobody ever sees, so there's none to guess: whoever holds its data
 * is the bot, and its recovery key is the only way back if that's lost.
 */
export async function registerBot(link: string, pin: (url: string, pin: string) => Promise<void>): Promise<RegisterResult & { pin: string | null }> {
  const parsed = parseInviteLink(link);
  if (!parsed?.bot || !parsed.communityKey) throw new Error("That isn't a bot's setup link. Copy it again from Settings, under Bots, including everything after the #.");
  if (parsed.pin) await pin(parsed.url, parsed.pin);
  const details = await new Api(parsed.url).inviteInfo(parsed.code);
  if (!details.bot) throw new Error("That link isn't for setting up a bot.");
  const result = await register({
    invite: { ...parsed, setup: false, server: details.server },
    serverUrl: parsed.url,
    username: parsed.bot.username,
    password: toBase64(wasm.randomBytes(32)),
    profile: { displayName: parsed.bot.name || parsed.bot.username },
    bot: parsed.bot,
  });
  return { ...result, pin: parsed.pin };
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
  const unfit = new Error("The server sent inconsistent details for this account, so Zuna stopped.");
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
 * Reads the server's log of keys before this device registers, with this account's own entries,
 * which a session with no device is given, and holds what the sign-in handed over to it: the
 * generation and head link have to be the newest the log has for the account. The head it checked
 * is what the device goes by from then on.
 */
async function checkSignInLog(api: Api, session: LoginResponse): Promise<NonNullable<AccountState["log"]>> {
  const unfit = new Error("The server sent a version of your account's keys that doesn't match its own record of them, so Zuna stopped.");
  const info = await api.info();
  if (!info.log_key) throw unfit;
  const key = fromBase64(info.log_key);
  let frontier = new Frontier();
  let era = 0;
  let links: Uint8Array[] = [];
  for (;;) {
    const page = await api.log(era, frontier.size, 2000);
    // Asked about another era, the server answers from the start of its own.
    if (page.era !== era) {
      frontier = new Frontier();
      links = [];
      era = page.era;
    }
    for (const wire of page.records) {
      const record = decode(wire.record);
      const parts = readRecord(record);
      if (wire.idx !== frontier.size || !parts) throw unfit;
      frontier.append(leafHash(record));
      if (!wire.body) {
        // Every entry of this account's own has to come with its body.
        if (equalBytes(userTag(session.user_id, parts.nonce), parts.userTag)) throw unfit;
        continue;
      }
      const bytes = decode(wire.body);
      const body = parseBody(bytes);
      if (!body || body.user !== session.user_id || !bodyFits(parts, bytes, body)) throw unfit;
      if (body.t !== "link") continue;
      if (body.gen !== links.length + 1) throw unfit;
      links.push(body.link);
    }
    const head = { era: page.head.era, size: page.head.size, root: decode(page.head.root), sig: decode(page.head.sig) };
    if (head.era !== era || head.size !== frontier.size || !equalBytes(head.root, frontier.root()) || !headSigned(key, head)) throw unfit;
    if (frontier.size >= page.size) break;
  }
  // One that got in between asking and reading is tried again.
  if (links.length > session.generation) throw new ApiError(409, "stale_generation", unfit.message);
  if (links.length !== session.generation) throw unfit;
  if (session.generation > 0 && !equalBytes(links.at(-1)!, hash(decode(session.head_link?.payload)))) throw unfit;
  return keptHead({ key, era, size: frontier.size, root: frontier.root() });
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
    const log = await checkSignInLog(api, session);
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
        log,
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
    const log = await checkSignInLog(api, session);

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
        log,
      },
      plan,
    };
  });
}

/** The sign-in key of the password typed now, which proves it to the server. */
export async function currentAuthKey(api: Api, username: string, password: string): Promise<Uint8Array> {
  const params = await api.prelogin(username);
  const keys = derivePasswordKeys(
    password,
    {
      salt: fromBase64(params.salt),
      memory: params.memory,
      iterations: params.iterations,
      parallelism: params.parallelism,
    },
    { serverUrl: api.baseUrl, username },
  );
  return keys.authKey;
}

/** What a rotation has to do to change the password, which proves the current one. */
export async function planPasswordChange(api: Api, username: string, current: string, next: string, core: VaultCore): Promise<RotationPlan> {
  const target = { serverUrl: api.baseUrl, username };
  const currentKey = await currentAuthKey(api, username, current);
  const kdf: KdfParams = { salt: wasm.randomBytes(16), ...DEFAULT_KDF };
  const nextKeys = derivePasswordKeys(next, kdf, target);
  return { slots: [createSlot("password", nextKeys.slotKey, core.rootPublic).slot], password: { current_auth_key: currentKey, kdf: { ...kdf }, auth_key: nextKeys.authKey } };
}

/** What a rotation has to do to replace the recovery key, which is shown once. */
export async function planRecoveryChange(api: Api, username: string, current: string, core: VaultCore): Promise<{ plan: RotationPlan; recoveryKey: string }> {
  const target = { serverUrl: api.baseUrl, username };
  const currentKey = await currentAuthKey(api, username, current);
  const recoveryKey = wasm.randomBytes(RECOVERY_KEY_BYTES);
  const recovery = deriveRecoveryKeys(recoveryKey, target);
  return {
    plan: { slots: [createSlot("recovery", recovery.slotKey, core.rootPublic).slot], recovery: { current_auth_key: currentKey, recovery_auth_key: recovery.authKey }, once: true },
    recoveryKey: toRecoveryText(recoveryKey),
  };
}

