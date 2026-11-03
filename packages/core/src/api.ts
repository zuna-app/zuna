// A typed client for the server's REST interface. Binary fields travel as base64.

import * as wasm from "@zuna/crypto";
import { concat, fromBase64, toBase64, utf8 } from "./encoding";
import { ACCOUNT_PROTOCOL } from "./generations";
import type { Emote, Invite, ServerInfo } from "./types";

/**
 * A request's path, with whatever goes in it kept to one part of the path, whatever
 * it says. Some of it comes from other people's messages, and the request carries
 * this person's token.
 */
function at(parts: TemplateStringsArray, ...values: (string | number)[]): string {
  return parts.reduce((path, part, index) => path + encodeURIComponent(values[index - 1]!) + part);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The request might succeed later: the server or network was unavailable. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface ApiUser {
  id: string;
  username: string;
  role: "owner" | "admin" | "member";
  identity_key: string;
  /** Absent on a server from before generations of keys. */
  key_generation?: number;
  hpke_key: string;
  hpke_key_sig: string;
  profile: string | null;
  profile_sig?: string | null;
  last_seen_at: number | null;
  hide_last_seen: boolean;
  banned: boolean;
  created_at: number;
  updated_at: number;
  devices: ApiDevice[];
}

export interface ApiDevice {
  id: string;
  user_id: string;
  certificate: string;
  signature_key: string;
  created_at: number;
  last_seen_at: number;
  revoked_at?: number | null;
  seal_key?: string | null;
  seal_sig?: string | null;
  enroll_proof?: string | null;
  seal_generation?: number | null;
  seal_proof?: string | null;
}

/** One step of someone's chain of identity keys. */
export interface ApiLink {
  generation: number;
  payload: string;
  by_prev: string;
  by_new: string;
  by_device: string;
}

export interface ApiSlot {
  kind: "password" | "recovery";
  seal_key: string;
  sign_key: string;
  sealed_secret: string;
  sealed_key: string;
}

export interface ApiAccount {
  generation: number;
  vault_core: string;
  bundle: { device_id: string; generation: number; data: string } | null;
  older_items: number;
  missing_bundles: string[];
  protocol_since: number;
}

export interface ApiVaultItem {
  id: string;
  seq: number;
  generation?: number;
  data: string;
}

export interface ApiMember {
  user_id: string;
  role: "admin" | "member";
  joined_at: number;
  visible_from_seq: number;
  read_state: string | null;
  /** In a channel: that they hold the community key. */
  proof?: string | null;
  /** In a channel: they're waiting for a member to hand them its older keys. */
  history_wanted?: boolean;
}

export interface ApiGroup {
  id: string;
  kind: "dm" | "group" | "channel";
  epoch: number;
  seq: number;
  meta: string | null;
  meta_epoch: number | null;
  history_visible: boolean;
  created_by: string;
  created_at: number;
  members: ApiMember[];
}

export interface ApiChannel {
  id: string;
  type: "text" | "voice";
  position: number;
  user_limit: number;
  screen_limit?: number;
  details: string;
  created_by: string;
  created_at: number;
}

export interface ApiVoiceState {
  channel_id: string;
  user_id: string;
  device_id: string;
  muted: boolean;
  deafened: boolean;
  server_muted: boolean;
  camera: boolean;
  screen: boolean;
  since: number;
}

export interface ApiReaction {
  id: string;
  user_id: string;
  epoch: number;
  data: string;
  created_at: number;
}

export interface ApiMessage {
  group_id: string;
  id: string;
  seq: number;
  updated_seq: number;
  sender_user: string;
  sender_device: string;
  epoch: number;
  envelope?: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  pinned_at: number | null;
  pinned_by?: string;
  deleted_by?: string;
  /** What the deleting device signed, from apps that sign deletions. */
  deletion?: string;
  /** What the device that last pinned or unpinned it signed, from apps that sign pins, and whose it was. */
  pin?: string;
  pin_by?: string;
  reactions: ApiReaction[];
}

export interface ApiEvent {
  group_id: string;
  seq: number;
  kind: "commit" | "member_left" | "commit_voided";
  epoch: number;
  data?: string;
  sender_user: string;
  sender_device?: string;
  target_user?: string;
  created_at: number;
}

export interface ApiChanges {
  messages: ApiMessage[];
  events: ApiEvent[];
  cursor: number;
  has_more: boolean;
}

export interface ApiWelcome {
  id: number;
  device_id: string;
  group_id: string;
  data: string;
}

export interface ApiKdf {
  salt: string;
  memory: number;
  iterations: number;
  parallelism: number;
}

export interface CommitRequest {
  expected_epoch: number;
  commit: Uint8Array;
  group_info: Uint8Array;
  kind: string;
  add_users?: string[];
  remove_users?: string[];
  welcomes?: { device_id: string; data: Uint8Array }[];
  meta?: Uint8Array;
  meta_epoch?: number;
  history_grants?: { user_id: string; data: Uint8Array }[];
}

const REQUEST_TIMEOUT_MS = 30_000;

export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.hostname.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !local) {
    throw new Error("Zuna servers must use HTTPS. Plain HTTP only works for localhost.");
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Recursively turns Uint8Array values into base64 for JSON. */
export function encodeBody(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBase64(value);
  if (Array.isArray(value)) return value.map(encodeBody);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBody(v)]));
  }
  return value;
}

export class Api {
  token: string | null = null;
  /**
   * Signs a request with this device's key. What can't be undone, or acts for the
   * whole server, needs it, so that a session token alone can do none of it.
   */
  prove: ((input: Uint8Array) => Uint8Array) | null = null;
  /** How far the server's clock is from this device's, once a proof has shown it's off. */
  private clockOffset = 0;

  constructor(readonly baseUrl: string) {}

  private async request<T>(method: string, path: string, body?: unknown, raw?: Uint8Array | Blob): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    let bytes: Uint8Array = new Uint8Array(0);
    if (raw) {
      payload = raw as BodyInit;
      if (this.prove && method !== "GET") bytes = raw instanceof Uint8Array ? raw : new Uint8Array(await raw.arrayBuffer());
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      const text = JSON.stringify(encodeBody(body));
      payload = text;
      bytes = utf8(text);
    }
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      if (this.prove && method !== "GET") {
        const at = Date.now() + this.clockOffset;
        const input = concat(utf8(`zuna/request/v1|${method}|${path.split("?")[0]}|${at}|`), wasm.sha256(bytes));
        headers["X-Zuna-Proof"] = toBase64(this.prove(input));
        headers["X-Zuna-Time"] = String(at);
      }
      try {
        response = await fetch(this.baseUrl + path, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new ApiError(0, "network", "Couldn't reach the server. Check your connection.");
      }
      if (response.status !== 401 || attempt > 0 || !this.prove) break;
      // A proof this device's clock put too far from the server's: the server says its time.
      const parsed = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>;
      if (parsed.error !== "proof_stale" || typeof parsed.now !== "number") break;
      this.clockOffset = parsed.now - Date.now();
    }
    if (!response.ok) {
      const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        response.status,
        typeof parsed.error === "string" ? parsed.error : "error",
        typeof parsed.message === "string" ? parsed.message : `The server responded with status ${response.status}.`,
        parsed,
      );
    }
    return (await response.json()) as T;
  }

  // Server
  info = () => this.request<ServerInfo>("GET", "/api/info");
  inviteInfo = (code: string) =>
    this.request<{ setup: boolean; server: ServerInfo }>("GET", at`/api/invites/${code}`);

  // Accounts
  prelogin = (username: string) => this.request<ApiKdf>("POST", "/api/auth/prelogin", { username });
  register = (body: Record<string, unknown>) =>
    this.request<{ user_id: string; token: string; role: "owner" | "admin" | "member" }>("POST", "/api/auth/register", body);
  login = (username: string, authKey: Uint8Array) =>
    this.request<LoginResponse>("POST", "/api/auth/login", { username, auth_key: authKey, client: ACCOUNT_PROTOCOL });
  recover = (username: string, recoveryAuthKey: Uint8Array) =>
    this.request<LoginResponse>("POST", "/api/auth/recover", { username, recovery_auth_key: recoveryAuthKey, client: ACCOUNT_PROTOCOL });
  upgradeChallenge = (username: string, kind: "password" | "recovery") =>
    this.request<{ salt: string; challenge: string }>("POST", "/api/auth/upgrade-challenge", { username, kind });
  upgradeKey = (body: { username: string; kind: string; origin: string; challenge: Uint8Array; proof: Uint8Array; auth_key: Uint8Array }) =>
    this.request("POST", "/api/auth/upgrade", body);
  changePassword = (body: Record<string, unknown>) => this.request("POST", "/api/auth/password", body);
  changeRecoveryKey = (body: Record<string, unknown>) => this.request("POST", "/api/auth/recovery-key", body);
  logout = () => this.request("POST", "/api/auth/logout", {});
  setPush = (body: { relay: string; handle: string; key: Uint8Array; registration: string; muted: string[]; muted_until: Record<string, number>; filters: boolean }) =>
    this.request("PUT", "/api/push", body);
  deletePush = () => this.request("DELETE", "/api/push");

  // Users and devices
  users = (since = 0) =>
    this.request<{ users: ApiUser[]; online: string[]; now: number }>("GET", at`/api/users?since=${since}`);
  user = (id: string) => this.request<ApiUser>("GET", at`/api/users/${id}`);
  updateMe = (body: { profile?: Uint8Array; profile_sig?: Uint8Array; avatar_file?: string | null; hide_last_seen?: boolean }) =>
    this.request("PATCH", "/api/me", body);
  addDevice = (id: string, certificate: Uint8Array, signatureKey: Uint8Array, extra?: { generation: number; seal_key: Uint8Array; seal_sig: Uint8Array; enroll_proof?: Uint8Array; seal_generation: number; seal_proof: Uint8Array }) =>
    this.request("POST", "/api/devices", { id, certificate, signature_key: signatureKey, ...extra });
  revokeDevice = (id: string) => this.request("DELETE", at`/api/devices/${id}`);

  // Key packages
  keyPackageStatus = () => this.request<{ count: number; last_resort_at: number }>("GET", "/api/key-packages/status");
  addKeyPackages = (keyPackages: Uint8Array[], lastResort?: Uint8Array) =>
    this.request("POST", "/api/key-packages", { key_packages: keyPackages, last_resort: lastResort });
  claimKeyPackages = async (userId: string) =>
    (await this.request<{ key_packages: { user_id: string; device_id: string; data: string }[] }>(
      "POST",
      at`/api/users/${userId}/key-packages/claim`,
      {},
    )).key_packages;

  // Vault
  vaultItems = async (since: number) =>
    (await this.request<{ items: ApiVaultItem[] }>("GET", at`/api/vault?since=${since}`)).items;
  putVaultItems = (items: { id: string; data: Uint8Array }[]) => this.request<{ seq: number }>("PUT", "/api/vault", { items });
  historyGrants = async () =>
    (await this.request<{ grants: { id: number; group_id: string; data: string }[] }>("GET", "/api/history-grants")).grants;
  deleteHistoryGrant = (id: number) => this.request("DELETE", at`/api/history-grants/${id}`);

  // Generations of an account's keys
  account = () => this.request<ApiAccount>("GET", "/api/v2/account");
  rotate = (body: unknown) => this.request("POST", "/api/v2/account/rotate", body);
  putBundles = (generation: number, bundles: { device_id: string; data: Uint8Array }[]) =>
    this.request("POST", "/api/v2/account/bundles", { generation, bundles });
  addFirstSlot = (slot: Record<string, unknown>, vaultCore: Uint8Array) =>
    this.request("POST", "/api/v2/account/slots", { slot, vault_core: vaultCore });
  closeGeneration = (generation: number, vaultCore: Uint8Array) =>
    this.request("POST", "/api/v2/account/core", { generation, vault_core: vaultCore });
  setSealKey = (deviceId: string, sealKey: Uint8Array, sealSig: Uint8Array, generation: number, proof: Uint8Array) =>
    this.request("PUT", at`/api/v2/devices/${deviceId}/seal-key`, { seal_key: sealKey, seal_sig: sealSig, seal_generation: generation, seal_proof: proof });
  setCertificate = (deviceId: string, certificate: Uint8Array) =>
    this.request("PUT", at`/api/v2/devices/${deviceId}/certificate`, { certificate });
  identityLinks = async (userId: string, after: number) =>
    (await this.request<{ links: ApiLink[] }>("GET", at`/api/users/${userId}/identity-links?after=${after}`)).links;
  vaultItemsAtAnyGeneration = async (since: number) =>
    (await this.request<{ items: ApiVaultItem[] }>("GET", at`/api/v2/vault?since=${since}`)).items;
  putVaultItemsAt = (generation: number, items: { id: string; data: Uint8Array }[]) =>
    this.request<{ seq: number }>("PUT", "/api/v2/vault", { generation, items });
  olderVaultItems = async (limit: number) =>
    (await this.request<{ items: ApiVaultItem[] }>("GET", at`/api/v2/vault/older?limit=${limit}`)).items;
  resealVault = (generation: number, items: { id: string; data: Uint8Array }[], remove: string[]) =>
    this.request("POST", "/api/v2/vault/reseal", { generation, items, delete: remove });
  historyGrantsAtAnyGeneration = async () =>
    (await this.request<{ grants: { id: number; group_id: string; data: string }[] }>("GET", "/api/v2/history-grants")).grants;

  // Groups
  groups = async () => (await this.request<{ groups: ApiGroup[] }>("GET", "/api/groups")).groups;
  group = (id: string) => this.request<ApiGroup>("GET", at`/api/groups/${id}`);
  createDm = (peerId: string) =>
    this.request<{ group: ApiGroup; created: boolean }>("POST", "/api/groups", { kind: "dm", peer_id: peerId });
  createGroup = (historyVisible: boolean) =>
    this.request<{ group: ApiGroup; created: boolean }>("POST", "/api/groups", { kind: "group", history_visible: historyVisible });
  deleteGroup = (id: string) => this.request("DELETE", at`/api/groups/${id}`);
  commit = (groupId: string, body: CommitRequest) =>
    this.request<{ seq: number; epoch: number }>("POST", at`/api/groups/${groupId}/commit`, body);
  voidCommits = (groupId: string, fromEpoch: number, toEpoch: number, groupInfo: Uint8Array) =>
    this.request("POST", at`/api/groups/${groupId}/void-commits`, { from_epoch: fromEpoch, to_epoch: toEpoch, group_info: groupInfo });
  groupInfo = (groupId: string) =>
    this.request<{ group_info: string | null; epoch: number }>("GET", at`/api/groups/${groupId}/group-info`);
  setGroupMeta = (groupId: string, meta: Uint8Array, epoch: number, historyVisible?: boolean) =>
    this.request("PUT", at`/api/groups/${groupId}/meta`, { meta, epoch, history_visible: historyVisible });
  leaveGroup = (groupId: string) => this.request("POST", at`/api/groups/${groupId}/leave`, {});
  setGroupRole = (groupId: string, userId: string, role: "admin" | "member") =>
    this.request("PUT", at`/api/groups/${groupId}/members/${userId}/role`, { role });
  setRead = (groupId: string, data: Uint8Array) => this.request("PUT", at`/api/groups/${groupId}/read`, { data });
  changes = (groupId: string, after: number, limit = 200) =>
    this.request<ApiChanges>("GET", at`/api/groups/${groupId}/changes?after=${after}&limit=${limit}`);
  welcomes = async () => (await this.request<{ welcomes: ApiWelcome[] }>("GET", "/api/welcomes")).welcomes;
  deleteWelcome = (id: number) => this.request("DELETE", at`/api/welcomes/${id}`);

  // Channels and voice
  channels = () => this.request<{ channels: ApiChannel[]; voice: ApiVoiceState[] }>("GET", "/api/channels");
  createChannel = (body: { id: string; type: "text" | "voice"; details: Uint8Array; user_limit: number; screen_limit: number; proof: Uint8Array }) =>
    this.request<{ channel: ApiChannel; group: ApiGroup }>("POST", "/api/channels", body);
  updateChannel = (id: string, details: Uint8Array, userLimit?: number, screenLimit?: number) =>
    this.request("PATCH", at`/api/channels/${id}`, { details, user_limit: userLimit, screen_limit: screenLimit });
  orderChannels = (ids: string[]) => this.request("PUT", "/api/channels/order", { ids });
  deleteChannel = (id: string) => this.request("DELETE", at`/api/channels/${id}`);
  joinChannel = (id: string, proof: Uint8Array, wantHistory: boolean) =>
    this.request<{ group: ApiGroup }>("POST", at`/api/channels/${id}/join`, { proof, want_history: wantHistory });
  grantChannelHistory = (id: string, userId: string, data: Uint8Array) =>
    this.request("POST", at`/api/channels/${id}/history-grants`, { user_id: userId, data });
  voiceToken = (id: string) =>
    this.request<{ url: string; token: string; identity: string; server_muted: boolean }>("POST", at`/api/channels/${id}/voice`, {});
  startScreen = (id: string, how: { browser: boolean; sound: boolean }) =>
    this.request<{ url?: string; token?: string; identity?: string; sound?: boolean }>("POST", at`/api/channels/${id}/voice/screen`, how);
  stopScreen = (id: string) => this.request("DELETE", at`/api/channels/${id}/voice/screen`);
  stopScreenOf = (id: string, userId: string) => this.request("DELETE", at`/api/channels/${id}/voice/users/${userId}/screen`);
  voiceDisconnect = (id: string, userId: string) => this.request("POST", at`/api/channels/${id}/voice/users/${userId}/disconnect`, {});
  voiceMute = (id: string, userId: string, muted: boolean) => this.request("PUT", at`/api/channels/${id}/voice/users/${userId}/mute`, { muted });

  // Messages
  messages = async (groupId: string, options: { before?: number; around?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (options.before !== undefined) query.set("before", String(options.before));
    if (options.around !== undefined) query.set("around", String(options.around));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return (await this.request<{ messages: ApiMessage[] }>("GET", `${at`/api/groups/${groupId}/messages`}?${query}`)).messages;
  };
  message = (groupId: string, id: string) => this.request<ApiMessage>("GET", at`/api/groups/${groupId}/messages/${id}`);
  sendMessage = (groupId: string, body: { id: string; epoch: number; envelope: Uint8Array; file_ids?: string[]; expires_in?: number }) =>
    this.request<ApiMessage>("POST", at`/api/groups/${groupId}/messages`, body);
  editMessage = (groupId: string, id: string, epoch: number, envelope: Uint8Array) =>
    this.request<ApiMessage>("PUT", at`/api/groups/${groupId}/messages/${id}`, { epoch, envelope });
  /** Signs one request as this device starts, so that from then on its session token alone can't do what needs proof. */
  proveDevice = () => this.request<{ ok: boolean }>("POST", "/api/devices/proof");
  deleteMessage = (groupId: string, id: string, epoch: number, deletion: Uint8Array) =>
    this.request<ApiMessage>("DELETE", at`/api/groups/${groupId}/messages/${id}`, { epoch, deletion });
  addReaction = (groupId: string, messageId: string, id: string, epoch: number, data: Uint8Array) =>
    this.request<ApiMessage>("POST", at`/api/groups/${groupId}/messages/${messageId}/reactions`, { id, epoch, data });
  removeReaction = (groupId: string, messageId: string, id: string) =>
    this.request<ApiMessage>("DELETE", at`/api/groups/${groupId}/messages/${messageId}/reactions/${id}`);
  pin = (groupId: string, messageId: string, pinned: boolean, epoch: number, pin: Uint8Array) =>
    this.request<ApiMessage>(pinned ? "PUT" : "DELETE", at`/api/groups/${groupId}/messages/${messageId}/pin`, { epoch, pin });
  pins = async (groupId: string) =>
    (await this.request<{ messages: ApiMessage[] }>("GET", at`/api/groups/${groupId}/pins`)).messages;

  // Files
  createFile = (chunkCount: number, totalSize: number) =>
    this.request<{ id: string }>("POST", "/api/files", { chunk_count: chunkCount, total_size: totalSize });
  uploadChunk = (id: string, n: number, data: Uint8Array) => this.request("PUT", at`/api/files/${id}/chunks/${n}`, undefined, data);
  completeFile = (id: string, attach = false) => this.request("POST", `${at`/api/files/${id}/complete`}${attach ? "?attach=1" : ""}`, {});

  async downloadChunk(id: string, n: number): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${at`/api/files/${id}/chunks/${n}`}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ApiError(0, "network", "Couldn't download the file. Check your connection.");
    }
    if (!response.ok) throw new ApiError(response.status, "download_failed", "This file isn't available anymore.");
    return new Uint8Array(await response.arrayBuffer());
  }

  // Emotes
  emotes = () => this.request<{ set_id: string; set_name: string; emotes: Emote[] }>("GET", "/api/emotes");
  emoteUrl = (id: string, size: 1 | 2 | 3 | 4 = 2) => `${this.baseUrl}${at`/api/emotes/${id}`}/${size}x.webp`;
  iconUrl = () => `${this.baseUrl}/api/icon`;

  // Administration
  invites = async () => (await this.request<{ invites: Invite[] }>("GET", "/api/invites")).invites;
  createInvite = (maxUses: number, expiresInSeconds: number) =>
    this.request<{ code: string }>("POST", "/api/invites", { max_uses: maxUses, expires_in_seconds: expiresInSeconds });
  revokeInvite = (code: string) => this.request("DELETE", at`/api/invites/${code}`);
  updateSettings = (body: Record<string, unknown>) => this.request("PATCH", "/api/admin/settings", body);
  updateIcon = (image: Uint8Array | Blob) => this.request("PUT", "/api/admin/icon", undefined, image);
  setEmoteSet = (set: string) =>
    this.request<{ set_id: string; set_name: string; count: number }>("PUT", "/api/admin/emote-set", { set });
  setRole = (userId: string, role: "admin" | "member") => this.request("PUT", at`/api/admin/users/${userId}/role`, { role });
  ban = (userId: string) => this.request("POST", at`/api/admin/users/${userId}/ban`, {});
  unban = (userId: string) => this.request("POST", at`/api/admin/users/${userId}/unban`, {});
}

export interface LoginResponse {
  user_id: string;
  username: string;
  role: "owner" | "admin" | "member";
  token: string;
  wrapped_key: string;
  vault_core: string;
  // What a server that keeps generations of keys adds.
  protocol?: number;
  generation?: number;
  slot?: ApiSlot | null;
  bridge?: string | null;
  head_link?: ApiLink | null;
}

export const decode = (value: string | null | undefined): Uint8Array =>
  value ? fromBase64(value) : new Uint8Array(0);
