// A typed client for the server's REST interface. Binary fields travel as base64.

import { fromBase64, toBase64 } from "./encoding";
import type { Emote, Invite, ServerInfo } from "./types";

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
  hpke_key: string;
  hpke_key_sig: string;
  profile: string | null;
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
}

export interface ApiMember {
  user_id: string;
  role: "admin" | "member";
  joined_at: number;
  visible_from_seq: number;
  read_state: string | null;
}

export interface ApiGroup {
  id: string;
  kind: "dm" | "group";
  epoch: number;
  seq: number;
  meta: string | null;
  meta_epoch: number | null;
  history_visible: boolean;
  created_by: string;
  created_at: number;
  members: ApiMember[];
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
  reactions: ApiReaction[];
}

export interface ApiEvent {
  group_id: string;
  seq: number;
  kind: "commit" | "member_left";
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
function encodeBody(value: unknown): unknown {
  if (value instanceof Uint8Array) return toBase64(value);
  if (Array.isArray(value)) return value.map(encodeBody);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBody(v)]));
  }
  return value;
}

export class Api {
  token: string | null = null;

  constructor(readonly baseUrl: string) {}

  private async request<T>(method: string, path: string, body?: unknown, raw?: Uint8Array | Blob): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    if (raw) {
      payload = raw as BodyInit;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(encodeBody(body));
    }
    let response: Response;
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
    this.request<{ setup: boolean; server: ServerInfo }>("GET", `/api/invites/${encodeURIComponent(code)}`);

  // Accounts
  prelogin = (username: string) => this.request<ApiKdf>("POST", "/api/auth/prelogin", { username });
  register = (body: Record<string, unknown>) =>
    this.request<{ user_id: string; token: string; role: "owner" | "admin" | "member" }>("POST", "/api/auth/register", body);
  login = (username: string, authKey: Uint8Array) =>
    this.request<LoginResponse>("POST", "/api/auth/login", { username, auth_key: authKey });
  recover = (username: string, recoveryAuthKey: Uint8Array) =>
    this.request<LoginResponse>("POST", "/api/auth/recover", { username, recovery_auth_key: recoveryAuthKey });
  upgradeChallenge = (username: string, kind: "password" | "recovery") =>
    this.request<{ salt: string; challenge: string }>("POST", "/api/auth/upgrade-challenge", { username, kind });
  upgradeKey = (body: { username: string; kind: string; origin: string; challenge: Uint8Array; proof: Uint8Array; auth_key: Uint8Array }) =>
    this.request("POST", "/api/auth/upgrade", body);
  changePassword = (body: Record<string, unknown>) => this.request("POST", "/api/auth/password", body);
  changeRecoveryKey = (body: Record<string, unknown>) => this.request("POST", "/api/auth/recovery-key", body);
  logout = () => this.request("POST", "/api/auth/logout", {});
  setPush = (body: { relay: string; handle: string; key: Uint8Array; registration: string; muted: string[]; muted_until: Record<string, number> }) =>
    this.request("PUT", "/api/push", body);
  deletePush = () => this.request("DELETE", "/api/push");

  // Users and devices
  users = (since = 0) =>
    this.request<{ users: ApiUser[]; online: string[]; now: number }>("GET", `/api/users?since=${since}`);
  user = (id: string) => this.request<ApiUser>("GET", `/api/users/${id}`);
  updateMe = (body: { profile?: Uint8Array; avatar_file?: string | null; hide_last_seen?: boolean }) =>
    this.request("PATCH", "/api/me", body);
  addDevice = (id: string, certificate: Uint8Array, signatureKey: Uint8Array) =>
    this.request("POST", "/api/devices", { id, certificate, signature_key: signatureKey });
  revokeDevice = (id: string) => this.request("DELETE", `/api/devices/${id}`);

  // Key packages
  keyPackageStatus = () => this.request<{ count: number; last_resort_at: number }>("GET", "/api/key-packages/status");
  addKeyPackages = (keyPackages: Uint8Array[], lastResort?: Uint8Array) =>
    this.request("POST", "/api/key-packages", { key_packages: keyPackages, last_resort: lastResort });
  claimKeyPackages = async (userId: string) =>
    (await this.request<{ key_packages: { user_id: string; device_id: string; data: string }[] }>(
      "POST",
      `/api/users/${userId}/key-packages/claim`,
      {},
    )).key_packages;

  // Vault
  vaultItems = async (since: number) =>
    (await this.request<{ items: { id: string; seq: number; data: string }[] }>("GET", `/api/vault?since=${since}`)).items;
  putVaultItems = (items: { id: string; data: Uint8Array }[]) => this.request<{ seq: number }>("PUT", "/api/vault", { items });
  historyGrants = async () =>
    (await this.request<{ grants: { id: number; group_id: string; data: string }[] }>("GET", "/api/history-grants")).grants;
  deleteHistoryGrant = (id: number) => this.request("DELETE", `/api/history-grants/${id}`);

  // Groups
  groups = async () => (await this.request<{ groups: ApiGroup[] }>("GET", "/api/groups")).groups;
  group = (id: string) => this.request<ApiGroup>("GET", `/api/groups/${id}`);
  createDm = (peerId: string) =>
    this.request<{ group: ApiGroup; created: boolean }>("POST", "/api/groups", { kind: "dm", peer_id: peerId });
  createGroup = (historyVisible: boolean) =>
    this.request<{ group: ApiGroup; created: boolean }>("POST", "/api/groups", { kind: "group", history_visible: historyVisible });
  deleteGroup = (id: string) => this.request("DELETE", `/api/groups/${id}`);
  commit = (groupId: string, body: CommitRequest) =>
    this.request<{ seq: number; epoch: number }>("POST", `/api/groups/${groupId}/commit`, body);
  groupInfo = (groupId: string) =>
    this.request<{ group_info: string | null; epoch: number }>("GET", `/api/groups/${groupId}/group-info`);
  setGroupMeta = (groupId: string, meta: Uint8Array, epoch: number, historyVisible?: boolean) =>
    this.request("PUT", `/api/groups/${groupId}/meta`, { meta, epoch, history_visible: historyVisible });
  leaveGroup = (groupId: string) => this.request("POST", `/api/groups/${groupId}/leave`, {});
  setGroupRole = (groupId: string, userId: string, role: "admin" | "member") =>
    this.request("PUT", `/api/groups/${groupId}/members/${userId}/role`, { role });
  setRead = (groupId: string, data: Uint8Array) => this.request("PUT", `/api/groups/${groupId}/read`, { data });
  changes = (groupId: string, after: number, limit = 200) =>
    this.request<ApiChanges>("GET", `/api/groups/${groupId}/changes?after=${after}&limit=${limit}`);
  welcomes = async () => (await this.request<{ welcomes: ApiWelcome[] }>("GET", "/api/welcomes")).welcomes;
  deleteWelcome = (id: number) => this.request("DELETE", `/api/welcomes/${id}`);

  // Messages
  messages = async (groupId: string, options: { before?: number; around?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (options.before !== undefined) query.set("before", String(options.before));
    if (options.around !== undefined) query.set("around", String(options.around));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return (await this.request<{ messages: ApiMessage[] }>("GET", `/api/groups/${groupId}/messages?${query}`)).messages;
  };
  message = (groupId: string, id: string) => this.request<ApiMessage>("GET", `/api/groups/${groupId}/messages/${id}`);
  sendMessage = (groupId: string, body: { id: string; epoch: number; envelope: Uint8Array; file_ids?: string[] }) =>
    this.request<ApiMessage>("POST", `/api/groups/${groupId}/messages`, body);
  editMessage = (groupId: string, id: string, epoch: number, envelope: Uint8Array) =>
    this.request<ApiMessage>("PUT", `/api/groups/${groupId}/messages/${id}`, { epoch, envelope });
  deleteMessage = (groupId: string, id: string) => this.request<ApiMessage>("DELETE", `/api/groups/${groupId}/messages/${id}`);
  addReaction = (groupId: string, messageId: string, id: string, epoch: number, data: Uint8Array) =>
    this.request<ApiMessage>("POST", `/api/groups/${groupId}/messages/${messageId}/reactions`, { id, epoch, data });
  removeReaction = (groupId: string, messageId: string, id: string) =>
    this.request<ApiMessage>("DELETE", `/api/groups/${groupId}/messages/${messageId}/reactions/${id}`);
  pin = (groupId: string, messageId: string, pinned: boolean) =>
    this.request<ApiMessage>(pinned ? "PUT" : "DELETE", `/api/groups/${groupId}/messages/${messageId}/pin`);
  pins = async (groupId: string) =>
    (await this.request<{ messages: ApiMessage[] }>("GET", `/api/groups/${groupId}/pins`)).messages;

  // Files
  createFile = (chunkCount: number, totalSize: number) =>
    this.request<{ id: string }>("POST", "/api/files", { chunk_count: chunkCount, total_size: totalSize });
  uploadChunk = (id: string, n: number, data: Uint8Array) => this.request("PUT", `/api/files/${id}/chunks/${n}`, undefined, data);
  completeFile = (id: string, attach = false) => this.request("POST", `/api/files/${id}/complete${attach ? "?attach=1" : ""}`, {});

  async downloadChunk(id: string, n: number): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/files/${id}/chunks/${n}`, {
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
  emoteUrl = (id: string, size: 1 | 2 | 3 | 4 = 2) => `${this.baseUrl}/api/emotes/${id}/${size}x.webp`;
  iconUrl = () => `${this.baseUrl}/api/icon`;

  // Administration
  invites = async () => (await this.request<{ invites: Invite[] }>("GET", "/api/invites")).invites;
  createInvite = (maxUses: number, expiresInSeconds: number) =>
    this.request<{ code: string }>("POST", "/api/invites", { max_uses: maxUses, expires_in_seconds: expiresInSeconds });
  revokeInvite = (code: string) => this.request("DELETE", `/api/invites/${encodeURIComponent(code)}`);
  updateSettings = (body: Record<string, unknown>) => this.request("PATCH", "/api/admin/settings", body);
  updateIcon = (image: Uint8Array | Blob) => this.request("PUT", "/api/admin/icon", undefined, image);
  setEmoteSet = (set: string) =>
    this.request<{ set_id: string; set_name: string; count: number }>("PUT", "/api/admin/emote-set", { set });
  setRole = (userId: string, role: "admin" | "member") => this.request("PUT", `/api/admin/users/${userId}/role`, { role });
  ban = (userId: string) => this.request("POST", `/api/admin/users/${userId}/ban`, {});
  unban = (userId: string) => this.request("POST", `/api/admin/users/${userId}/unban`, {});
}

export interface LoginResponse {
  user_id: string;
  username: string;
  role: "owner" | "admin" | "member";
  token: string;
  wrapped_key: string;
  vault_core: string;
}

export const decode = (value: string | null | undefined): Uint8Array =>
  value ? fromBase64(value) : new Uint8Array(0);
