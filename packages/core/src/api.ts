// A typed client for the server's REST interface. Binary fields travel as base64.

import * as wasm from "@zuna/crypto";
import { concat, fromBase64, toBase64, utf8 } from "./encoding";
import type { Emote, Invite, ReportReason, ServerInfo } from "./types";

/**
 * A request's path, with whatever goes in it kept to one part of the path, whatever
 * it says. Some of it comes from other people's messages, and the request carries
 * this person's token.
 */
function at(parts: TemplateStringsArray, ...values: (string | number)[]): string {
  return parts.reduce((path, part, index) => path + encodeURIComponent(values[index - 1]!) + part);
}

/** A token pays for something added to a conversation up to 32 KiB, or a large one for anything up to the server's limit. */
export type TokenSize = "small" | "large";

/** The public key tokens of one size are issued under in one period. */
export interface ApiTokenKey {
  period: number;
  size: TokenSize;
  public: string;
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
  key_generation: number;
  hpke_key: string;
  hpke_key_sig: string;
  profile: string | null;
  profile_sig?: string | null;
  last_seen_at: number | null;
  hide_last_seen: boolean;
  banned: boolean;
  deleted: boolean;
  created_at: number;
  updated_at: number;
  devices: ApiDevice[];
  /** Set for a bot. The proof is its signature on its identity key, by the key its setup link held, and comes to its owner alone. */
  bot?: { owner_id: string; listed: boolean; add: string; proof?: string | null } | null;
}

/** A bot as the server lists it for its owner, and a listed one for the server's admins. */
export interface ApiBot {
  id: string;
  owner_id: string;
  username: string;
  listed: boolean;
  add: string;
  files: boolean;
  channels: string[];
  set_up: boolean;
  created_at: number;
}

/** Someone reported to the server's admins, why and when. Who reported them isn't kept. */
export interface ApiReport {
  user_id: string;
  reason: string;
  created_at: number;
}

/** Someone banned from the server: when, and by which admin. */
export interface ApiBan {
  user_id: string;
  banned_at: number;
  banned_by: string;
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
  enroll_proof?: string | null;
  seal_generation?: number | null;
  seal_proof?: string | null;
}

/** A place in the log of who holds which keys: its record, and its body if its account is there for this device. */
export interface ApiLogRecord {
  idx: number;
  record: string;
  body?: string | null;
}

/** The log at some size, signed with the server's log key. */
export interface ApiLogHead {
  era: number;
  size: number;
  root: string;
  sig: string;
}

/** The records after a place, and the head where they end. */
export interface ApiLogPage {
  era: number;
  size: number;
  head: ApiLogHead;
  records: ApiLogRecord[];
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

/** How many of something the server keeps, and their size in bytes. */
export interface ApiExportBulk {
  count: number;
  bytes: number;
}

/**
 * Everything the server keeps about an account (`POST /api/account/export`), as
 * `server/internal/store/export.go` writes it. Bytes come as base64, and what would let
 * someone guess the password or act with it only as a size.
 */
export interface ApiExport {
  exported_at: number;
  account: {
    id: string;
    username: string;
    role: string;
    created_at: number;
    updated_at: number;
    last_seen_at: number | null;
    hide_last_seen: boolean;
    banned_at: number | null;
    banned_by: string | null;
    deleted_at: number | null;
    key_generation: number;
    identity_key: string | null;
    identity_head: string | null;
    hpke_key: string | null;
    hpke_key_sig: string | null;
    profile: string | null;
    profile_sig: string | null;
    avatar_file: string | null;
    vault_core: string | null;
    stored_bytes: number;
    commit_bytes: number;
  };
  sign_in: {
    kdf: { salt: string; memory: number; iterations: number; parallelism: number };
    auth_hash_size: number;
    recovery_hash_size: number;
    slots: { kind: string; size: number }[];
    attempts: { attempts: number; until: number; seen_at: number } | null;
  };
  devices: ApiExportDevice[];
  signing_in: ApiExportSession[];
  conversations: ApiExportConversation[];
  vault: { items: ApiExportBulk; history_grants: ApiExportBulk };
  files: { id: string; size: number; created_at: number; completed_at: number | null; attached_at: number | null; standalone: boolean }[];
  uploads: { day: number; mib: number }[];
  tokens: { period: number; size: string; issued: number }[];
  invites: { created_at: number; grants_role: string; max_uses: number; uses: number; expires_at: number | null; revoked_at: number | null }[];
  bots: { id: string; username: string; listed: boolean; add_policy: string; files: boolean; created_at: number; set_up_at: number | null; deleted_at: number | null; channels: string[] }[];
  admin: {
    channels: { id: string; created_at: number }[];
    sounds: { id: string; created_at: number }[];
    banned: { id: string; username: string; banned_at: number }[];
  };
  key_changes: { links: { generation: number; created_at: number }[]; log_entries: number };
}

export interface ApiExportSession {
  created_at: number;
  last_used_at: number;
}

export interface ApiExportDevice {
  id: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  signature_key: string | null;
  certificate: string | null;
  seal_key: string | null;
  seal_generation: number | null;
  seal_proof: string | null;
  enroll_proof: string | null;
  sessions: ApiExportSession[];
  key_packages: ApiExportBulk;
  welcomes: ApiExportBulk;
  account_key: { generation: number; size: number } | null;
  push: {
    relay: string;
    handle_size: number;
    call_handle_size: number;
    key: string | null;
    registration: string;
    muted: Record<string, number> | null;
    filters: boolean;
    notified: string[];
    updated_at: number;
  } | null;
}

export interface ApiExportConversation {
  id: string;
  kind: "dm" | "group" | "channel";
  dm_key?: string;
  created_by: string;
  created_at: number;
  epoch: number;
  changes: number;
  history_visible: boolean;
  meta_size: number;
  membership: { role: string; joined_at: number; visible_from_seq: number; read_state_size: number; proof_size: number; history_wanted: boolean } | null;
  member_count: number;
  members: { id: string; username: string; role: string; joined_at: number }[];
  messages: { count: number; bytes: number; deleted: number; first: number | null; last: number | null };
  by_you: { count: number; last: number | null };
  to_you: { count: number; last: number | null };
}

export interface ApiAccount {
  generation: number;
  vault_core: string;
  bundle: { device_id: string; generation: number; data: string } | null;
  older_items: number;
  missing_bundles: string[];
}

export interface ApiVaultItem {
  id: string;
  seq: number;
  generation: number;
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
  /** Who a direct message is between, which stays so once either has gone. */
  dm_users?: string[];
  /** The public half of the current epoch's send key, as whoever made the epoch gave it. */
  send_key?: string | null;
}

export interface ApiChannel {
  id: string;
  type: "text" | "voice";
  position: number;
  user_limit: number;
  screen_limit: number;
  /** Whether the soundboard plays there. */
  sounds: boolean;
  /** Whether people may watch YouTube together there. */
  watch: boolean;
  /** Slow mode: how long each person waits between messages, in seconds, or 0. */
  slow_mode: number;
  details: string;
  created_by: string;
  created_at: number;
}

export interface ApiSound {
  id: string;
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
  /** The room is a conversation's call. */
  call?: boolean;
}

export interface ApiCall {
  group_id: string;
  started_by: string;
  started_at: number;
  ringing: string[];
  declined: string[];
}

/** Whose a reaction is, the server isn't told: it's inside, under its device's signature. */
export interface ApiReaction {
  id: string;
  epoch: number;
  data: string;
  /** The public half of the key only its author's devices can make, which taking it back takes. */
  item_key?: string;
  created_at: number;
}

/**
 * A message as the server holds it. Who sent it, who pinned it and who deleted it are
 * inside what it carries, under their devices' signatures, and nowhere else.
 */
export interface ApiMessage {
  group_id: string;
  id: string;
  seq: number;
  updated_seq: number;
  epoch: number;
  envelope?: string;
  /** The public half of the key only its author's devices can make, which changing or deleting it takes. It names nobody. */
  item_key?: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  pinned_at: number | null;
  /** What the deleting device signed. */
  deletion?: string;
  /** What the device that last pinned or unpinned it signed. */
  pin?: string;
  /**
   * Left out where it's sent live, or answers a change: reactions then come one at a time
   * (ApiReactionChange), and apps keep the ones they hold. Only a fetch carries them all.
   */
  reactions?: ApiReaction[];
}

/** One reaction added to a message, or taken back, on its own, at the message's new place in the change feed. */
export interface ApiReactionChange {
  group_id: string;
  message_id: string;
  seq: number;
  updated_seq: number;
  reaction?: ApiReaction;
  removed?: string;
}

/** A message pinned or unpinned, on its own: a sealed request is never answered with the message, as it can't tell who's asking. */
export interface ApiPinChange {
  group_id: string;
  message_id: string;
  seq: number;
  updated_seq: number;
  pinned_at: number | null;
  pin?: string;
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
  /** For a commit: the send key it gave the epoch it made. */
  send_key?: string;
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
  /** The public half of the new epoch's send key. */
  send_key: Uint8Array;
  kind: string;
  add_users?: string[];
  remove_users?: string[];
  /**
   * The commit's welcome, once, for every device it adds (`welcome_to`): with hybrid keys it carries
   * the group's tree at a few kilobytes a device, which going up once for each would multiply.
   */
  welcome?: Uint8Array;
  welcome_to?: string[];
  meta?: Uint8Array;
  meta_epoch?: number;
  history_grants?: { user_id: string; data: Uint8Array }[];
  /** A group's admins, as the roster this commit carries names them. */
  admins?: string[];
}

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * What a request is given on top for each byte it sends, so a file's chunk or a big
 * commit has time to go up over a slow link: enough for 64 kbit/s, up to a limit.
 */
const MS_PER_BYTE_SENT = 1 / 8;
const LONGEST_REQUEST_MS = 10 * 60_000;

/**
 * A server that makes its own certificate, reached by its IP address, is trusted
 * by the pin its links carry after the #, which browsers never send to it: the
 * SHA-256 of its key's SubjectPublicKeyInfo, in base64url.
 */
const PIN = /^[A-Za-z0-9_-]{43}$/;

/** The pin in a link's part after the #, if it has one. */
export function pinIn(fragment: string): string | null {
  const pin = new URLSearchParams(fragment.replace(/^#/, "")).get("pin");
  if (pin === null) return null;
  if (!PIN.test(pin)) throw new Error("That link isn't complete. Copy it again, with everything after the #.");
  return pin;
}

/**
 * A pin is only for a server reached over HTTPS by its IP address, the only kind that
 * makes its own certificate. A name never gets one, so no link can have the app
 * trust another key for a name, such as the one updates come from.
 */
export function checkPinnable(url: string): void {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "https:" || !(hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname))) {
    throw new Error("Only servers reached over HTTPS by IP address use their own certificate, so only their links can include a pin.");
  }
}

/** What to enter to reach a server: its address, with the pin of one that makes its own certificate. */
export const serverAddress = (url: string, pin: string | null | undefined): string => (pin ? `${url}#pin=${pin}` : url);

/** A string without the slashes it ends with. A loop, as a pattern takes far longer over a long run of them. */
function withoutSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
}

export function normalizeServerUrl(input: string): string {
  let url = withoutSlashes(input.trim());
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.hostname.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !local) {
    throw new Error("Zuna servers must use HTTPS. Plain HTTP only works for localhost.");
  }
  return `${parsed.protocol}//${parsed.host}${withoutSlashes(parsed.pathname)}`;
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

/**
 * What a sealed request is signed and paid with: the group's send key for the epoch it's
 * for, a token, and to change or delete something, its item key.
 */
export interface Seal {
  epoch: number;
  secret: Uint8Array;
  token?: Uint8Array;
  item?: Uint8Array;
}

/** A file a message carries, with the secret it was made with, which shows the server whoever sends it holds it. */
export interface FileShare {
  id: string;
  secret: Uint8Array;
}

export class Api {
  token: string | null = null;
  /**
   * How requests that name nobody go: on a connection of their own, sharing nothing with
   * the session's, where the host can give one. Without it they go through `fetch` with no
   * credentials, as a browser decides for itself which connection a request takes.
   */
  sealedFetch: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
  /**
   * Signs a request with this device's key. What can't be undone, or acts for the
   * whole server, needs it, so that a session token alone can do none of it.
   */
  prove: ((input: Uint8Array) => Uint8Array) | null = null;
  /** How long a request waits for its answer, in ms, before what it's given for each byte it sends. */
  timeout = REQUEST_TIMEOUT_MS;
  /** How far the server's clock is from this device's, once a proof has shown it's off. */
  private clockOffset = 0;

  /** How far the server's clock is ahead of this device's, as far as is known. */
  get serverAhead(): number {
    return this.clockOffset;
  }

  constructor(readonly baseUrl: string) {}

  /** `anonymous` sends nothing of the session: no token and no device's proof. */
  private async request<T>(method: string, path: string, body?: unknown, raw?: Uint8Array | Blob, anonymous = false): Promise<T> {
    const headers: Record<string, string> = {};
    const prove = anonymous ? null : this.prove;
    if (this.token && !anonymous) headers["Authorization"] = `Bearer ${this.token}`;
    let payload: BodyInit | undefined;
    let bytes: Uint8Array = new Uint8Array(0);
    if (raw) {
      payload = raw as BodyInit;
      if (prove && method !== "GET") bytes = raw instanceof Uint8Array ? raw : new Uint8Array(await raw.arrayBuffer());
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      const text = JSON.stringify(encodeBody(body));
      payload = text;
      bytes = utf8(text);
    }
    const sent = raw ? (raw instanceof Uint8Array ? raw.length : raw.size) : bytes.length;
    const timeout = Math.min(this.timeout + Math.ceil(sent * MS_PER_BYTE_SENT), LONGEST_REQUEST_MS);
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      if (prove && method !== "GET") {
        const at = Date.now() + this.clockOffset;
        const input = concat(utf8(`zuna/request/v1|${method}|${path.split("?")[0]}|${at}|`), wasm.sha256(bytes));
        headers["X-Zuna-Proof"] = toBase64(prove(input));
        headers["X-Zuna-Time"] = String(at);
      }
      try {
        response = await fetch(this.baseUrl + path, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeout),
        });
      } catch {
        throw new ApiError(0, "network", "Couldn't reach the server. Check your connection.");
      }
      if (response.status !== 401 || attempt > 0 || !prove) break;
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

  /**
   * A request that adds to a conversation without saying who's sending it: no session, no
   * device and nothing a known key checks. It's signed with the group's send key for its
   * current epoch, which any member could have made, and pays with a token, which can't be
   * tied to whoever was issued it. Signed over the method, path, time, epoch, token and body.
   */
  private async sealedRequest<T>(method: string, path: string, body: unknown, seal: Seal): Promise<T> {
    const text = body === undefined ? "" : JSON.stringify(encodeBody(body));
    const bytes = utf8(text);
    const token = seal.token ?? new Uint8Array(0);
    const send = this.sealedFetch ?? ((url: string, init: RequestInit) => fetch(url, { ...init, credentials: "omit", cache: "no-store" }));
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      const at = Date.now() + this.clockOffset;
      const input = concat(utf8(`zuna/sealed/v1|${method}|${path}|${at}|${seal.epoch}|`), wasm.sha256(token), wasm.sha256(bytes));
      const headers: Record<string, string> = {
        "X-Zuna-Time": String(at),
        "X-Zuna-Epoch": String(seal.epoch),
        "X-Zuna-Seal": toBase64(wasm.sign(seal.secret, input)),
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (seal.token) headers["X-Zuna-Token"] = toBase64(seal.token);
      if (seal.item) headers["X-Zuna-Item"] = toBase64(wasm.sign(seal.item, input));
      try {
        response = await send(this.baseUrl + path, {
          method,
          headers,
          body: body === undefined ? undefined : text,
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS + Math.ceil(bytes.length * MS_PER_BYTE_SENT), LONGEST_REQUEST_MS)),
        });
      } catch {
        throw new ApiError(0, "network", "Couldn't reach the server. Check your connection.");
      }
      if (response.status !== 401 || attempt > 0) break;
      // A time this device's clock put too far from the server's: the server says its time.
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
  /** Someone signed in is also told the key the log of keys is signed with. */
  info = () => this.request<ServerInfo & { log_key?: string }>("GET", "/api/info");
  inviteInfo = (code: string) =>
    this.request<{ setup: boolean; bot?: boolean; server: ServerInfo }>("GET", at`/api/invites/${code}`);

  // Accounts
  prelogin = (username: string) => this.request<ApiKdf>("POST", "/api/auth/prelogin", { username });
  register = (body: Record<string, unknown>) =>
    this.request<{ user_id: string; token: string; role: "owner" | "admin" | "member" }>("POST", "/api/auth/register", body);
  login = (username: string, authKey: Uint8Array) =>
    this.request<LoginResponse>("POST", "/api/auth/login", { username, auth_key: authKey });
  recover = (username: string, recoveryAuthKey: Uint8Array) =>
    this.request<LoginResponse>("POST", "/api/auth/recover", { username, recovery_auth_key: recoveryAuthKey });
  logout = () => this.request("POST", "/api/auth/logout", {});
  setPush = (body: { relay: string; handle: string; call_handle?: string; key: Uint8Array; registration: string; muted: string[]; muted_until: Record<string, number>; filters: boolean }) =>
    this.request("PUT", "/api/push", body);
  deletePush = () => this.request("DELETE", "/api/push");
  /** The chats the server still counts this phone as showing a notification for. */
  pushNotified = () => this.request<{ groups: string[] }>("GET", "/api/push/notified").then((r) => r.groups);

  // Users and devices
  users = (since = 0) =>
    this.request<{ users: ApiUser[]; online: string[]; seen: Record<string, number>; now: number; log?: { era: number; size: number } | null }>(
      "GET",
      at`/api/users?since=${since}`,
    );
  user = (id: string) => this.request<ApiUser>("GET", at`/api/users/${id}`);
  updateMe = (body: { profile?: Uint8Array; profile_sig?: Uint8Array; avatar_file?: string | null; hide_last_seen?: boolean }) =>
    this.request("PATCH", "/api/me", body);
  addDevice = (id: string, certificate: Uint8Array, signatureKey: Uint8Array, extra: { generation: number; seal_key: Uint8Array; enroll_proof: Uint8Array; seal_generation: number; seal_proof: Uint8Array }) =>
    this.request("POST", "/api/devices", { id, certificate, signature_key: signatureKey, ...extra });
  revokeDevice = (id: string) => this.request("DELETE", at`/api/devices/${id}`);

  // Tokens, which pay for what's added to a conversation without a name
  /** The keys tokens are issued under, asked without the session, so this device is shown what anyone is. */
  tokenKeys = () => this.request<{ period: number; keys: ApiTokenKey[] }>("GET", "/api/tokens/keys", undefined, undefined, true);
  /** Blinded tokens evaluated, counted against this person, with the proof that they were under the period's key. */
  issueTokens = (period: number, size: TokenSize, blinded: Uint8Array[]) =>
    this.request<{ evaluated: string[]; proof: string }>("POST", "/api/tokens", { period, size, blinded });

  // Key packages
  keyPackageStatus = () => this.request<{ count: number; last_resort_at: number }>("GET", "/api/key-packages/status");
  addKeyPackages = (keyPackages: Uint8Array[], lastResort?: Uint8Array) =>
    this.request("POST", "/api/key-packages", { key_packages: keyPackages, last_resort: lastResort });
  /** For the chat `groupId`, which says whether a bot's may be had. */
  claimKeyPackages = async (userId: string, groupId: string) =>
    (await this.request<{ key_packages: { user_id: string; device_id: string; data: string }[] }>(
      "POST",
      at`/api/users/${userId}/key-packages/claim`,
      { group_id: groupId },
    )).key_packages;

  // Vault
  vaultItems = async (since: number, limit = 500) =>
    (await this.request<{ items: ApiVaultItem[] }>("GET", at`/api/vault?since=${since}&limit=${limit}`)).items;
  /** An item with a version has to raise the stored one's, or the server answers `stale_version`. */
  putVaultItems = (generation: number, items: { id: string; data: Uint8Array; version?: number }[]) =>
    this.request<{ seq: number }>("PUT", "/api/vault", { generation, items });
  olderVaultItems = async (limit: number) =>
    (await this.request<{ items: ApiVaultItem[] }>("GET", at`/api/vault/older?limit=${limit}`)).items;
  resealVault = (generation: number, items: { id: string; data: Uint8Array }[], remove: string[]) =>
    this.request("POST", "/api/vault/reseal", { generation, items, delete: remove });
  historyGrants = async () =>
    (await this.request<{ grants: { id: number; group_id: string; data: string }[] }>("GET", "/api/history-grants")).grants;
  deleteHistoryGrant = (id: number) => this.request("DELETE", at`/api/history-grants/${id}`);

  // Generations of an account's keys
  account = () => this.request<ApiAccount>("GET", "/api/account");
  rotate = (body: unknown) => this.request("POST", "/api/account/rotate", body);
  deleteAccount = (authKey: Uint8Array) => this.request("DELETE", "/api/account", { auth_key: authKey });
  /** Everything the server keeps about this account, signed for by this device. */
  exportAccount = () => this.request<ApiExport>("POST", "/api/account/export", {});

  // Reports to the server's admins
  report = (userId: string, reason: ReportReason) => this.request("POST", "/api/reports", { user_id: userId, reason });
  reports = () => this.request<{ reports: ApiReport[] }>("GET", "/api/admin/reports");
  dismissReports = (userId: string) => this.request("DELETE", at`/api/admin/reports/${userId}`);
  putBundles = (generation: number, bundles: { device_id: string; data: Uint8Array }[]) =>
    this.request("POST", "/api/account/bundles", { generation, bundles });
  closeGeneration = (generation: number, vaultCore: Uint8Array) =>
    this.request("POST", "/api/account/core", { generation, vault_core: vaultCore });
  setSealKey = (deviceId: string, sealKey: Uint8Array, generation: number, proof: Uint8Array) =>
    this.request("PUT", at`/api/devices/${deviceId}/seal-key`, { seal_key: sealKey, seal_generation: generation, seal_proof: proof });
  setCertificate = (deviceId: string, certificate: Uint8Array) =>
    this.request("PUT", at`/api/devices/${deviceId}/certificate`, { certificate });
  identityLinks = async (userId: string, after: number) =>
    (await this.request<{ links: ApiLink[] }>("GET", at`/api/users/${userId}/identity-links?after=${after}`)).links;

  // The log of who holds which keys
  /** The records after a place in an era, and the signed head where they end. Asked about another era, the server starts from the beginning of its own. */
  log = (era: number, after: number, limit: number) => this.request<ApiLogPage>("GET", at`/api/log?era=${era}&after=${after}&limit=${limit}`);
  /** Every body of one account's entries, for someone it has only now become there for. */
  logBodies = (userId: string) => this.request<{ era: number; bodies: { idx: number; body: string }[] }>("GET", at`/api/log/bodies?user=${userId}`);

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
  /** An admin's `groupInfo` and `sendKey` are for the epoch it takes the group back to. */
  voidCommits = (groupId: string, fromEpoch: number, toEpoch: number, groupInfo: Uint8Array, sendKey: Uint8Array) =>
    this.request("POST", at`/api/groups/${groupId}/void-commits`, { from_epoch: fromEpoch, to_epoch: toEpoch, group_info: groupInfo, send_key: sendKey });
  groupInfo = (groupId: string) =>
    this.request<{ group_info: string | null; epoch: number }>("GET", at`/api/groups/${groupId}/group-info`);
  setGroupMeta = (groupId: string, meta: Uint8Array, epoch: number, historyVisible?: boolean) =>
    this.request("PUT", at`/api/groups/${groupId}/meta`, { meta, epoch, history_visible: historyVisible });
  leaveGroup = (groupId: string) => this.request("POST", at`/api/groups/${groupId}/leave`, {});
  setRead = (groupId: string, data: Uint8Array) => this.request("PUT", at`/api/groups/${groupId}/read`, { data });
  changes = (groupId: string, after: number, limit = 200) =>
    this.request<ApiChanges>("GET", at`/api/groups/${groupId}/changes?after=${after}&limit=${limit}`);
  welcomes = async () => (await this.request<{ welcomes: ApiWelcome[] }>("GET", "/api/welcomes")).welcomes;
  deleteWelcome = (id: number) => this.request("DELETE", at`/api/welcomes/${id}`);

  // Channels and voice
  channels = () => this.request<{ channels: ApiChannel[]; voice: ApiVoiceState[] }>("GET", "/api/channels");
  createChannel = (body: { id: string; type: "text" | "voice"; details: Uint8Array; user_limit: number; screen_limit: number; sounds?: boolean; watch?: boolean; slow_mode?: number; proof: Uint8Array }) =>
    this.request<{ channel: ApiChannel; group: ApiGroup }>("POST", "/api/channels", body);
  updateChannel = (id: string, details: Uint8Array, changes: { userLimit?: number; screenLimit?: number; sounds?: boolean; watch?: boolean; slowMode?: number }) =>
    this.request("PATCH", at`/api/channels/${id}`, { details, user_limit: changes.userLimit, screen_limit: changes.screenLimit, sounds: changes.sounds, watch: changes.watch, slow_mode: changes.slowMode });
  orderChannels = (ids: string[]) => this.request("PUT", "/api/channels/order", { ids });
  deleteChannel = (id: string) => this.request("DELETE", at`/api/channels/${id}`);
  joinChannel = (id: string, proof: Uint8Array, wantHistory: boolean) =>
    this.request<{ group: ApiGroup }>("POST", at`/api/channels/${id}/join`, { proof, want_history: wantHistory });
  grantChannelHistory = (id: string, userId: string, data: Uint8Array) =>
    this.request("POST", at`/api/channels/${id}/history-grants`, { user_id: userId, data });
  voiceToken = (id: string) =>
    this.request<{ url: string; token: string; identity: string; server_muted: boolean }>("POST", at`/api/channels/${id}/voice`, {});
  startScreen = (id: string, how: { sound: boolean }) => this.request<{ sound: boolean }>("POST", at`/api/channels/${id}/voice/screen`, how);
  stopScreen = (id: string) => this.request("DELETE", at`/api/channels/${id}/voice/screen`);
  stopScreenOf = (id: string, userId: string) => this.request("DELETE", at`/api/channels/${id}/voice/users/${userId}/screen`);
  voiceDisconnect = (id: string, userId: string) => this.request("POST", at`/api/channels/${id}/voice/users/${userId}/disconnect`, {});
  voiceMute = (id: string, userId: string, muted: boolean) => this.request("PUT", at`/api/channels/${id}/voice/users/${userId}/mute`, { muted });
  playSound = (id: string, data: Uint8Array) => this.request("POST", at`/api/channels/${id}/voice/sound`, { data });
  /** A signal about what a voice channel watches together, to everyone else in it, or to one device. */
  watch = (id: string, data: Uint8Array, to?: string) => this.request("POST", at`/api/channels/${id}/voice/watch`, { data, to });

  // Calls in direct messages and groups
  calls = () => this.request<{ calls: ApiCall[]; voice: ApiVoiceState[] }>("GET", "/api/calls");
  callToken = (groupId: string) =>
    this.request<{ url: string; token: string; identity: string; server_muted: boolean }>("POST", at`/api/groups/${groupId}/call`, {});
  startCallScreen = (groupId: string, how: { sound: boolean }) => this.request<{ sound: boolean }>("POST", at`/api/groups/${groupId}/call/screen`, how);
  stopCallScreen = (groupId: string) => this.request("DELETE", at`/api/groups/${groupId}/call/screen`);
  ringCall = (groupId: string, users: string[]) => this.request("POST", at`/api/groups/${groupId}/call/ring`, { users });
  declineCall = (groupId: string) => this.request("POST", at`/api/groups/${groupId}/call/decline`, {});
  playCallSound = (groupId: string, data: Uint8Array) => this.request("POST", at`/api/groups/${groupId}/call/sound`, { data });
  callWatch = (groupId: string, data: Uint8Array, to?: string) => this.request("POST", at`/api/groups/${groupId}/call/watch`, { data, to });

  // Messages
  messages = async (groupId: string, options: { before?: number; after?: number; around?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (options.before !== undefined) query.set("before", String(options.before));
    if (options.after !== undefined) query.set("after", String(options.after));
    if (options.around !== undefined) query.set("around", String(options.around));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return (await this.request<{ messages: ApiMessage[] }>("GET", `${at`/api/groups/${groupId}/messages`}?${query}`)).messages;
  };
  message = (groupId: string, id: string) => this.request<ApiMessage>("GET", at`/api/groups/${groupId}/messages/${id}`);
  /** A group admin deleting someone else's message, which is named: it's the server's to check their role. */
  moderateMessage = (groupId: string, id: string, epoch: number, deletion: Uint8Array) =>
    this.request<ApiMessage>("DELETE", at`/api/groups/${groupId}/messages/${id}`, { epoch, deletion });
  /** A group admin's app dropping a reaction that opens for nobody, by name, as it's the server's to check their role. */
  clearReaction = (groupId: string, messageId: string, id: string) =>
    this.request<ApiReactionChange>("DELETE", at`/api/groups/${groupId}/messages/${messageId}/reactions/${id}`);

  // What a member adds to a conversation, sealed: none of these says who's sending
  /** `silent` is for a message apps show nowhere, which no phone is woken for. */
  sealedSend = (groupId: string, seal: Seal, body: { id: string; envelope: Uint8Array; item_key: Uint8Array; files?: FileShare[]; expires_in?: number; silent?: boolean }) =>
    this.sealedRequest<ApiMessage>("POST", at`/api/sealed/groups/${groupId}/messages`, body, seal);
  sealedEdit = (groupId: string, id: string, seal: Seal, envelope: Uint8Array) =>
    this.sealedRequest<ApiMessage>("PUT", at`/api/sealed/groups/${groupId}/messages/${id}`, { envelope }, seal);
  /** An author deleting their own message, with its item key. */
  sealedDelete = (groupId: string, id: string, seal: Seal, deletion: Uint8Array) =>
    this.sealedRequest<ApiMessage>("DELETE", at`/api/sealed/groups/${groupId}/messages/${id}`, { deletion }, seal);
  sealedReact = (groupId: string, messageId: string, seal: Seal, body: { id: string; data: Uint8Array; item_key: Uint8Array }) =>
    this.sealedRequest<ApiReactionChange>("POST", at`/api/sealed/groups/${groupId}/messages/${messageId}/reactions`, body, seal);
  sealedUnreact = (groupId: string, messageId: string, id: string, seal: Seal) =>
    this.sealedRequest<ApiReactionChange>("DELETE", at`/api/sealed/groups/${groupId}/messages/${messageId}/reactions/${id}`, undefined, seal);
  sealedPin = (groupId: string, messageId: string, pinned: boolean, seal: Seal, pin: Uint8Array) =>
    this.sealedRequest<ApiPinChange>(pinned ? "PUT" : "DELETE", at`/api/sealed/groups/${groupId}/messages/${messageId}/pin`, { pin }, seal);
  /** Passed on to the group without being kept, or paid for. */
  sealedTyping = (groupId: string, seal: Seal, data: Uint8Array) => this.sealedRequest("POST", at`/api/sealed/groups/${groupId}/typing`, { data }, seal);
  pins = async (groupId: string) =>
    (await this.request<{ messages: ApiMessage[] }>("GET", at`/api/groups/${groupId}/pins`)).messages;

  // Files
  /** `shareHash` is the SHA-256 of the secret a file a message will carry is made with. A picture that stands on its own has none. */
  createFile = (chunkCount: number, totalSize: number, shareHash?: Uint8Array) =>
    this.request<{ id: string }>("POST", "/api/files", { chunk_count: chunkCount, total_size: totalSize, share_hash: shareHash });
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

  // The soundboard
  sounds = async () => (await this.request<{ sounds: ApiSound[] }>("GET", "/api/sounds")).sounds;
  createSound = (id: string, details: Uint8Array, fileId: string) => this.request<{ sound: ApiSound }>("POST", "/api/sounds", { id, details, file_id: fileId });
  updateSound = (id: string, details: Uint8Array) => this.request("PATCH", at`/api/sounds/${id}`, { details });
  deleteSound = (id: string) => this.request("DELETE", at`/api/sounds/${id}`);

  // Bots
  bots = async () => (await this.request<{ bots: ApiBot[] }>("GET", "/api/bots")).bots;
  createBot = (body: { username: string; listed: boolean; add: string; files: boolean }) => this.request<{ bot: ApiBot; code: string }>("POST", "/api/bots", body);
  updateBot = async (id: string, body: { listed?: boolean; add?: string; files?: boolean }) => (await this.request<{ bot: ApiBot }>("PATCH", at`/api/bots/${id}`, body)).bot;
  renewBotSetup = (id: string) => this.request<{ bot: ApiBot; code: string }>("POST", at`/api/bots/${id}/setup`, {});
  deleteBot = (id: string) => this.request("DELETE", at`/api/bots/${id}`);
  setBotChannels = async (id: string, channels: string[]) => (await this.request<{ bot: ApiBot }>("PUT", at`/api/bots/${id}/channels`, { channels })).bot;

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
  bans = () => this.request<{ bans: ApiBan[] }>("GET", "/api/admin/bans");
}

export interface LoginResponse {
  user_id: string;
  username: string;
  role: "owner" | "admin" | "member";
  token: string;
  vault_core: string;
  generation: number;
  slot: ApiSlot | null;
  head_link: ApiLink | null;
}

export const decode = (value: string | null | undefined): Uint8Array =>
  value ? fromBase64(value) : new Uint8Array(0);
