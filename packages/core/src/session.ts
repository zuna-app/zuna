// A live session with one server: everything between the UI and the network.
//
// The rule that keeps this reliable: all MLS operations on a group run one at a
// time under that group's lock, and commits are only applied in server order.
// Any device whose state can't be repaired by that simply rejoins the group
// with an external commit, so a bad state never ends a conversation.

import * as wasm from "@zuna/crypto";
import { Api, ApiError, decode, type ApiEvent, type ApiGroup, type ApiMessage, type ApiReaction, type ApiUser } from "./api";
import {
  changePassword,
  inviteLink,
  regenerateRecoveryKey,
  type AccountState,
} from "./account";
import {
  CONTENT_LABEL,
  openEnvelope,
  openHistoryGrant,
  openProfile,
  openSignal,
  openVaultItem,
  parseCertificate,
  randomId,
  reactionId,
  readSignedGroupDetails,
  safetyEmoji,
  sealEnvelope,
  sealHistoryGrant,
  sealProfile,
  sealSignal,
  sealVaultItem,
  signGroupDetails,
  signalEpoch,
  verifyCertificate,
  verifyHpkeKey,
} from "./crypto";
import { equalBytes, fromBase64, fromUtf8, toBase64, toBase64Url, u64Bytes, utf8 } from "./encoding";
import type { LocalDb, SqlValue } from "./db";
import { blobFiles, type FileAdapter } from "./files";
import { linkInText } from "./links";
import { notificationText, previewText } from "./notify";
import { indexTokens, queryTokens } from "./search";
import { Socket, decodeFrameData, type SocketFrame } from "./socket";
import {
  MAX_TEXT_LENGTH,
  parseEmoteRef,
  parseGroupDetails,
  parseMessageBody,
  parsePreferences,
  parseProfile,
  parseReaction,
  parseReadState,
  parseSystemEvent,
  type GroupDetails,
} from "./validate";
import type {
  Attachment,
  AvatarRef,
  ConnectionState,
  ConversationView,
  CoreEvent,
  DeviceView,
  Emote,
  EmoteRef,
  EmoteSet,
  GroupMemberView,
  GroupRole,
  Invite,
  MessageBody,
  MessageStatus,
  MessageView,
  Preferences,
  Profile,
  PushSettings,
  ReactionView,
  ReplyPreview,
  Role,
  SafetyCheck,
  SearchResult,
  ServerInfo,
  SystemEvent,
  TrustState,
  UserView,
} from "./types";
import { isMuted } from "./types";

const CHUNK_SIZE = 1 << 20;
const UPLOAD_CONCURRENCY = 3;
const KEY_PACKAGE_TARGET = 40;
const KEY_PACKAGE_LOW = 15;
const LAST_RESORT_MAX_AGE_MS = 21 * 24 * 3600 * 1000;
/** Keys rotate at least this often, which limits how long a stolen key stays useful. */
const EPOCH_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PAGE_SIZE = 50;
const TYPING_THROTTLE_MS = 3000;
const RECONCILE_JITTER_MS = 2500;
const MAX_COMMIT_ATTEMPTS = 6;
/** How long the messages of a chat you were removed from stay, unless you clear them first. */
const REMOVED_KEPT_MS = 30 * 24 * 3600 * 1000;
/** How often to check whether a session that seemed to end is really over, such as after a proxy's hiccup. */
const SIGNED_OUT_RETRY_MS = 5 * 60 * 1000;
const VAULT_BATCH = 200;
const DB_LABEL = (name: string) => utf8(`zuna/local/${name}`);

/** Values of `epoch_keys.uploaded`. A granted key waits until it has proved itself. */
const KEY_NOT_UPLOADED = 0;
const KEY_UPLOADED = 1;
const KEY_UNPROVEN = 2;

interface CachedDevice {
  id: string;
  signatureKey: Uint8Array;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

interface CachedUser {
  id: string;
  username: string;
  role: Role;
  identityKey: Uint8Array;
  hpkeKey: Uint8Array;
  profile: Profile;
  lastSeenAt: number | null;
  hidesLastSeen: boolean;
  banned: boolean;
  trust: TrustState;
  devices: Map<string, CachedDevice>;
}

type GroupMeta = GroupDetails;

interface CachedGroup {
  id: string;
  kind: "dm" | "group";
  peerId: string | null;
  epoch: number;
  seq: number;
  meta: GroupMeta;
  metaBlob: string | null;
  metaEpoch: number | null;
  /** The newest version of the group's signed details seen, so an older copy isn't taken for new. */
  metaVersion?: number;
  historyVisible: boolean;
  createdAt: number;
  members: GroupMemberView[];
  readStates: Record<string, string | null>;
  readBy: Record<string, number>;
  ownRead: number;
  /** When the server said this device's person is no longer in this conversation. */
  removedAt?: number | null;
  /** People the server says left, not yet shown, until MLS confirms their keys are gone. */
  pendingRemovals?: Record<string, { actor: string; seq: number; at: number }>;
}

/** One leaf of a group's MLS tree, and whether it really is the device it says. */
interface TreeMember {
  leaf: number;
  /** Who its certificate names, which proves nothing unless `genuine`. */
  userId: string;
  deviceId: string;
  /** Its certificate is signed by that person's identity key, for the signing key it really uses. */
  genuine: boolean;
}

interface MessageRow {
  row_id: number;
  group_id: string;
  id: string;
  seq: number | null;
  updated_seq: number;
  sender_user: string;
  sender_device: string;
  epoch: number;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  pinned_at: number | null;
  pinned_by: string | null;
  status: MessageStatus;
  body: Uint8Array | null;
  raw: Uint8Array | null;
}

interface StoredBody extends MessageBody {
  reactions?: ReactionView[];
  system?: SystemEvent;
  rawReactions?: ApiReaction[];
}

type OutboxEntry =
  | { kind: "message"; id: string; body: MessageBody; fileIds?: string[] }
  | { kind: "edit"; id: string; groupId: string; body: MessageBody };

type Mutex = Promise<unknown>;

const emptyProfile = (username: string): Profile => ({ displayName: username });

const MESSAGE_ID = /^[0-9a-f]{32}$/;

/** What the server says about a message, which has to at least have the right shape. */
const validApiMessage = (message: ApiMessage): boolean =>
  MESSAGE_ID.test(message?.id ?? "") &&
  Number.isSafeInteger(message.seq) &&
  Number.isSafeInteger(message.updated_seq) &&
  Number.isSafeInteger(message.epoch) &&
  Number.isSafeInteger(message.created_at) &&
  typeof message.sender_user === "string" &&
  typeof message.sender_device === "string" &&
  Array.isArray(message.reactions);

/** A message as this device stored it: what can be shown, or null if that's nothing. */
function readStoredBody(row: Pick<MessageRow, "id">, stored: StoredBody): StoredBody | null {
  const body: StoredBody | null = parseMessageBody(stored);
  if (!body) return null;
  // Only this device writes notices, and it gives them their own kind of ID.
  if (row.id.startsWith("sys-")) {
    const system = parseSystemEvent(stored.system);
    if (system) body.system = system;
  }
  if (Array.isArray(stored.reactions)) {
    body.reactions = stored.reactions.flatMap((item) => {
      const reaction = parseReaction(item);
      return reaction && Array.isArray(item.userIds) ? [{ ...reaction, userIds: item.userIds.filter((id) => typeof id === "string") }] : [];
    });
  }
  return body;
}

function assertSendable(body: MessageBody): void {
  if ((body.text?.length ?? 0) > MAX_TEXT_LENGTH) throw new Error("That message is too long. Try sending it as a file.");
}

export class ServerSession {
  readonly api: Api;
  private mls: wasm.MlsClient;
  private users = new Map<string, CachedUser>();
  private groups = new Map<string, CachedGroup>();
  private online = new Set<string>();
  private prefs: Preferences = { pinned: [], hidden: [], muted: [], sendReadReceipts: true };
  /** Whether the person is using this device, and another of theirs, as the server last said. */
  private active = false;
  private activeElsewhere = false;
  /** What the app asked for notifications: where to push, "off" to stop them, or null if it never said. */
  private push: PushSettings | "off" | null = null;
  private deviceNames = new Map<string, string>();
  private locks = new Map<string, Mutex>();
  private epochKeys = new Map<string, Uint8Array>();
  /** Messages that arrived live before their keys did, notified once they open. */
  private awaitingKeys = new Set<string>();
  private syncing = new Map<string, { again: boolean; done: Promise<void> }>();
  private socket: Socket;
  private connection: ConnectionState = "connecting";
  private info: ServerInfo | null = null;
  private emoteSet: EmoteSet = { set_id: "", set_name: "", emotes: [] };
  private searchKey: Uint8Array;
  private usersCursor = 0;
  private lastTypingSent = new Map<string, number>();
  private flushing: Promise<void> | null = null;
  private flushRetry: ReturnType<typeof setTimeout> | undefined;
  /** Updates the conversations when the next chat muted for a while is heard again. */
  private muteTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  /** Why the server says this session is over, if it has. */
  private signedOutReason: string | null = null;
  private signedOutRetry: ReturnType<typeof setTimeout> | undefined;
  /** The epoch each group's key was last checked against MLS at. */
  private confirmedEpochs = new Map<string, number>();
  /** The epoch each group's tree was last found clean at, so sending needn't check it every time. */
  private cleanEpochs = new Map<string, number>();
  /** Who holds each group's keys now, for showing its members. */
  private treeUsersCache = new Map<string, Set<string>>();
  /** Leaves already warned about, so one ghost makes one warning. */
  private warnedLeaves = new Set<string>();
  private resealing = new Set<string>();
  /** Called when the server told us this session is over (banned, revoked). */
  onSignedOut: ((reason: string) => void) | null = null;
  /** Called when a session that seemed to be over turns out to be working. */
  onSignedIn: (() => void) | null = null;

  constructor(
    readonly serverId: string,
    private account: AccountState,
    private readonly db: LocalDb,
    private readonly dbKey: Uint8Array,
    private readonly emit: (event: CoreEvent) => void,
    private readonly deviceName: string,
    private readonly files: FileAdapter = blobFiles,
  ) {
    this.api = new Api(account.serverUrl);
    this.api.token = account.token;
    this.searchKey = wasm.hkdfSha256(dbKey, new Uint8Array(0), utf8("zuna/local/search"), 32);

    const state = this.db.all<{ k: Uint8Array; v: Uint8Array }>("SELECT k, v FROM mls_kv");
    this.mls = new wasm.MlsClient(
      account.devicePublic,
      account.deviceSecret,
      account.certificate,
      state.map((row) => [row.k, this.openLocal("mls", row.v)]) as unknown as any[],
    );
    this.socket = new Socket(account.serverUrl, () => this.account.token, {
      onReady: () => void this.onConnected(),
      onFrame: (frame) => this.onFrame(frame),
      onDisconnect: () => {
        this.setConnection("offline");
        // Unknown until the server says again; better to notify than to miss something.
        if (this.activeElsewhere) {
          this.activeElsewhere = false;
          this.emit({ type: "activity", serverId: this.serverId, elsewhere: false });
        }
      },
      onUnauthorized: () => this.signedOut("session_ended"),
    });
    this.loadCache();
  }

  // --- Lifecycle ---

  start(): void {
    this.markStaleSendsFailed();
    this.forgetOldRemovedGroups();
    this.connect();
  }

  private connect(): void {
    this.stopped = false;
    this.setConnection("connecting");
    this.socket.start();
  }

  stop(): void {
    this.stopped = true;
    this.socket.stop();
    clearTimeout(this.flushRetry);
    clearTimeout(this.muteTimer);
    clearTimeout(this.signedOutRetry);
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
    this.reconcileTimers.clear();
  }

  /**
   * Closes the connection while the app can't run, such as an iOS app in the
   * background. Unlike `stop()`, `resume()` picks up again, catching up on
   * whatever happened meanwhile.
   */
  suspend(): void {
    if (this.stopped) return;
    this.stop();
    // Closing the socket ourselves doesn't report a disconnect, so say it here.
    this.setConnection("offline");
  }

  resume(): void {
    if (this.stopped) this.connect();
  }

  /** Called on first run after sign-up or sign-in, before going online. */
  async prepareNewDevice(): Promise<void> {
    await this.topUpKeyPackages();
    await this.saveDeviceName();
  }

  nudge(): void {
    this.socket.nudge();
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit({ type: "connection", serverId: this.serverId, state });
  }

  get connectionState(): ConnectionState {
    return this.connection;
  }

  getConnectionState(): ConnectionState {
    return this.connection;
  }

  /**
   * The server says this session is over. That alone is no reason to erase
   * anything: a hacked server or a confused proxy can say it too. What's here
   * stays until the person signs in again or clears it. A session that merely
   * stopped working is tried again now and then, in case it wasn't really over.
   */
  private signedOut(reason: string): void {
    this.stop();
    this.setConnection("offline");
    if (this.signedOutReason !== reason) {
      this.signedOutReason = reason;
      this.emit({ type: "signed_out", serverId: this.serverId, reason });
      this.onSignedOut?.(reason);
    }
    if (reason === "session_ended") {
      this.signedOutRetry = setTimeout(() => this.connect(), SIGNED_OUT_RETRY_MS);
    }
  }

  private async onConnected(): Promise<void> {
    if (this.signedOutReason) {
      this.signedOutReason = null;
      this.emit({ type: "signed_in", serverId: this.serverId });
      this.onSignedIn?.();
    }
    this.setConnection("syncing");
    try {
      await this.syncAll();
      if (this.socket.connected) this.setConnection("online");
      // The server may have dropped it, or missed a change made offline.
      this.resendPush();
    } catch (error) {
      console.warn("[zuna] sync failed", error);
      if (error instanceof ApiError && error.status === 401) {
        this.signedOut("session_ended");
      } else if (this.socket.connected) {
        // Stay usable: what failed will be retried by the next event or reconnect.
        this.setConnection("online");
      }
    }
  }

  private async syncAll(): Promise<void> {
    this.info = await this.api.info();
    this.emit({ type: "settings", serverId: this.serverId, info: this.info });
    await this.syncUsers();
    await this.syncVault();
    await this.refreshEmotes();
    await this.processWelcomes();
    // A group that arrives while the list is on its way won't be in it, so only
    // groups we already knew about can have been taken away.
    const known = [...this.groups.keys()];
    const groups = await this.api.groups();
    const seen = new Set(groups.map((group) => group.id));
    for (const group of groups) this.applyGroup(group);
    for (const id of known) {
      if (!seen.has(id)) this.markRemoved(id);
    }
    this.emitConversations();
    for (const group of groups) await this.syncGroup(group.id);
    // After joining, since a grant is only good for epochs before this device came in.
    await this.processHistoryGrants();
    await this.topUpKeyPackages();
    await this.uploadEpochKeys();
    void this.flushOutbox();
  }

  // --- Sealing data at rest ---

  private sealLocal(name: string, data: Uint8Array): Uint8Array {
    return wasm.aeadSeal(this.dbKey, data, DB_LABEL(name));
  }

  private openLocal(name: string, data: Uint8Array): Uint8Array {
    return wasm.aeadOpen(this.dbKey, data, DB_LABEL(name));
  }

  private sealJson(name: string, value: unknown): Uint8Array {
    return this.sealLocal(name, utf8(JSON.stringify(value)));
  }

  private openJson<T>(name: string, data: Uint8Array): T {
    return JSON.parse(fromUtf8(this.openLocal(name, data)));
  }

  private setKv(key: string, value: unknown): void {
    this.db.run("INSERT OR REPLACE INTO kv(k, v) VALUES(?, ?)", [key, this.sealJson(`kv/${key}`, value)]);
  }

  private getKv<T>(key: string): T | null {
    const row = this.db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", [key]);
    return row ? this.openJson<T>(`kv/${key}`, row.v) : null;
  }

  private saveMls(): void {
    const changes = this.mls.takeChanges() as { set: [Uint8Array, Uint8Array][]; deleted: Uint8Array[] };
    if (changes.set.length === 0 && changes.deleted.length === 0) return;
    this.db.transaction(() => {
      for (const [key, value] of changes.set) {
        this.db.run("INSERT OR REPLACE INTO mls_kv(k, v) VALUES(?, ?)", [key, this.sealLocal("mls", value)]);
      }
      for (const key of changes.deleted) this.db.run("DELETE FROM mls_kv WHERE k = ?", [key]);
    });
  }

  private loadCache(): void {
    for (const row of this.db.all<{ data: Uint8Array }>("SELECT data FROM users")) {
      const stored = this.openJson<any>("user", row.data);
      this.users.set(stored.id, {
        ...stored,
        identityKey: fromBase64(stored.identityKey),
        hpkeKey: fromBase64(stored.hpkeKey),
        devices: new Map(
          stored.devices.map((device: any) => [device.id, { ...device, signatureKey: fromBase64(device.signatureKey) }]),
        ),
      });
    }
    for (const row of this.db.all<{ data: Uint8Array }>("SELECT data FROM groups")) {
      const group = this.openJson<CachedGroup>("group", row.data);
      this.groups.set(group.id, group);
    }
    this.prefs = { ...this.prefs, ...(this.getKv<Preferences>("prefs") ?? {}) };
    this.watchMutes();
    const push = this.getKv<(Omit<PushSettings, "key"> & { key: string }) | "off">("push");
    this.push = push && push !== "off" ? { ...push, key: fromBase64(push.key) } : push;
    this.usersCursor = this.getKv<number>("users_cursor") ?? 0;
    this.info = this.getKv<ServerInfo>("info");
    this.emoteSet = this.getKv<EmoteSet>("emotes") ?? this.emoteSet;
    const names = this.getKv<Record<string, string>>("device_names") ?? {};
    for (const [id, name] of Object.entries(names)) this.deviceNames.set(id, name);
  }

  private persistUser(user: CachedUser): void {
    const stored = {
      ...user,
      identityKey: toBase64(user.identityKey),
      hpkeKey: toBase64(user.hpkeKey),
      devices: [...user.devices.values()].map((device) => ({ ...device, signatureKey: toBase64(device.signatureKey) })),
    };
    this.db.run("INSERT OR REPLACE INTO users(id, data) VALUES(?, ?)", [user.id, this.sealJson("user", stored)]);
  }

  private persistGroup(group: CachedGroup): void {
    this.db.run(
      `INSERT INTO groups(id, kind, peer_id, data) VALUES(?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, peer_id = excluded.peer_id, data = excluded.data`,
      [group.id, group.kind, group.peerId, this.sealJson("group", group)],
    );
  }

  // --- Locks ---

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  // --- Users ---

  private async syncUsers(): Promise<void> {
    const response = await this.api.users(this.usersCursor);
    this.online = new Set(response.online);
    for (const user of response.users) this.applyUser(user);
    this.usersCursor = response.now - 5000;
    this.setKv("users_cursor", this.usersCursor);
    this.emit({ type: "users", serverId: this.serverId });
  }

  private pinnedIdentity(userId: string): Uint8Array | null {
    const row = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM pinned_identities WHERE user_id = ?", [userId]);
    return row?.identity_key ?? null;
  }

  private trustOf(userId: string, current: Uint8Array): TrustState {
    const pinned = this.pinnedIdentity(userId);
    if (pinned && !equalBytes(pinned, current)) return "changed";
    const verified = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM verified WHERE user_id = ?", [userId]);
    return verified && equalBytes(verified.identity_key, current) ? "verified" : "unverified";
  }

  /**
   * Trust on first use: the first identity key seen for a user is pinned. Zuna
   * accounts keep one identity key for life, so a later change means the server
   * is lying or the account was replaced. That gets a loud warning.
   */
  private applyUser(api: ApiUser): CachedUser {
    const identityKey = decode(api.identity_key);
    const pinned = this.pinnedIdentity(api.id);
    const isSelf = api.id === this.account.userId;
    if (!pinned) {
      this.db.run("INSERT INTO pinned_identities(user_id, identity_key) VALUES(?, ?)", [api.id, identityKey]);
    }
    const previous = this.users.get(api.id);
    const changedNow = !!pinned && !equalBytes(pinned, identityKey) && previous?.trust !== "changed";
    const trustedKey = pinned ?? identityKey;

    const devices = new Map<string, CachedDevice>();
    for (const device of api.devices) {
      const cert = verifyCertificate(trustedKey, decode(device.certificate));
      if (!cert || cert.userId !== api.id || cert.deviceId !== device.id) continue;
      devices.set(device.id, {
        id: device.id,
        signatureKey: cert.signatureKey,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        revoked: (device as { revoked_at?: number | null }).revoked_at != null,
      });
    }

    if (isSelf && previous) {
      for (const device of devices.values()) {
        if (!previous.devices.has(device.id) && device.id !== this.account.deviceId) {
          this.emit({
            type: "security",
            serverId: this.serverId,
            userId: api.id,
            message: "A new device just signed in to your account. If this wasn't you, change your password and remove that device in Settings.",
          });
        }
      }
    }

    const opened = api.profile
      ? parseProfile(openProfile<unknown>(this.account.core.communityKey, trustedKey, api.username, decode(api.profile)))
      : null;
    const user: CachedUser = {
      id: api.id,
      username: api.username,
      role: api.role,
      identityKey,
      hpkeKey: decode(api.hpke_key),
      profile: opened ?? previous?.profile ?? emptyProfile(api.username),
      lastSeenAt: api.last_seen_at,
      hidesLastSeen: api.hide_last_seen,
      banned: api.banned,
      trust: this.trustOf(api.id, identityKey),
      devices,
    };
    this.users.set(api.id, user);
    this.persistUser(user);
    if (isSelf && user.role !== this.account.role) {
      this.account = { ...this.account, role: user.role };
    }
    if (changedNow) {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: api.id,
        message: `The security key of ${user.profile.displayName} changed. Their messages can't be trusted until you verify them again.`,
      });
      const dm = this.dmWith(api.id);
      if (dm) this.addSystemRow(dm.id, Date.now(), api.id, { type: "identity_changed", actorId: api.id, targetIds: [api.id] });
    }
    return user;
  }

  private async ensureUser(userId: string, refresh = false): Promise<CachedUser | null> {
    if (!refresh) {
      const cached = this.users.get(userId);
      if (cached) return cached;
    }
    try {
      return this.applyUser(await this.api.user(userId));
    } catch {
      return this.users.get(userId) ?? null;
    }
  }

  private toUserView(user: CachedUser): UserView {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.profile.displayName || user.username,
      bio: user.profile.bio ?? "",
      avatar: user.profile.avatar ?? null,
      online: this.online.has(user.id),
      lastSeenAt: user.lastSeenAt,
      hidesLastSeen: user.hidesLastSeen,
      banned: user.banned,
      trust: user.trust,
      isSelf: user.id === this.account.userId,
    };
  }

  getUsers(): UserView[] {
    return [...this.users.values()].map((user) => this.toUserView(user));
  }

  getSelf(): { userId: string; username: string; role: Role; deviceId: string } {
    return {
      userId: this.account.userId,
      username: this.account.username,
      role: this.users.get(this.account.userId)?.role ?? this.account.role,
      deviceId: this.account.deviceId,
    };
  }

  getInfo(): ServerInfo | null {
    return this.info;
  }

  // --- Vault ---

  private async syncVault(): Promise<void> {
    let cursor = this.getKv<number>("vault_cursor") ?? 0;
    const touchedGroups = new Set<string>();
    for (;;) {
      const items = await this.api.vaultItems(cursor);
      if (items.length === 0) break;
      for (const item of items) {
        cursor = Math.max(cursor, item.seq);
        let data: Uint8Array;
        try {
          data = openVaultItem(this.account.accountKey, item.id, decode(item.data));
        } catch {
          console.warn("[zuna] a vault item could not be opened", item.id);
          continue;
        }
        if (item.id.startsWith("ek:")) {
          const [, groupId, epoch] = item.id.split(":");
          if (Number.isSafeInteger(Number(epoch)) && data.length === 32) {
            this.saveEpochKey(groupId!, Number(epoch), data, "vault");
            touchedGroups.add(groupId!);
          }
        } else if (item.id === "prefs") {
          try {
            this.prefs = { ...this.prefs, ...parsePreferences(JSON.parse(fromUtf8(data))) };
          } catch {
            console.warn("[zuna] saved preferences could not be read");
            continue;
          }
          this.setKv("prefs", this.prefs);
          this.emit({ type: "preferences", serverId: this.serverId });
          this.watchMutes();
          this.resendPush();
        } else if (item.id.startsWith("verified:")) {
          const userId = item.id.slice("verified:".length);
          this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, data]);
          const user = this.users.get(userId);
          if (user) {
            user.trust = this.trustOf(userId, user.identityKey);
            this.persistUser(user);
          }
        } else if (item.id.startsWith("device:")) {
          this.deviceNames.set(item.id.slice("device:".length), fromUtf8(data));
          this.setKv("device_names", Object.fromEntries(this.deviceNames));
        }
      }
      this.setKv("vault_cursor", cursor);
    }
    for (const groupId of touchedGroups) this.retryUndecryptable(groupId);
  }

  private async putVault(id: string, data: Uint8Array): Promise<void> {
    await this.api.putVaultItems([{ id, data: sealVaultItem(this.account.accountKey, id, data) }]);
  }

  private async saveDeviceName(): Promise<void> {
    this.deviceNames.set(this.account.deviceId, this.deviceName);
    this.setKv("device_names", Object.fromEntries(this.deviceNames));
    await this.putVault(`device:${this.account.deviceId}`, utf8(this.deviceName)).catch(() => undefined);
  }

  private async uploadEpochKeys(): Promise<void> {
    const rows = this.db.all<{ group_id: string; epoch: number; key: Uint8Array }>(
      "SELECT group_id, epoch, key FROM epoch_keys WHERE uploaded = ? LIMIT ?",
      [KEY_NOT_UPLOADED, VAULT_BATCH],
    );
    if (rows.length === 0) return;
    const items = rows.map((row) => {
      const id = `ek:${row.group_id}:${row.epoch}`;
      return { id, data: sealVaultItem(this.account.accountKey, id, this.openLocal("epoch", row.key)) };
    });
    await this.api.putVaultItems(items);
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run("UPDATE epoch_keys SET uploaded = ? WHERE group_id = ? AND epoch = ?", [KEY_UPLOADED, row.group_id, row.epoch]);
      }
    });
  }

  /**
   * Keys for older messages, from an admin adding this person with history. They
   * only ever fill in epochs from before this device came into the group: for
   * later ones, the only key that counts is the one MLS gives (see
   * rememberCurrentEpochKey).
   */
  private async processHistoryGrants(): Promise<void> {
    const grants = await this.api.historyGrants();
    for (const grant of grants) {
      const joined = this.joinedEpoch(grant.group_id);
      // Kept until this device is in the group and can tell what it may fill in.
      if (joined === null) continue;
      try {
        const opened = openHistoryGrant(this.account.core.hpkeSecret, grant.group_id, this.account.userId, decode(grant.data));
        if (await this.grantAuthentic(grant.group_id, opened)) {
          for (const [epoch, key] of Object.entries(opened.keys)) {
            const number = Number(epoch);
            if (!Number.isSafeInteger(number) || number < 0 || number >= joined || typeof key !== "string") continue;
            const bytes = fromBase64(key);
            if (bytes.length === 32) this.saveEpochKey(grant.group_id, number, bytes, "grant");
          }
          this.retryUndecryptable(grant.group_id);
        } else {
          this.emit({
            type: "security",
            serverId: this.serverId,
            userId: opened.signer.userId,
            message: "Keys for a conversation's history weren't signed by one of its admins, so they were ignored.",
          });
        }
      } catch (error) {
        console.warn("[zuna] a history grant could not be opened", error);
      }
      await this.api.deleteHistoryGrant(grant.id);
    }
    if (grants.length > 0) await this.uploadEpochKeys();
  }

  private async grantAuthentic(groupId: string, grant: ReturnType<typeof openHistoryGrant>): Promise<boolean> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    if (group.members.find((member) => member.user_id === grant.signer.userId)?.role !== "admin") return false;
    const device = (await this.ensureUser(grant.signer.userId, true))?.devices.get(grant.signer.deviceId);
    return !!device && grant.signedBy(device.signatureKey);
  }

  // --- Epoch keys ---

  private epochCacheKey(groupId: string, epoch: number): string {
    return `${groupId}:${epoch}`;
  }

  /**
   * Stores an epoch's key. What MLS itself gives is always right. A key from this
   * account's vault or from a grant only fills a gap, and a granted one isn't
   * passed on to the vault until it has opened a properly signed message.
   */
  private saveEpochKey(groupId: string, epoch: number, key: Uint8Array, source: "mls" | "vault" | "grant"): void {
    if (source === "mls") {
      this.epochKeys.set(this.epochCacheKey(groupId, epoch), key);
      this.db.run(
        `INSERT OR REPLACE INTO epoch_keys(group_id, epoch, key, uploaded, created_at) VALUES(?, ?, ?, ?, ?)`,
        [groupId, epoch, this.sealLocal("epoch", key), KEY_NOT_UPLOADED, Date.now()],
      );
      return;
    }
    this.db.run(
      `INSERT OR IGNORE INTO epoch_keys(group_id, epoch, key, uploaded, created_at) VALUES(?, ?, ?, ?, ?)`,
      [groupId, epoch, this.sealLocal("epoch", key), source === "vault" ? KEY_UPLOADED : KEY_UNPROVEN, Date.now()],
    );
  }

  /** A granted key opened a properly signed message, so it's real enough to keep for other devices. */
  private keyProvedItself(groupId: string, epoch: number): void {
    this.db.run("UPDATE epoch_keys SET uploaded = ? WHERE group_id = ? AND epoch = ? AND uploaded = ?", [KEY_NOT_UPLOADED, groupId, epoch, KEY_UNPROVEN]);
  }

  private joinedEpoch(groupId: string): number | null {
    return this.db.get<{ epoch: number }>("SELECT epoch FROM joined_epochs WHERE group_id = ?", [groupId])?.epoch ?? null;
  }

  private setJoinedEpoch(groupId: string, epoch: number): void {
    this.db.run("INSERT OR REPLACE INTO joined_epochs(group_id, epoch) VALUES(?, ?)", [groupId, epoch]);
  }

  private epochKey(groupId: string, epoch: number): Uint8Array | null {
    const cacheKey = this.epochCacheKey(groupId, epoch);
    const cached = this.epochKeys.get(cacheKey);
    if (cached) return cached;
    const row = this.db.get<{ key: Uint8Array }>("SELECT key FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, epoch]);
    if (!row) return null;
    const key = this.openLocal("epoch", row.key);
    this.epochKeys.set(cacheKey, key);
    return key;
  }

  /**
   * Makes sure the key held for the current epoch is the one MLS gives. Nothing
   * is ever encrypted under a key from anywhere else, so a key someone planted
   * in advance is found out as soon as its epoch arrives, instead of being used.
   */
  private rememberCurrentEpochKey(groupId: string): number {
    const groupBytes = utf8(groupId);
    const epoch = this.mls.epoch(groupBytes);
    if (this.confirmedEpochs.get(groupId) === epoch) return epoch;
    const real = this.mls.exportSecret(groupBytes, CONTENT_LABEL, u64Bytes(epoch), 32);
    const stored = this.epochKey(groupId, epoch);
    if (!stored || !equalBytes(stored, real)) {
      this.saveEpochKey(groupId, epoch, real, "mls");
      if (stored) {
        this.emit({
          type: "security",
          serverId: this.serverId,
          userId: "",
          message: "A wrong key had been planted for one of your conversations. It was replaced with the real one.",
        });
      }
    }
    this.confirmedEpochs.set(groupId, epoch);
    return epoch;
  }

  private allEpochKeys(groupId: string): Record<number, string> {
    const rows = this.db.all<{ epoch: number; key: Uint8Array }>("SELECT epoch, key FROM epoch_keys WHERE group_id = ?", [groupId]);
    return Object.fromEntries(rows.map((row) => [row.epoch, toBase64(this.openLocal("epoch", row.key))]));
  }

  // --- Key packages ---

  private async topUpKeyPackages(): Promise<void> {
    const status = await this.api.keyPackageStatus();
    const needOneTime = status.count < KEY_PACKAGE_LOW ? KEY_PACKAGE_TARGET - status.count : 0;
    const lastResortStale = Date.now() - status.last_resort_at > LAST_RESORT_MAX_AGE_MS;
    if (needOneTime === 0 && !lastResortStale) return;
    const packages: Uint8Array[] = [];
    for (let i = 0; i < needOneTime; i++) packages.push(this.mls.generateKeyPackage(false));
    const lastResort = lastResortStale ? this.mls.generateKeyPackage(true) : undefined;
    this.saveMls();
    await this.api.addKeyPackages(packages, lastResort);
  }

  /** Claims key packages for a user's devices, keeping only ones their identity key vouches for. */
  private async claimKeyPackages(userId: string, exceptDevice?: string): Promise<{ deviceId: string; data: Uint8Array }[]> {
    const user = await this.ensureUser(userId, true);
    if (!user) return [];
    const pinned = this.pinnedIdentity(userId) ?? user.identityKey;
    const claimed = await this.api.claimKeyPackages(userId);
    const valid: { deviceId: string; data: Uint8Array }[] = [];
    for (const item of claimed) {
      if (item.device_id === exceptDevice) continue;
      const data = decode(item.data);
      let credential: Uint8Array;
      try {
        credential = this.mls.keyPackageCredential(data);
      } catch {
        continue;
      }
      // Certificates are public, so one in a package proves nothing unless the
      // package really signs with the key that certificate names.
      const cert = verifyCertificate(pinned, credential);
      const known = user.devices.get(item.device_id);
      const genuine =
        !!cert &&
        cert.userId === userId &&
        cert.deviceId === item.device_id &&
        !!known &&
        !known.revoked &&
        equalBytes(this.mls.keyPackageSignatureKey(data), cert.signatureKey);
      if (!genuine) {
        this.emit({
          type: "security",
          serverId: this.serverId,
          userId,
          message: `The server offered a device for ${user.profile.displayName} that isn't really theirs. It was not added.`,
        });
        continue;
      }
      valid.push({ deviceId: item.device_id, data });
    }
    return valid;
  }

  // --- Groups: state ---

  private dmWith(userId: string): CachedGroup | undefined {
    for (const group of this.groups.values()) {
      if (group.kind === "dm" && group.peerId === userId) return group;
    }
    return undefined;
  }

  private applyGroup(api: ApiGroup): CachedGroup {
    const previous = this.groups.get(api.id);
    const selfId = this.account.userId;
    const peerId =
      api.kind === "dm" ? api.members.find((member) => member.user_id !== selfId)?.user_id ?? previous?.peerId ?? selfId : null;
    const group: CachedGroup = {
      id: api.id,
      kind: api.kind,
      peerId,
      epoch: api.epoch,
      seq: api.seq,
      meta: previous?.meta ?? {},
      metaBlob: api.meta,
      metaEpoch: api.meta_epoch,
      metaVersion: previous?.metaVersion ?? 0,
      historyVisible: api.history_visible,
      createdAt: api.created_at,
      members: api.members.map((member) => ({ userId: member.user_id, role: member.role, joinedAt: member.joined_at })),
      readStates: Object.fromEntries(api.members.map((member) => [member.user_id, member.read_state])),
      readBy: previous?.readBy ?? {},
      ownRead: previous?.ownRead ?? 0,
      // The server listing us as a member means we're in it after all.
      removedAt: null,
      pendingRemovals: previous?.pendingRemovals,
    };
    this.groups.set(api.id, group);
    this.refreshGroupSecrets(group);
    this.persistGroup(group);
    return group;
  }

  private isGroupAdmin(group: CachedGroup, userId: string): boolean {
    return group.members.find((member) => member.userId === userId)?.role === "admin";
  }

  /** Decrypts whatever group metadata and read positions the keys held allow. */
  private refreshGroupSecrets(group: CachedGroup): void {
    if (group.metaBlob && group.metaEpoch !== null) {
      const key = this.epochKey(group.id, group.metaEpoch);
      if (key) this.acceptGroupDetails(group, openSignal<unknown>(key, "meta", group.id, fromBase64(group.metaBlob)));
    }
    for (const [userId, state] of Object.entries(group.readStates)) {
      if (state) this.applyReadState(group, userId, fromBase64(state));
    }
  }

  /**
   * Takes on a group's details if an admin's device signed them and they aren't
   * older than what's held. Anyone with an epoch key could write some, and the
   * server could serve old ones. Unsigned details, from before these were signed,
   * count only until signed ones are seen, and an admin's app replaces them.
   */
  private acceptGroupDetails(group: CachedGroup, opened: unknown): void {
    if (opened === null) return;
    const signed = readSignedGroupDetails(group.id, opened);
    if (!signed) {
      const legacy = parseGroupDetails(opened);
      if (legacy && !group.metaVersion) group.meta = legacy;
      this.resealIfAdmin(group);
      return;
    }
    if (signed.version < (group.metaVersion ?? 0)) return;
    const device = this.users.get(signed.signer.userId)?.devices.get(signed.signer.deviceId);
    if (!device) {
      // Not known yet. Looked up, and read again once that's done.
      void this.ensureUser(signed.signer.userId, true)
        .then((user) => {
          if (user?.devices.has(signed.signer.deviceId) && this.groups.get(group.id) === group) {
            this.refreshGroupSecrets(group);
            this.persistGroup(group);
            this.emitConversations();
          }
        })
        .catch(() => undefined);
      return;
    }
    const details = parseGroupDetails(signed.details);
    if (!details || !this.isGroupAdmin(group, signed.signer.userId) || !signed.signedBy(device.signatureKey)) {
      this.resealIfAdmin(group);
      return;
    }
    group.meta = details;
    group.metaVersion = signed.version;
  }

  private resealIfAdmin(group: CachedGroup): void {
    if (group.kind === "group" && !group.removedAt && this.isGroupAdmin(group, this.account.userId) && this.hasMlsGroup(group.id)) {
      setTimeout(() => this.resealMeta(group.id), 0);
    }
  }

  /** Seals a group's details for an epoch, signed by this device. */
  private sealGroupDetails(groupId: string, key: Uint8Array, epoch: number, meta: GroupMeta, version: number): Uint8Array {
    const signer = { userId: this.account.userId, deviceId: this.account.deviceId };
    return sealSignal(key, "meta", groupId, epoch, signGroupDetails(groupId, meta, version, signer, this.account.deviceSecret));
  }

  /**
   * A member who joined without a Welcome can't open metadata sealed for an
   * older epoch, so an admin seals it again to keep the group's name visible.
   */
  private resealMeta(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || Object.keys(group.meta).length === 0 || group.removedAt) return;
    if (!this.isGroupAdmin(group, this.account.userId) || !this.hasMlsGroup(groupId) || this.resealing.has(groupId)) return;
    const epoch = this.rememberCurrentEpochKey(groupId);
    const version = Math.max(group.metaVersion ?? 0, 1);
    group.metaVersion = version;
    this.persistGroup(group);
    const sealed = this.sealGroupDetails(groupId, this.epochKey(groupId, epoch)!, epoch, group.meta, version);
    this.resealing.add(groupId);
    void this.api
      .setGroupMeta(groupId, sealed, epoch)
      .catch((error) => console.warn("[zuna] resealing group details", error))
      .finally(() => this.resealing.delete(groupId));
  }

  private applyReadState(group: CachedGroup, userId: string, sealed: Uint8Array): void {
    if (sealed.length < 5) return;
    const accountSealed = sealed[0] === 1;
    const body = sealed.subarray(1);
    const key = accountSealed ? this.account.accountKey : this.epochKey(group.id, signalEpoch(body));
    if (!key) return;
    const seq = parseReadState(openSignal<unknown>(key, "read", group.id, body));
    if (seq === null) return;
    if (userId === this.account.userId) {
      group.ownRead = Math.max(group.ownRead, seq);
    } else {
      group.readBy[userId] = Math.max(group.readBy[userId] ?? 0, seq);
    }
  }

  /**
   * The server says this person is no longer in a conversation. This device stops
   * taking part, but keeps what it has: the server's word is no reason to erase
   * anything, and it may turn out to be wrong. It goes when the person clears it,
   * or after a while.
   */
  private markRemoved(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.removedAt) return;
    group.removedAt = Date.now();
    this.persistGroup(group);
    this.forgetMlsState(groupId);
    this.emitConversations();
  }

  private forgetMlsState(groupId: string): void {
    this.confirmedEpochs.delete(groupId);
    this.cleanEpochs.delete(groupId);
    this.treeUsersCache.delete(groupId);
    const timer = this.reconcileTimers.get(groupId);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(groupId);
    try {
      this.mls.deleteGroup(utf8(groupId));
      this.saveMls();
    } catch (error) {
      console.warn("[zuna] removing group state", error);
    }
  }

  /** Erases a conversation from this device, because the person asked. */
  private removeGroupLocally(groupId: string): void {
    this.groups.delete(groupId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM search WHERE rowid IN (SELECT row_id FROM messages WHERE group_id = ?)", [groupId]);
      this.db.run("DELETE FROM messages WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM groups WHERE id = ?", [groupId]);
      this.db.run("DELETE FROM epoch_keys WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM joined_epochs WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM epoch_starts WHERE group_id = ?", [groupId]);
      this.db.run("DELETE FROM device_departures WHERE group_id = ?", [groupId]);
    });
    this.forgetMlsState(groupId);
    this.emitConversations();
  }

  /** Clears a conversation this person was removed from, from this device. */
  forgetConversation(groupId: string): void {
    if (this.groups.get(groupId)?.removedAt) this.removeGroupLocally(groupId);
  }

  private forgetOldRemovedGroups(): void {
    for (const group of [...this.groups.values()]) {
      if (group.removedAt && Date.now() - group.removedAt > REMOVED_KEPT_MS) this.removeGroupLocally(group.id);
    }
  }

  private emitConversations(): void {
    this.emit({ type: "conversations", serverId: this.serverId });
  }

  private hasMlsGroup(groupId: string): boolean {
    return this.mls.hasGroup(utf8(groupId));
  }

  private mlsEpoch(groupId: string): number {
    return this.mls.epoch(utf8(groupId));
  }

  // --- Groups: joining ---

  private async processWelcomes(): Promise<void> {
    const welcomes = await this.api.welcomes();
    const joined: string[] = [];
    for (const welcome of welcomes) {
      await this.withLock(welcome.group_id, async () => {
        if (await this.consumeWelcome(welcome)) joined.push(welcome.group_id);
      });
    }
    for (const groupId of joined) {
      this.applyGroup(await this.api.group(groupId));
      await this.withLock(groupId, async () => this.afterJoining(groupId));
      this.retryUndecryptable(groupId);
      this.backgroundSync(groupId);
    }
    if (joined.length > 0) {
      this.emitConversations();
      await this.uploadEpochKeys();
    }
  }

  /** Uses welcomes for one group. The caller must already hold that group's lock. */
  private async processWelcomesFor(groupId: string): Promise<void> {
    const welcomes = await this.api.welcomes();
    let joined = false;
    for (const welcome of welcomes) {
      if (welcome.group_id === groupId && (await this.consumeWelcome(welcome))) joined = true;
    }
    if (joined) {
      await this.afterJoining(groupId);
      this.retryUndecryptable(groupId);
      void this.uploadEpochKeys().catch(() => undefined);
    }
  }

  /** Whoever else is in a group just joined by Welcome is checked before trusting it. */
  private async afterJoining(groupId: string): Promise<void> {
    await this.checkTree(groupId);
    this.setKnownMembers(groupId, this.treeUsers(groupId));
    this.scheduleReconcile(groupId);
  }

  /** Joins from a welcome and removes it. Returns whether this device joined. */
  private async consumeWelcome(welcome: { id: number; group_id: string; data: string }): Promise<boolean> {
    let joined = false;
    if (!this.hasMlsGroup(welcome.group_id)) {
      try {
        const result = this.mls.joinFromWelcome(decode(welcome.data)) as { groupId: Uint8Array; epoch: number };
        if (fromUtf8(result.groupId) !== welcome.group_id) {
          this.mls.deleteGroup(result.groupId);
          throw new Error("the welcome was for a different conversation");
        }
        this.saveMls();
        this.setJoinedEpoch(welcome.group_id, result.epoch);
        this.rememberCurrentEpochKey(welcome.group_id);
        joined = true;
      } catch (error) {
        // Likely a stale welcome. The group is still reachable by an external join.
        console.warn("[zuna] couldn't use a welcome", error);
        this.saveMls();
      }
    }
    await this.api.deleteWelcome(welcome.id);
    return joined;
  }

  /**
   * Every leaf of a group's tree, and whether it is what it claims. This is the
   * one check on who holds a group's keys: its certificate has to be signed by the
   * identity key known for that person, for the very signing key the leaf uses, and
   * each device has one leaf. Certificates are public, so without that last part
   * anyone could use a real person's certificate with keys of their own.
   */
  private treeMembers(groupId: string): TreeMember[] {
    const members = this.mls.members(utf8(groupId)) as { leafIndex: number; credential: Uint8Array; signatureKey: Uint8Array }[];
    const out: TreeMember[] = members.map((member) => {
      const cert = parseCertificate(member.credential);
      if (!cert) return { leaf: member.leafIndex, userId: "", deviceId: "", genuine: false };
      // Someone not known yet is looked up by checkTree, which runs on any change to the tree.
      const pinned = this.pinnedIdentity(cert.userId);
      const verified = pinned ? verifyCertificate(pinned, member.credential) : cert;
      const genuine = !!verified && equalBytes(verified.signatureKey, member.signatureKey);
      return { leaf: member.leafIndex, userId: cert.userId, deviceId: cert.deviceId, genuine };
    });
    const seen = new Set<string>();
    for (const member of [...out].reverse()) {
      if (!member.genuine) continue;
      if (seen.has(member.deviceId)) member.genuine = false;
      seen.add(member.deviceId);
    }
    return out;
  }

  private treeUsers(groupId: string): string[] {
    return [...new Set(this.treeMembers(groupId).filter((member) => member.genuine).map((member) => member.userId))];
  }

  /** Looks up anyone in a group's tree not known yet, so they can be checked. */
  private async learnTreeUsers(groupId: string): Promise<void> {
    const members = this.mls.members(utf8(groupId)) as { credential: Uint8Array }[];
    for (const member of members) {
      const cert = parseCertificate(member.credential);
      if (cert && !this.pinnedIdentity(cert.userId)) await this.ensureUser(cert.userId, true);
    }
  }

  /**
   * Checks a group's tree after anything that may have changed it, and warns about
   * any leaf that isn't what it claims. Those get removed by the next reconcile,
   * and at the latest before this device encrypts anything else (ensureTreeClean).
   */
  private async checkTree(groupId: string): Promise<TreeMember[]> {
    this.treeUsersCache.delete(groupId);
    this.cleanEpochs.delete(groupId);
    await this.learnTreeUsers(groupId);
    const bad = this.treeMembers(groupId).filter((member) => !member.genuine && member.leaf !== this.mls.ownLeafIndex(utf8(groupId)));
    for (const member of bad) {
      const warned = `${groupId}/${member.leaf}/${this.mlsEpoch(groupId)}`;
      if (this.warnedLeaves.has(warned)) continue;
      this.warnedLeaves.add(warned);
      const owner = member.userId ? this.users.get(member.userId)?.profile.displayName : null;
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: member.userId,
        message: owner
          ? `A device claiming to be ${owner}'s isn't really theirs, and it tried to join one of your conversations. It's being removed.`
          : "A device with an invalid certificate tried to join one of your conversations. It's being removed.",
      });
      if (member.userId) {
        this.addSystemRow(groupId, Date.now(), member.userId, { type: "unexpected_join", actorId: member.userId });
      }
    }
    if (bad.length > 0) this.scheduleReconcile(groupId);
    return bad;
  }

  private knownMembers(groupId: string): Set<string> {
    const row = this.db.get<{ known_members: string }>("SELECT known_members FROM groups WHERE id = ?", [groupId]);
    return new Set(row ? (JSON.parse(row.known_members) as string[]) : []);
  }

  private setKnownMembers(groupId: string, members: Iterable<string>): void {
    this.db.run("UPDATE groups SET known_members = ? WHERE id = ?", [JSON.stringify([...members]), groupId]);
  }

  /**
   * Joins a group without help from any member, for new or repaired devices.
   * Whatever state this device had stays until the server accepts the join, so
   * group info nobody can use, or a join that's refused, costs nothing.
   */
  private async joinExternal(groupId: string): Promise<boolean> {
    const groupBytes = utf8(groupId);
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      const latest = await this.api.groupInfo(groupId);
      if (!latest.group_info) return false;
      this.saveMls();
      const result = this.mls.joinExternal(groupBytes, decode(latest.group_info)) as { commit: Uint8Array; epoch: number };
      const groupInfo = this.mls.exportGroupInfo(groupBytes);
      try {
        await this.api.commit(groupId, {
          expected_epoch: latest.epoch,
          commit: result.commit,
          group_info: groupInfo,
          kind: "external",
        });
      } catch (error) {
        this.mls.rollback();
        if (error instanceof ApiError && error.code === "stale_epoch") continue;
        throw error;
      }
      this.saveMls();
      this.setJoinedEpoch(groupId, result.epoch);
      this.rememberCurrentEpochKey(groupId);
      await this.checkTree(groupId);
      const known = this.knownMembers(groupId);
      if (known.size === 0) this.setKnownMembers(groupId, this.treeUsers(groupId));
      void this.uploadEpochKeys().catch(() => undefined);
      return true;
    }
    return false;
  }

  /** Makes sure this device can use the group, starting it if nobody has yet. */
  private async ensureReady(groupId: string): Promise<void> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    if (group.epoch === 0) {
      await this.initGroup(group, []);
      return;
    }
    if (!this.hasMlsGroup(groupId)) {
      await this.joinExternal(groupId);
      await this.pullChanges(groupId);
    } else if (this.mlsEpoch(groupId) !== group.epoch) {
      await this.pullChanges(groupId);
    }
  }

  /**
   * Removes anyone from the tree who shouldn't be in it, before this device
   * encrypts anything else: someone who just left or was banned, and any leaf that
   * isn't what it claims. What's sent next is under a key they don't have. A check
   * is remembered for its epoch, so sending stays quick.
   */
  private async ensureTreeClean(groupId: string): Promise<void> {
    if (!this.hasMlsGroup(groupId)) return;
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      if (this.cleanEpochs.get(groupId) === this.mlsEpoch(groupId)) return;
      await this.learnTreeUsers(groupId);
      if ((await this.staleLeaves(groupId)).length === 0) {
        this.cleanEpochs.set(groupId, this.mlsEpoch(groupId));
        return;
      }
      // What's known about the roster may be behind, so ask before removing anyone.
      this.applyGroup(await this.api.group(groupId));
      if ((await this.staleLeaves(groupId)).length === 0) continue;
      await this.commitWithRetry(groupId, async () => ({ kind: "update", removeLeaves: await this.staleLeaves(groupId) }));
    }
    throw new Error("Couldn't secure this conversation right now. Please try again.");
  }

  /**
   * Starts a group's MLS state. Two members may race to do this. The server
   * accepts one, and the loser receives a Welcome from the winner.
   */
  private async initGroup(group: ApiGroup, extraUsers: string[], meta?: GroupMeta): Promise<void> {
    const groupBytes = utf8(group.id);
    this.mls.deleteGroup(groupBytes);
    this.mls.createGroup(groupBytes);
    this.saveMls();

    const targets = [...new Set([...group.members.map((member) => member.user_id), ...extraUsers])];
    const packages: { deviceId: string; data: Uint8Array }[] = [];
    for (const userId of targets) {
      packages.push(...(await this.claimKeyPackages(userId, this.account.deviceId)));
    }
    const pending = this.mls.commitChanges(groupBytes, packages.map((item) => item.data) as unknown as any[], new Uint32Array(0)) as {
      commit: Uint8Array;
      welcome: Uint8Array | null;
      groupInfo: Uint8Array | null;
    };
    this.saveMls();

    const newEpoch = 1;
    const key = this.mls.exportPendingSecret(groupBytes, CONTENT_LABEL, u64Bytes(newEpoch), 32);
    try {
      await this.api.commit(group.id, {
        expected_epoch: 0,
        commit: pending.commit,
        group_info: pending.groupInfo!,
        kind: "init",
        add_users: extraUsers,
        welcomes: pending.welcome ? packages.map((item) => ({ device_id: item.deviceId, data: pending.welcome! })) : [],
        meta: meta ? this.sealGroupDetails(group.id, key, newEpoch, meta, 1) : undefined,
        meta_epoch: meta ? newEpoch : undefined,
      });
    } catch (error) {
      this.mls.deleteGroup(groupBytes);
      this.saveMls();
      if (error instanceof ApiError && error.code === "stale_epoch") {
        // Another member started the group first; their welcome is waiting for us.
        await this.processWelcomesFor(group.id);
        if (!this.hasMlsGroup(group.id)) await this.joinExternal(group.id);
        await this.pullChanges(group.id);
        return;
      }
      throw error;
    }
    this.mls.mergePending(groupBytes);
    this.saveMls();
    this.setJoinedEpoch(group.id, newEpoch);
    this.saveEpochKey(group.id, newEpoch, key, "mls");
    this.treeUsersCache.delete(group.id);
    this.setKnownMembers(group.id, targets);
    void this.uploadEpochKeys().catch(() => undefined);
    const started = await this.api.group(group.id);
    this.applyGroup(started);
    if (meta) {
      const current = this.groups.get(group.id);
      if (current) {
        current.meta = meta;
        current.metaVersion = 1;
        this.persistGroup(current);
      }
    }
  }

  /**
   * Builds and sends one commit, retrying from the latest state if another
   * member's commit got in first. `build` runs fresh for each attempt.
   */
  private async commitWithRetry(
    groupId: string,
    build: () => Promise<{
      keyPackages?: { deviceId: string; data: Uint8Array }[];
      removeLeaves?: number[];
      addUsers?: string[];
      removeUsers?: string[];
      meta?: GroupMeta;
      grants?: { user_id: string; data: Uint8Array }[];
      kind: string;
    }>,
  ): Promise<void> {
    const groupBytes = utf8(groupId);
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      await this.pullChanges(groupId);
      const plan = await build();
      const epoch = this.mlsEpoch(groupId);
      const packages = plan.keyPackages ?? [];
      const pending = this.mls.commitChanges(
        groupBytes,
        packages.map((item) => item.data) as unknown as any[],
        Uint32Array.from(plan.removeLeaves ?? []),
      ) as { commit: Uint8Array; welcome: Uint8Array | null; groupInfo: Uint8Array | null };
      this.saveMls();
      const newEpoch = epoch + 1;
      const key = this.mls.exportPendingSecret(groupBytes, CONTENT_LABEL, u64Bytes(newEpoch), 32);
      const group = this.groups.get(groupId);
      const meta = plan.meta ?? group?.meta;
      // Sealing metadata for the new epoch lets newly added members read it. That's for admins, who signed it.
      const shouldSealMeta = !!group && !!meta && Object.keys(meta).length > 0 && this.isGroupAdmin(group, this.account.userId);
      try {
        await this.api.commit(groupId, {
          expected_epoch: epoch,
          commit: pending.commit,
          group_info: pending.groupInfo!,
          kind: plan.kind,
          add_users: plan.addUsers,
          remove_users: plan.removeUsers,
          welcomes: pending.welcome ? packages.map((item) => ({ device_id: item.deviceId, data: pending.welcome! })) : [],
          meta: shouldSealMeta ? this.sealGroupDetails(groupId, key, newEpoch, meta, Math.max(group.metaVersion ?? 0, 1)) : undefined,
          meta_epoch: shouldSealMeta ? newEpoch : undefined,
          history_grants: plan.grants,
        });
      } catch (error) {
        this.mls.clearPending(groupBytes);
        this.saveMls();
        if (error instanceof ApiError && error.code === "stale_epoch") continue;
        throw error;
      }
      this.mls.mergePending(groupBytes);
      this.saveMls();
      this.saveEpochKey(groupId, newEpoch, key, "mls");
      this.treeUsersCache.delete(groupId);
      this.confirmedEpochs.set(groupId, newEpoch);
      void this.uploadEpochKeys().catch(() => undefined);
      return;
    }
    throw new Error("The conversation is very busy right now. Please try again.");
  }

  // --- Groups: applying changes ---

  /** Fetches and applies the feed until caught up. Serialized per group. */
  async syncGroup(groupId: string): Promise<void> {
    const running = this.syncing.get(groupId);
    if (running) {
      running.again = true;
      return running.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          let more = true;
          while (more && !this.stopped) {
            more = await this.withLock(groupId, () => this.pullPage(groupId));
          }
        } while (entry.again && !this.stopped);
      } finally {
        this.syncing.delete(groupId);
      }
    })();
    this.syncing.set(groupId, entry);
    await entry.done;
    this.scheduleReconcile(groupId);
  }

  /** A sync started from an event. A group we were removed from stops being taken part in. */
  private backgroundSync(groupId: string): void {
    void this.syncGroup(groupId).catch((error) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        void this.withLock(groupId, async () => this.markRemoved(groupId));
      } else {
        console.warn("[zuna] sync failed", error);
      }
    });
  }

  /** Catches up while already holding the group's lock. */
  private async pullChanges(groupId: string): Promise<void> {
    while (await this.pullPage(groupId)) {
      // Keep going until the feed has no more pages.
    }
  }

  private syncedSeq(groupId: string): number {
    return this.db.get<{ synced_seq: number }>("SELECT synced_seq FROM groups WHERE id = ?", [groupId])?.synced_seq ?? 0;
  }

  private setSyncedSeq(groupId: string, seq: number): void {
    this.db.run("UPDATE groups SET synced_seq = ? WHERE id = ?", [seq, groupId]);
  }

  private async pullPage(groupId: string): Promise<boolean> {
    const cached = this.groups.get(groupId);
    if (!cached || cached.removedAt) return false;
    if (!this.hasMlsGroup(groupId)) {
      const group = await this.api.group(groupId);
      this.applyGroup(group);
      if (group.epoch === 0) return false;
      await this.processWelcomesFor(groupId);
      if (!this.hasMlsGroup(groupId)) {
        const joined = await this.joinExternal(groupId);
        if (!joined) return false;
      }
    }
    const after = this.syncedSeq(groupId);
    const page = await this.api.changes(groupId, after);
    const items: ({ seq: number; message: ApiMessage } | { seq: number; event: ApiEvent })[] = [
      ...page.messages.map((message) => ({ seq: message.updated_seq, message })),
      ...page.events.map((event) => ({ seq: event.seq, event })),
    ];
    items.sort((a, b) => a.seq - b.seq);
    for (const item of items) {
      if ("event" in item) {
        await this.applyEvent(item.event);
      } else {
        this.ingest(item.message, false);
      }
    }
    if (page.cursor > after) this.setSyncedSeq(groupId, page.cursor);
    const group = this.groups.get(groupId);
    if (group) {
      this.refreshGroupSecrets(group);
      this.persistGroup(group);
    }
    if (items.length > 0) this.emitConversations();
    return page.has_more;
  }

  private async applyEvent(event: ApiEvent): Promise<void> {
    if (event.kind === "member_left") {
      if (event.target_user && event.target_user !== event.sender_user) {
        this.addSystemRow(event.group_id, event.created_at, event.sender_user, {
          type: "member_removed",
          actorId: event.sender_user,
          targetIds: [event.target_user],
        }, event.seq);
      } else if (event.target_user) {
        this.addSystemRow(event.group_id, event.created_at, event.target_user, {
          type: "member_left",
          actorId: event.target_user,
        }, event.seq);
      }
      this.scheduleReconcile(event.group_id);
      return;
    }
    await this.applyCommit(event);
  }

  private async applyCommit(event: ApiEvent): Promise<void> {
    const groupId = event.group_id;
    const groupBytes = utf8(groupId);
    if (!this.hasMlsGroup(groupId)) return;
    const local = this.mlsEpoch(groupId);
    if (event.epoch <= local) return;

    if (event.sender_device === this.account.deviceId) {
      // Our own commit, and we restarted before merging it.
      if (this.mls.hasPending(groupBytes)) {
        this.mls.mergePending(groupBytes);
        this.saveMls();
        this.rememberCurrentEpochKey(groupId);
        return;
      }
      await this.repair(groupId);
      return;
    }
    if (event.epoch > local + 1) {
      await this.repair(groupId);
      return;
    }
    if (this.mls.hasPending(groupBytes)) {
      this.mls.clearPending(groupBytes);
      this.saveMls();
    }

    let processed: {
      epoch: number;
      senderCredential: Uint8Array;
      isExternal: boolean;
      addedCredentials: Uint8Array[];
      removedCredentials: Uint8Array[];
      selfRemoved: boolean;
    };
    const usersBefore = new Set(this.treeUsers(groupId));
    try {
      processed = this.mls.processCommit(groupBytes, decode(event.data)) as typeof processed;
      this.saveMls();
    } catch (error) {
      console.warn("[zuna] a commit couldn't be applied; rejoining", error);
      this.saveMls();
      await this.repair(groupId);
      return;
    }
    if (processed.selfRemoved) {
      this.removeGroupLocally(groupId);
      return;
    }
    this.rememberCurrentEpochKey(groupId);
    void this.uploadEpochKeys().catch(() => undefined);
    await this.checkTree(groupId);
    this.describeCommit(event, processed, usersBefore);
    this.retryUndecryptable(groupId);
  }

  /**
   * Turns an applied commit into what people see. Everything here comes from
   * MLS-authenticated data, so the server can't quietly add someone to a chat.
   */
  private describeCommit(
    event: ApiEvent,
    processed: { senderCredential: Uint8Array; isExternal: boolean; addedCredentials: Uint8Array[]; removedCredentials: Uint8Array[] },
    usersBefore: Set<string>,
  ): void {
    const groupId = event.group_id;
    const known = this.knownMembers(groupId);
    const senderCert = parseCertificate(processed.senderCredential);
    const inTree = new Set(this.treeUsers(groupId));

    const addedUsers = new Set<string>();
    for (const credential of processed.addedCredentials) {
      const cert = parseCertificate(credential);
      if (cert && !known.has(cert.userId)) addedUsers.add(cert.userId);
    }
    if (addedUsers.size > 0 && senderCert) {
      this.addSystemRow(groupId, event.created_at, senderCert.userId, {
        type: "member_added",
        actorId: senderCert.userId,
        targetIds: [...addedUsers],
      }, event.seq);
    }

    if (processed.isExternal && senderCert) {
      // Someone's extra device joining needs no notice, but a person arriving
      // with no device in the group does, so a rejoin can never go unnoticed.
      if (!usersBefore.has(senderCert.userId)) {
        if (known.size > 0 && !known.has(senderCert.userId)) {
          // Nobody in the chat added this person. Shown as a warning, never hidden.
          this.addSystemRow(groupId, event.created_at, senderCert.userId, {
            type: "unexpected_join",
            actorId: senderCert.userId,
          }, event.seq);
        } else {
          this.addSystemRow(groupId, event.created_at, senderCert.userId, {
            type: "member_rejoined",
            actorId: senderCert.userId,
          }, event.seq);
        }
        addedUsers.add(senderCert.userId);
      }
      if (known.has(senderCert.userId)) this.resealMeta(groupId);
    }

    const removedUsers = new Set<string>();
    for (const credential of processed.removedCredentials) {
      const cert = parseCertificate(credential);
      if (cert && !inTree.has(cert.userId)) removedUsers.add(cert.userId);
    }
    if (removedUsers.size > 0 && senderCert && this.isRosterRemoval(groupId, removedUsers) && !this.alreadyAnnouncedRemoval(groupId, removedUsers)) {
      this.addSystemRow(groupId, event.created_at, senderCert.userId, {
        type: "member_removed",
        actorId: senderCert.userId,
        targetIds: [...removedUsers],
      }, event.seq);
    }

    // Signing out of a last device empties someone's place but keeps them a
    // member. Only people who really left stop being known.
    const roster = new Set(this.groups.get(groupId)?.members.map((member) => member.userId));
    for (const user of addedUsers) known.add(user);
    for (const user of removedUsers) if (!roster.has(user)) known.delete(user);
    for (const user of inTree) known.add(user);
    this.setKnownMembers(groupId, known);
  }

  /** False when people merely signed out of their last device and are still members. */
  private isRosterRemoval(groupId: string, users: Set<string>): boolean {
    const group = this.groups.get(groupId);
    return !!group && [...users].some((user) => !group.members.some((member) => member.userId === user));
  }

  /** A roster event already reported this, so the follow-up commit stays silent. */
  private alreadyAnnouncedRemoval(groupId: string, users: Set<string>): boolean {
    const messages = this.db.all<{ id: string; body: Uint8Array | null }>(
      "SELECT id, body FROM messages WHERE group_id = ? AND id LIKE 'sys-%' ORDER BY row_id DESC LIMIT 20",
      [groupId],
    );
    return messages.some((row) => {
      if (!row.body) return false;
      const { system } = this.openJson<StoredBody>("message", row.body);
      const announced = system?.type === "member_left" ? [system.actorId] : system?.type === "member_removed" ? (system.targetIds ?? []) : [];
      return [...users].every((user) => announced.includes(user));
    });
  }

  private async repair(groupId: string): Promise<void> {
    await this.joinExternal(groupId);
    this.retryUndecryptable(groupId);
  }

  // --- Reconciling MLS with the roster ---

  private scheduleReconcile(groupId: string): void {
    if (this.reconcileTimers.has(groupId) || this.stopped) return;
    // Everyone in the group sees the same change. The delay lets one client do
    // the work; the others see its commit and have nothing left to do.
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(groupId);
      void this.withLock(groupId, () => this.reconcile(groupId)).catch((error) => {
        console.warn("[zuna] reconcile failed", error);
      });
    }, Math.random() * RECONCILE_JITTER_MS);
    this.reconcileTimers.set(groupId, timer);
  }

  private async staleLeaves(groupId: string): Promise<number[]> {
    const group = this.groups.get(groupId);
    if (!group || !this.hasMlsGroup(groupId)) return [];
    const roster = new Set(group.members.map((member) => member.userId));
    const own = this.mls.ownLeafIndex(utf8(groupId));
    const stale: number[] = [];
    for (const member of this.treeMembers(groupId)) {
      if (member.leaf === own) continue;
      if (!member.genuine || !roster.has(member.userId)) {
        stale.push(member.leaf);
        continue;
      }
      let device = this.users.get(member.userId)?.devices.get(member.deviceId);
      if (!device) {
        // Our list may be behind: only act on what the server says right now.
        device = (await this.ensureUser(member.userId, true))?.devices.get(member.deviceId);
      }
      if (device?.revoked) stale.push(member.leaf);
    }
    return stale;
  }

  private async reconcile(groupId: string): Promise<void> {
    if (this.stopped || this.groups.get(groupId)?.removedAt || !this.hasMlsGroup(groupId)) return;
    await this.learnTreeUsers(groupId);
    if ((await this.staleLeaves(groupId)).length === 0) return;
    // What's known about the roster may be behind, so ask before removing anyone.
    this.applyGroup(await this.api.group(groupId));
    if ((await this.staleLeaves(groupId)).length === 0) return;
    await this.commitWithRetry(groupId, async () => ({
      kind: "update",
      removeLeaves: await this.staleLeaves(groupId),
    }));
  }

  // --- Realtime frames ---

  private onFrame(frame: SocketFrame): void {
    const data = frame.d;
    switch (frame.t) {
      case "message":
        this.onLiveMessage(data as ApiMessage);
        break;
      case "event":
        void this.onLiveEvent(data as ApiEvent).catch((error) => console.warn("[zuna] event", error));
        break;
      case "group": {
        const known = this.groups.has((data as ApiGroup).id);
        this.applyGroup(data as ApiGroup);
        this.emitConversations();
        if (!known) this.backgroundSync((data as ApiGroup).id);
        break;
      }
      case "group_removed":
        void this.withLock(data.group_id, async () => this.markRemoved(data.group_id)).catch(() => undefined);
        break;
      case "welcome":
        void this.processWelcomes().then(() => this.processHistoryGrants()).catch((error) => console.warn("[zuna] welcome", error));
        break;
      case "read":
        this.onLiveRead(data);
        break;
      case "typing":
        this.onLiveTyping(data);
        break;
      case "activity": {
        const elsewhere = (data.active_devices as string[]).some((id) => id !== this.account.deviceId);
        if (elsewhere !== this.activeElsewhere) {
          this.activeElsewhere = elsewhere;
          this.emit({ type: "activity", serverId: this.serverId, elsewhere });
        }
        break;
      }
      case "presence":
        this.onPresence(data);
        break;
      case "user":
        this.applyUser(data as ApiUser);
        this.emit({ type: "users", serverId: this.serverId });
        this.emitConversations();
        this.rescheduleAffectedByDeviceChange((data as ApiUser).id);
        break;
      case "vault":
        void this.syncVault().catch((error) => console.warn("[zuna] vault", error));
        break;
      case "settings":
        this.info = data as ServerInfo;
        this.setKv("info", this.info);
        this.emit({ type: "settings", serverId: this.serverId, info: this.info });
        break;
      case "emotes":
        void this.refreshEmotes().catch((error) => console.warn("[zuna] emotes", error));
        break;
      case "device_revoked":
        if (data.device_id === this.account.deviceId) this.signedOut("device_revoked");
        break;
      case "force_logout":
        this.signedOut(data.reason ?? "session_ended");
        break;
    }
  }

  private rescheduleAffectedByDeviceChange(userId: string): void {
    for (const group of this.groups.values()) {
      if (group.members.some((member) => member.userId === userId)) this.scheduleReconcile(group.id);
    }
  }

  private onLiveMessage(message: ApiMessage): void {
    if (!this.groups.has(message.group_id)) {
      this.backgroundSync(message.group_id);
      return;
    }
    this.ingest(message, true);
    const synced = this.syncedSeq(message.group_id);
    if (message.updated_seq === synced + 1) {
      this.setSyncedSeq(message.group_id, message.updated_seq);
    } else if (message.updated_seq > synced) {
      this.backgroundSync(message.group_id);
    }
    this.emitConversations();
  }

  private async onLiveEvent(event: ApiEvent): Promise<void> {
    if (!this.groups.has(event.group_id)) {
      this.backgroundSync(event.group_id);
      return;
    }
    await this.withLock(event.group_id, async () => {
      const synced = this.syncedSeq(event.group_id);
      if (event.seq === synced + 1 && this.hasMlsGroup(event.group_id)) {
        await this.applyEvent(event);
        this.setSyncedSeq(event.group_id, event.seq);
      } else if (event.seq > synced) {
        this.backgroundSync(event.group_id);
      }
    });
    this.emitConversations();
  }

  private onLiveRead(data: { group_id: string; user_id: string; data: string }): void {
    const group = this.groups.get(data.group_id);
    if (!group) return;
    this.applyReadState(group, data.user_id, fromBase64(data.data));
    this.persistGroup(group);
    const seq = data.user_id === this.account.userId ? group.ownRead : (group.readBy[data.user_id] ?? 0);
    this.emit({ type: "read", serverId: this.serverId, groupId: data.group_id, userId: data.user_id, seq });
    if (data.user_id === this.account.userId) this.emitConversations();
  }

  private onLiveTyping(data: { group_id: string; user_id: string; data: string }): void {
    const sealed = decodeFrameData(data.data);
    const key = this.epochKey(data.group_id, signalEpoch(sealed));
    if (!key || !openSignal(key, "typing", data.group_id, sealed)) return;
    if (data.user_id === this.account.userId) return;
    this.emit({ type: "typing", serverId: this.serverId, groupId: data.group_id, userId: data.user_id });
  }

  private onPresence(data: { user_id: string; online: boolean; last_seen_at?: number }): void {
    if (data.online) this.online.add(data.user_id);
    else this.online.delete(data.user_id);
    const user = this.users.get(data.user_id);
    if (user && data.last_seen_at) user.lastSeenAt = data.last_seen_at;
    this.emit({
      type: "presence",
      serverId: this.serverId,
      userId: data.user_id,
      online: data.online,
      lastSeenAt: user?.lastSeenAt ?? null,
    });
  }

  // --- Ingesting messages ---

  private messageRow(groupId: string, id: string): MessageRow | undefined {
    return this.db.get<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND id = ?", [groupId, id]);
  }

  private openReactions(groupId: string, messageId: string, raw: ApiReaction[]): ReactionView[] {
    const grouped = new Map<string, ReactionView>();
    for (const reaction of raw) {
      const key = this.epochKey(groupId, reaction.epoch);
      if (!key) continue;
      const opened = parseReaction(openSignal<unknown>(key, "reaction", groupId, decode(reaction.data)));
      if (!opened) continue;
      // The ID commits to the reacting user, so reactions can't be reattributed.
      if (reactionId(reaction.user_id, messageId, opened.key) !== reaction.id) continue;
      const entry = grouped.get(opened.key) ?? { key: opened.key, emote: opened.emote, userIds: [] };
      entry.userIds.push(reaction.user_id);
      grouped.set(opened.key, entry);
    }
    return [...grouped.values()];
  }

  /** Stores a message's current state, decrypting it if the keys are available. */
  private ingest(message: ApiMessage, live: boolean): void {
    if (!validApiMessage(message)) {
      console.warn("[zuna] the server sent something that isn't a message");
      return;
    }
    const existing = this.messageRow(message.group_id, message.id);
    if (existing && existing.updated_seq >= message.updated_seq && existing.status !== "undecryptable" && existing.status !== "unverified") {
      return;
    }
    let status: MessageStatus = "sent";
    let body: StoredBody | null = null;
    let raw: Uint8Array | null = null;
    if (!message.deleted_at && message.envelope) {
      const envelope = decode(message.envelope);
      const key = this.epochKey(message.group_id, message.epoch);
      const device = this.users.get(message.sender_user)?.devices.get(message.sender_device);
      if (!key || !device) {
        status = "undecryptable";
        raw = envelope;
      } else {
        const opened = openEnvelope<unknown>(key, device.signatureKey, "message", message.group_id, message.id, message.epoch, envelope);
        if (opened.ok) {
          this.keyProvedItself(message.group_id, message.epoch);
          const parsed = parseMessageBody(opened.value);
          if (parsed) {
            body = { ...parsed, rawReactions: message.reactions };
          } else {
            status = "invalid";
            raw = envelope;
          }
        } else if (opened.reason === "signature") {
          status = "unverified";
          raw = envelope;
        } else {
          status = "undecryptable";
          raw = envelope;
        }
      }
    }
    const stored = body
      ? this.sealJson("message", { ...body, reactions: this.openReactions(message.group_id, message.id, message.reactions) })
      : null;

    let rowId: number;
    const isNew = !existing || existing.seq === null;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, edited_at, deleted_at, pinned_at, pinned_by, status, body, raw)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(group_id, id) DO UPDATE SET seq = excluded.seq, updated_seq = excluded.updated_seq, sender_device = excluded.sender_device,
           epoch = excluded.epoch, created_at = excluded.created_at, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at,
           pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by, status = excluded.status, body = excluded.body, raw = excluded.raw`,
        [
          message.group_id,
          message.id,
          message.seq,
          message.updated_seq,
          message.sender_user,
          message.sender_device,
          message.epoch,
          message.created_at,
          message.edited_at,
          message.deleted_at,
          message.pinned_at,
          message.pinned_by ?? null,
          status,
          stored,
          raw,
        ],
      );
      rowId = this.db.get<{ row_id: number }>("SELECT row_id FROM messages WHERE group_id = ? AND id = ?", [message.group_id, message.id])!.row_id;
      this.db.run("DELETE FROM search WHERE rowid = ?", [rowId]);
      if (body) {
        const words = [body.text ?? "", ...(body.attachments ?? []).map((item) => item.name)].join(" ");
        const tokens = indexTokens(this.searchKey, words);
        if (tokens) this.db.run("INSERT INTO search(rowid, tokens) VALUES(?, ?)", [rowId, tokens]);
      }
      this.db.run("UPDATE groups SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?", [message.created_at, message.group_id]);
    });

    const row = this.messageRow(message.group_id, message.id)!;
    const view = this.toMessageView(row);
    this.emit({ type: "message", serverId: this.serverId, message: view, isNew: live && isNew });
    // The first message in a new chat often beats its welcome, and only opens once that's in.
    const ref = `${message.group_id}/${message.id}`;
    if (live && isNew && status !== "sent") this.awaitingKeys.add(ref);
    const fresh = live ? isNew : status === "sent" && this.awaitingKeys.delete(ref);
    if (fresh && status === "sent" && message.sender_user !== this.account.userId) this.maybeNotify(view);
  }

  private retryUndecryptable(groupId: string): void {
    const rows = this.db.all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND status IN ('undecryptable','unverified')", [groupId]);
    for (const row of rows) {
      if (!row.raw) continue;
      this.ingest(
        {
          group_id: row.group_id,
          id: row.id,
          seq: row.seq ?? 0,
          updated_seq: row.updated_seq,
          sender_user: row.sender_user,
          sender_device: row.sender_device,
          epoch: row.epoch,
          envelope: toBase64(row.raw),
          created_at: row.created_at,
          edited_at: row.edited_at,
          deleted_at: row.deleted_at,
          pinned_at: row.pinned_at,
          pinned_by: row.pinned_by ?? undefined,
          reactions: [],
        },
        false,
      );
    }
    const group = this.groups.get(groupId);
    if (group) {
      this.refreshGroupSecrets(group);
      this.persistGroup(group);
    }
  }

  private addSystemRow(groupId: string, createdAt: number, actor: string, system: SystemEvent, seq?: number): void {
    const id = seq !== undefined ? `sys-${seq}` : `sys-${randomId()}`;
    if (!this.groups.has(groupId) || this.messageRow(groupId, id)) return;
    // A notice only this device knows about goes after everything seen so far.
    // Having no sequence number means a message is still being sent.
    this.db.run(
      `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, created_at, status, body) VALUES(?,?,?,?,?,?,?,?)`,
      [groupId, id, seq ?? this.latestSeq(groupId), seq ?? 0, actor, createdAt, "sent", this.sealJson("message", { system })],
    );
    this.emit({
      type: "message",
      serverId: this.serverId,
      message: this.toMessageView(this.messageRow(groupId, id)!),
      isNew: false,
    });
  }

  private latestSeq(groupId: string): number {
    const newest = this.db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM messages WHERE group_id = ?", [groupId])?.seq ?? 0;
    return Math.max(newest, this.groups.get(groupId)?.seq ?? 0);
  }

  private maybeNotify(view: MessageView): void {
    // As in Telegram, notifications go where the person is.
    if (this.activeElsewhere && !this.active) return;
    const group = this.groups.get(view.groupId);
    if (!group) return;
    const key = this.conversationKey(group);
    const mentioned = view.mentions.includes(this.account.userId);
    if (isMuted(this.prefs, key) && !mentioned) return;
    const sender = this.users.get(view.senderId);
    const senderName = sender?.profile.displayName || sender?.username || "Someone";
    const { title, body } = notificationText(group.kind, group.meta.name, senderName, view);
    this.emit({ type: "notify", serverId: this.serverId, title, body, conversationKey: key, groupId: view.groupId, messageId: view.id });
  }

  previewText(view: Pick<MessageView, "text" | "attachments">): string {
    return previewText(view);
  }

  /** What a row holds, as far as it can be shown. Stored before these checks, it may be anything. */
  private storedBody(row: MessageRow): StoredBody | null {
    return row.body ? readStoredBody(row, this.openJson<StoredBody>("message", row.body)) : {};
  }

  private toMessageView(row: MessageRow): MessageView {
    const stored = this.storedBody(row);
    const body: StoredBody = stored ?? {};
    const view: MessageView = {
      id: row.id,
      groupId: row.group_id,
      seq: row.seq,
      senderId: row.sender_user,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
      pinnedAt: row.pinned_at,
      pinnedBy: row.pinned_by,
      status: stored ? row.status : "invalid",
      text: body.text ?? "",
      emotes: body.emotes ?? {},
      attachments: body.attachments ?? [],
      mentions: body.mentions ?? [],
      reply: body.replyTo ? this.replyPreview(row.group_id, body.replyTo) : null,
      reactions: body.reactions ?? [],
      system: body.system ?? null,
      preview: body.preview ?? null,
      forwarded: body.forwarded ?? null,
    };
    return view;
  }

  private replyPreview(groupId: string, id: string): ReplyPreview {
    const row = this.messageRow(groupId, id);
    if (!row) return { id, senderId: "", text: "", hasAttachment: false, deleted: false };
    if (!row.body) return { id, senderId: row.sender_user, text: "", hasAttachment: false, deleted: row.deleted_at !== null };
    const body = this.storedBody(row);
    return {
      id,
      senderId: row.sender_user,
      text: body?.text?.slice(0, 200) ?? "",
      hasAttachment: (body?.attachments?.length ?? 0) > 0,
      deleted: false,
    };
  }

  // --- Conversations ---

  private conversationKey(group: CachedGroup): string {
    return group.kind === "dm" ? `user:${group.peerId}` : `group:${group.id}`;
  }

  private groupForKey(key: string): CachedGroup | undefined {
    if (key.startsWith("group:")) return this.groups.get(key.slice(6));
    return this.dmWith(key.slice(5));
  }

  private lastMessage(groupId: string): MessageView | null {
    const row = this.db.get<MessageRow>(
      `SELECT * FROM messages WHERE group_id = ? AND deleted_at IS NULL
       ORDER BY COALESCE(seq, 9007199254740991) DESC, created_at DESC LIMIT 1`,
      [groupId],
    );
    return row ? this.toMessageView(row) : null;
  }

  private unreadCount(group: CachedGroup): { unread: number; mentioned: boolean } {
    const rows = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND seq > ? AND sender_user != ?
       AND deleted_at IS NULL AND id NOT LIKE 'sys-%'`,
      [group.id, group.ownRead, this.account.userId],
    );
    return { unread: rows?.n ?? 0, mentioned: false };
  }

  getConversations(): ConversationView[] {
    const out: ConversationView[] = [];
    const usersWithDm = new Set<string>();
    const selfId = this.account.userId;
    const now = Date.now();

    for (const group of this.groups.values()) {
      const key = this.conversationKey(group);
      const last = this.lastMessage(group.id);
      const { unread, mentioned } = this.unreadCount(group);
      let title = group.meta.name || "Group";
      let avatar: AvatarRef | null = group.meta.avatar ?? null;
      if (group.kind === "dm" && group.peerId) {
        usersWithDm.add(group.peerId);
        const peer = this.users.get(group.peerId);
        title = group.peerId === selfId ? "Saved messages" : peer?.profile.displayName || peer?.username || "Unknown";
        avatar = peer?.profile.avatar ?? null;
      }
      out.push({
        key,
        kind: group.kind,
        groupId: group.id,
        peerId: group.peerId,
        title,
        avatar,
        description: group.meta.description ?? "",
        lastMessage: last,
        lastActivityAt: last?.createdAt ?? group.createdAt,
        unread,
        mentioned,
        pinned: this.prefs.pinned.includes(key),
        muted: isMuted(this.prefs, key, now),
        mutedUntil: this.mutedUntil(key, now),
        hidden: this.prefs.hidden.includes(key),
        members: this.membersWithKeys(group),
        historyVisible: group.historyVisible,
        readBy: group.readBy,
        ownRead: group.ownRead,
        ready: group.epoch > 0 && !group.removedAt,
        removed: !!group.removedAt,
      });
    }

    // Everyone on the server is a conversation from the start.
    for (const user of this.users.values()) {
      if (usersWithDm.has(user.id) || user.banned) continue;
      const key = `user:${user.id}`;
      out.push({
        key,
        kind: "dm",
        groupId: null,
        peerId: user.id,
        title: user.id === selfId ? "Saved messages" : user.profile.displayName || user.username,
        avatar: user.profile.avatar ?? null,
        description: "",
        lastMessage: null,
        lastActivityAt: 0,
        unread: 0,
        mentioned: false,
        pinned: this.prefs.pinned.includes(key),
        muted: isMuted(this.prefs, key, now),
        mutedUntil: this.mutedUntil(key, now),
        hidden: this.prefs.hidden.includes(key),
        members: [],
        historyVisible: false,
        readBy: {},
        ownRead: 0,
        ready: false,
        removed: false,
      });
    }
    return out.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.lastActivityAt - a.lastActivityAt ||
        a.title.localeCompare(b.title),
    );
  }

  /**
   * A group's members, as the server lists them and as its keys say. Who holds
   * the keys is what MLS proves, so a difference is shown, not hidden.
   */
  private membersWithKeys(group: CachedGroup): GroupMemberView[] {
    if (group.kind !== "group" || group.removedAt || group.epoch === 0) return group.members;
    let inTree = this.treeUsersCache.get(group.id);
    if (!inTree) {
      if (!this.hasMlsGroup(group.id)) return group.members;
      inTree = new Set(this.treeUsers(group.id));
      this.treeUsersCache.set(group.id, inTree);
    }
    const members = group.members.map((member) => (inTree.has(member.userId) ? member : { ...member, noKeys: true }));
    for (const userId of inTree) {
      if (!group.members.some((member) => member.userId === userId)) {
        members.push({ userId, role: "member", joinedAt: 0, notOnRoster: true });
      }
    }
    return members;
  }

  getPreferences(): Preferences {
    return this.prefs;
  }

  async updatePreferences(changes: Partial<Preferences>): Promise<void> {
    this.prefs = { ...this.prefs, ...changes };
    this.setKv("prefs", this.prefs);
    this.emit({ type: "preferences", serverId: this.serverId });
    this.emitConversations();
    this.watchMutes();
    if (changes.muted || changes.mutedUntil) this.resendPush();
    await this.putVault("prefs", utf8(JSON.stringify(this.prefs))).catch((error) => {
      console.warn("[zuna] saving preferences", error);
    });
  }

  /** Mutes a chat until `until` (ms), or without it until it's unmuted. */
  mute(key: string, until?: number): Promise<void> {
    const mutedUntil = Object.fromEntries(Object.entries(this.prefs.mutedUntil ?? {}).filter(([other, end]) => other !== key && end > Date.now()));
    if (until !== undefined) mutedUntil[key] = until;
    const muted = this.prefs.muted.filter((other) => other !== key);
    if (until === undefined) muted.push(key);
    return this.updatePreferences({ muted, mutedUntil });
  }

  unmute(key: string): Promise<void> {
    const mutedUntil = Object.fromEntries(Object.entries(this.prefs.mutedUntil ?? {}).filter(([other, end]) => other !== key && end > Date.now()));
    return this.updatePreferences({ muted: this.prefs.muted.filter((other) => other !== key), mutedUntil });
  }

  private mutedUntil(key: string, now = Date.now()): number | null {
    const until = this.prefs.mutedUntil?.[key];
    return until && until > now && !this.prefs.muted.includes(key) ? until : null;
  }

  /** Shows a chat muted for a while as heard again the moment its time is up. */
  private watchMutes(): void {
    clearTimeout(this.muteTimer);
    const now = Date.now();
    const next = Math.min(...Object.values(this.prefs.mutedUntil ?? {}).filter((until) => until > now));
    if (!Number.isFinite(next) || this.stopped) return;
    this.muteTimer = setTimeout(() => {
      this.emitConversations();
      this.watchMutes();
    }, next - now + 50);
  }

  // --- Notifications ---

  /**
   * Whether the person is using this device right now: the desktop without
   * being idle, the phone app on screen. While they are, their other devices
   * keep quiet and nothing is pushed to them.
   */
  setActive(active: boolean): void {
    this.active = active;
    this.socket.setActive(active);
  }

  /** Whether the person is using another of their devices, as the server last said. */
  isActiveElsewhere(): boolean {
    return this.activeElsewhere;
  }

  /**
   * Has the server wake this device through a push relay for new messages, or
   * stops it with null. It's remembered, and sent again after reconnecting and
   * whenever the muted chats change, if the server is told about them.
   */
  async setPush(push: PushSettings | null): Promise<void> {
    this.push = push ?? "off";
    this.setKv("push", push ? { ...push, key: toBase64(push.key) } : "off");
    await this.sendPush();
  }

  /** One update at a time, each sending what's current then, so a late one can't undo a newer one. */
  private sendPush(): Promise<void> {
    return this.withLock("push", () => this.sendPushNow());
  }

  private async sendPushNow(): Promise<void> {
    const push = this.push;
    if (push === null) return;
    if (push === "off") {
      await this.api.deletePush();
      return;
    }
    // Muted DMs are kept by the person's key; the server knows the DM's group.
    // A chat muted for a while is pushed again once its time is up, even while the app isn't running.
    const groupOf = (key: string) => this.groupForKey(key)?.id;
    const muted = push.sendMuted ? this.prefs.muted.map(groupOf).filter((id): id is string => !!id) : [];
    const mutedUntil: Record<string, number> = {};
    for (const [key, until] of Object.entries(push.sendMuted ? (this.prefs.mutedUntil ?? {}) : {})) {
      const groupId = groupOf(key);
      if (groupId && until > Date.now()) mutedUntil[groupId] = until;
    }
    await this.api.setPush({ relay: push.relay, handle: push.handle, key: push.key, registration: push.registration, muted, muted_until: mutedUntil });
  }

  private resendPush(): void {
    this.sendPush().catch((error) => console.warn("[zuna] updating notifications", error));
  }

  // --- Reading messages ---

  private backfilled(groupId: string): boolean {
    const group = this.groups.get(groupId);
    return !!group && this.syncedSeq(groupId) >= group.seq;
  }

  /** One page of history, newest last. Older pages come from the server if needed. */
  async loadMessages(groupId: string, before?: number): Promise<{ messages: MessageView[]; hasMore: boolean }> {
    const upper = before ?? Number.MAX_SAFE_INTEGER;
    if (!this.backfilled(groupId)) {
      try {
        const remote = await this.api.messages(groupId, { before: before ?? undefined, limit: PAGE_SIZE });
        for (const message of remote) this.ingest(message, false);
      } catch (error) {
        console.warn("[zuna] couldn't fetch history", error);
      }
    }
    const rows = this.db
      .all<MessageRow>(
        `SELECT * FROM messages WHERE group_id = ? AND seq IS NOT NULL AND seq < ?
         ORDER BY seq DESC, id LIKE 'sys-%' DESC, row_id DESC LIMIT ?`,
        [groupId, upper, PAGE_SIZE + 1],
      )
      .reverse();
    const hasMore = rows.length > PAGE_SIZE;
    if (hasMore) {
      // A notice can share its number with the message before it. A page never
      // splits them, since the next page starts below that number.
      const cut = rows.shift()!.seq;
      while (rows[0]?.seq === cut) rows.shift();
    }
    const pendingRows =
      before === undefined
        ? this.db.all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND seq IS NULL ORDER BY created_at", [groupId])
        : [];
    const messages = [...rows, ...pendingRows].map((row) => this.toMessageView(row));
    void this.fetchMissingReplies(groupId, messages);
    return { messages, hasMore };
  }

  /** Loads the messages around a sequence number, for jumping to a reply or search hit. */
  async loadAround(groupId: string, seq: number): Promise<MessageView[]> {
    const remote = await this.api.messages(groupId, { around: seq, limit: PAGE_SIZE }).catch(() => []);
    for (const message of remote) this.ingest(message, false);
    const rows = this.db.all<MessageRow>(
      `SELECT * FROM (
         SELECT * FROM messages WHERE group_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?
       ) UNION SELECT * FROM (
         SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
       ) ORDER BY seq ASC`,
      [groupId, seq, PAGE_SIZE / 2 + 1, groupId, seq, PAGE_SIZE / 2],
    );
    return rows.map((row) => this.toMessageView(row));
  }

  async messageById(groupId: string, id: string): Promise<MessageView | null> {
    let row = this.messageRow(groupId, id);
    if (!row) {
      try {
        this.ingest(await this.api.message(groupId, id), false);
      } catch {
        return null;
      }
      row = this.messageRow(groupId, id);
    }
    return row ? this.toMessageView(row) : null;
  }

  private async fetchMissingReplies(groupId: string, messages: MessageView[]): Promise<void> {
    for (const message of messages) {
      if (message.reply && !message.reply.senderId && !message.reply.deleted) {
        try {
          this.ingest(await this.api.message(groupId, message.reply.id), false);
          const row = this.messageRow(groupId, message.id);
          if (row) this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(row), isNew: false });
        } catch {
          // Not visible to this member, for example sent before they joined.
        }
      }
    }
  }

  async loadPins(groupId: string): Promise<MessageView[]> {
    try {
      for (const message of await this.api.pins(groupId)) this.ingest(message, false);
    } catch (error) {
      console.warn("[zuna] couldn't fetch pins", error);
    }
    return this.db
      .all<MessageRow>("SELECT * FROM messages WHERE group_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC", [groupId])
      .map((row) => this.toMessageView(row));
  }

  search(query: string, groupId?: string, limit = 50): SearchResult[] {
    const match = queryTokens(this.searchKey, query);
    if (!match) return [];
    const params: SqlValue[] = [match];
    let filter = "";
    if (groupId) {
      filter = " AND m.group_id = ?";
      params.push(groupId);
    }
    params.push(limit);
    const rows = this.db.all<MessageRow>(
      `SELECT m.* FROM search s JOIN messages m ON m.row_id = s.rowid
       WHERE search MATCH ? AND m.deleted_at IS NULL${filter}
       ORDER BY m.created_at DESC LIMIT ?`,
      params,
    );
    return rows.map((row) => {
      const group = this.groups.get(row.group_id);
      return { message: this.toMessageView(row), conversationKey: group ? this.conversationKey(group) : "" };
    });
  }

  /** How much of a group's history is indexed locally. Used to explain partial search results. */
  searchCoverage(): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const group of this.groups.values()) {
      total += group.seq;
      done += Math.min(this.syncedSeq(group.id), group.seq);
    }
    return { done, total };
  }

  // --- Sending ---

  private async groupIdForKey(key: string): Promise<string> {
    if (key.startsWith("group:")) {
      const groupId = key.slice(6);
      return groupId;
    }
    const peerId = key.slice(5);
    const existing = this.dmWith(peerId);
    if (existing && existing.epoch > 0 && !existing.removedAt) return existing.id;
    const created = await this.api.createDm(peerId);
    this.applyGroup(created.group);
    return created.group.id;
  }

  private ensureLocalEcho(groupKey: string, id: string, body: MessageBody): MessageView {
    const groupId = this.groupForKey(groupKey)?.id ?? `pending:${groupKey}`;
    const now = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, status, body)
       VALUES(?,?,NULL,0,?,?,0,?,?,?)`,
      [groupId, id, this.account.userId, this.account.deviceId, now, "sending", this.sealJson("message", body)],
    );
    const view = this.toMessageView(this.messageRow(groupId, id)!);
    this.emit({ type: "message", serverId: this.serverId, message: view, isNew: true });
    return view;
  }

  /** What a message says, to forward it: its text, emotes, files and preview, and whose it was. */
  forwardable(groupId: string, id: string): MessageBody & { senderId: string } {
    const row = this.messageRow(groupId, id);
    const body = row ? this.storedBody(row) : null;
    if (!row?.body || !body || row.status !== "sent" || row.deleted_at !== null) throw new Error("That message can't be forwarded.");
    return {
      text: body.text,
      emotes: body.emotes,
      attachments: body.attachments,
      preview: body.preview,
      forwarded: body.forwarded,
      senderId: row.sender_user,
    };
  }

  /**
   * Forwards a message to another conversation on this server, saying whose
   * it was. Its files aren't uploaded again: the copy shares them.
   */
  forwardMessage(groupId: string, id: string, toKey: string): MessageView {
    const { senderId, ...original } = this.forwardable(groupId, id);
    const body: MessageBody = { ...original, forwarded: original.forwarded ?? { userId: senderId } };
    const newId = randomId();
    const view = this.ensureLocalEcho(toKey, newId, body);
    this.enqueue(toKey, { kind: "message", id: newId, body, fileIds: body.attachments?.map((item) => item.fileId) });
    return view;
  }

  /** Sends a message. It appears immediately and survives restarts until delivered. */
  sendMessage(groupKey: string, body: MessageBody): MessageView {
    assertSendable(body);
    const id = randomId();
    const view = this.ensureLocalEcho(groupKey, id, body);
    this.enqueue(groupKey, { kind: "message", id, body });
    return view;
  }

  private enqueue(groupKey: string, entry: OutboxEntry): void {
    this.db.run("INSERT OR REPLACE INTO outbox(id, group_key, kind, payload, created_at) VALUES(?,?,?,?,?)", [
      entry.id,
      groupKey,
      entry.kind,
      this.sealJson("outbox", entry),
      Date.now(),
    ]);
    void this.flushOutbox();
  }

  flushOutbox(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.runOutbox().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async runOutbox(): Promise<void> {
    clearTimeout(this.flushRetry);
    for (;;) {
      const row = this.db.get<{ id: string; group_key: string; payload: Uint8Array }>(
        "SELECT id, group_key, payload FROM outbox ORDER BY created_at LIMIT 1",
      );
      if (!row || this.stopped) return;
      const entry = this.openJson<OutboxEntry>("outbox", row.payload);
      try {
        await this.deliver(row.group_key, entry);
        this.db.run("DELETE FROM outbox WHERE id = ?", [row.id]);
      } catch (error) {
        if (error instanceof ApiError && error.retryable) {
          this.flushRetry = setTimeout(() => void this.flushOutbox(), 5000);
          return;
        }
        console.warn("[zuna] sending failed", error);
        this.db.run("DELETE FROM outbox WHERE id = ?", [row.id]);
        this.markFailed(row.group_key, entry.id);
      }
    }
  }

  private markFailed(groupKey: string, id: string): void {
    const groupId = this.groupForKey(groupKey)?.id ?? `pending:${groupKey}`;
    this.db.run("UPDATE messages SET status = 'failed' WHERE group_id = ? AND id = ?", [groupId, id]);
    const row = this.messageRow(groupId, id);
    if (row) this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(row), isNew: false });
  }

  private markStaleSendsFailed(): void {
    // A send still marked in progress with nothing in the outbox was interrupted
    // by a restart, for example during an upload.
    this.db.run(
      `UPDATE messages SET status = 'failed' WHERE status = 'sending' AND id NOT IN (SELECT id FROM outbox)`,
    );
  }

  private async deliver(groupKey: string, entry: OutboxEntry): Promise<void> {
    if (entry.kind === "edit") {
      await this.withLock(entry.groupId, () =>
        this.sealAndRetry(entry.groupId, async (epoch, key) => {
          const envelope = sealEnvelope(key, this.account.deviceSecret, "message", entry.groupId, entry.id, epoch, entry.body);
          this.ingest(await this.api.editMessage(entry.groupId, entry.id, epoch, envelope), false);
        }),
      );
      return;
    }
    const groupId = await this.groupIdForKey(groupKey);
    await this.withLock(groupId, async () => {
      await this.ensureReady(groupId);
      await this.rotateIfOld(groupId);
      this.moveLocalEcho(groupKey, groupId, entry.id);
      await this.sealAndRetry(groupId, async (epoch, key) => {
        const envelope = sealEnvelope(key, this.account.deviceSecret, "message", groupId, entry.id, epoch, entry.body);
        const saved = await this.api.sendMessage(groupId, {
          id: entry.id,
          epoch,
          envelope,
          file_ids: entry.fileIds?.length ? entry.fileIds : undefined,
        });
        this.ingest(saved, false);
      });
    });
    this.emitConversations();
  }

  /** A DM's first message is echoed before its group exists; this moves it there. */
  private moveLocalEcho(groupKey: string, groupId: string, id: string): void {
    const pending = `pending:${groupKey}`;
    const row = this.messageRow(pending, id);
    if (!row) return;
    this.db.run("UPDATE messages SET group_id = ? WHERE group_id = ? AND id = ?", [groupId, pending, id]);
    this.emit({
      type: "message_moved",
      serverId: this.serverId,
      fromGroupId: pending,
      message: this.toMessageView(this.messageRow(groupId, id)!),
    });
  }

  /** Runs `send` with the current epoch's key, catching up and retrying if we were behind. */
  private async sealAndRetry(groupId: string, send: (epoch: number, key: Uint8Array) => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      if (!this.hasMlsGroup(groupId)) await this.ensureReady(groupId);
      await this.ensureTreeClean(groupId);
      const epoch = this.rememberCurrentEpochKey(groupId);
      const key = this.epochKey(groupId, epoch)!;
      try {
        await send(epoch, key);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.code === "stale_epoch") {
          await this.pullChanges(groupId);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Couldn't catch up with this conversation. Please try again.");
  }

  private async rotateIfOld(groupId: string): Promise<void> {
    const epoch = this.mlsEpoch(groupId);
    const row = this.db.get<{ created_at: number }>("SELECT created_at FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, epoch]);
    if (!row || Date.now() - row.created_at < EPOCH_MAX_AGE_MS) return;
    await this.commitWithRetry(groupId, async () => ({ kind: "update" }));
  }

  retryMessage(groupId: string, id: string): void {
    const row = this.messageRow(groupId, id);
    const body = row ? this.storedBody(row) : null;
    if (!row || row.status !== "failed" || !row.body || !body) return;
    const group = this.groups.get(groupId);
    const key = group ? this.conversationKey(group) : groupId.replace(/^pending:/, "");
    this.db.run("UPDATE messages SET status = 'sending' WHERE group_id = ? AND id = ?", [groupId, id]);
    this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(this.messageRow(groupId, id)!), isNew: false });
    this.enqueue(key, {
      kind: "message",
      id,
      body: { text: body.text, replyTo: body.replyTo, emotes: body.emotes, attachments: body.attachments, mentions: body.mentions },
      fileIds: body.attachments?.map((item) => item.fileId),
    });
  }

  discardMessage(groupId: string, id: string): void {
    this.db.run("DELETE FROM outbox WHERE id = ?", [id]);
    this.db.run("DELETE FROM messages WHERE group_id = ? AND id = ? AND seq IS NULL", [groupId, id]);
    this.emit({ type: "message_removed", serverId: this.serverId, groupId, id });
  }

  editMessage(groupId: string, id: string, text: string, emotes: Record<string, EmoteRef>, mentions: string[]): void {
    const row = this.messageRow(groupId, id);
    const previous = row ? this.storedBody(row) : null;
    if (!row?.body || !previous) return;
    const body: MessageBody = {
      text,
      emotes,
      mentions,
      replyTo: previous.replyTo,
      attachments: previous.attachments,
      // The preview stays while its link does; an edit doesn't fetch a new one.
      preview: previous.preview && linkInText(previous.preview.url, text) ? previous.preview : undefined,
      forwarded: previous.forwarded,
    };
    assertSendable(body);
    this.db.run("UPDATE messages SET body = ?, edited_at = ? WHERE group_id = ? AND id = ?", [
      this.sealJson("message", { ...previous, ...body }),
      Date.now(),
      groupId,
      id,
    ]);
    this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(this.messageRow(groupId, id)!), isNew: false });
    const group = this.groups.get(groupId);
    if (group) this.enqueue(this.conversationKey(group), { kind: "edit", id, groupId, body });
  }

  async deleteMessage(groupId: string, id: string): Promise<void> {
    this.ingest(await this.api.deleteMessage(groupId, id), false);
    this.emitConversations();
  }

  /** Deletes several messages for everyone, in order. */
  async deleteMessages(groupId: string, ids: string[]): Promise<void> {
    for (const id of ids) this.ingest(await this.api.deleteMessage(groupId, id), false);
    this.emitConversations();
  }

  async setPinned(groupId: string, id: string, pinned: boolean): Promise<void> {
    this.ingest(await this.api.pin(groupId, id, pinned), false);
  }

  async toggleReaction(groupId: string, messageId: string, key: string, emote?: EmoteRef): Promise<void> {
    const id = reactionId(this.account.userId, messageId, key);
    const row = this.messageRow(groupId, messageId);
    const current = row ? (this.storedBody(row)?.reactions ?? []) : [];
    const already = current.some((item) => item.key === key && item.userIds.includes(this.account.userId));
    await this.withLock(groupId, async () => {
      if (already) {
        this.ingest(await this.api.removeReaction(groupId, messageId, id), false);
        return;
      }
      await this.sealAndRetry(groupId, async (epoch, epochKey) => {
        const data = sealSignal(epochKey, "reaction", groupId, epoch, { key, emote });
        this.ingest(await this.api.addReaction(groupId, messageId, id, epoch, data), false);
      });
    });
  }

  sendTyping(groupId: string): void {
    const now = Date.now();
    if (now - (this.lastTypingSent.get(groupId) ?? 0) < TYPING_THROTTLE_MS) return;
    if (!this.hasMlsGroup(groupId)) return;
    this.lastTypingSent.set(groupId, now);
    const epoch = this.rememberCurrentEpochKey(groupId);
    const key = this.epochKey(groupId, epoch);
    if (key) this.socket.sendTyping(groupId, sealSignal(key, "typing", groupId, epoch, {}));
  }

  async markRead(groupId: string, seq: number): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group || seq <= group.ownRead || !this.hasMlsGroup(groupId)) return;
    group.ownRead = seq;
    this.persistGroup(group);
    this.emitConversations();
    const epoch = this.rememberCurrentEpochKey(groupId);
    // When receipts are off the position is sealed to our own account key, so
    // our other devices stay in sync while nobody else can read it.
    const receipts = this.prefs.sendReadReceipts;
    const key = receipts ? this.epochKey(groupId, epoch) : this.account.accountKey;
    if (!key) return;
    const sealed = sealSignal(key, "read", groupId, epoch, { seq });
    const framed = new Uint8Array(sealed.length + 1);
    framed[0] = receipts ? 0 : 1;
    framed.set(sealed, 1);
    await this.api.setRead(groupId, framed).catch((error) => console.warn("[zuna] read state", error));
  }

  // --- Files ---

  private async uploadBlob(
    blob: Blob,
    onProgress?: (loaded: number, total: number) => void,
    attach = false,
  ): Promise<{ fileId: string; key: string; prefix: string; chunks: number }> {
    const key = wasm.randomBytes(32);
    const prefix = wasm.randomBytes(15);
    const size = this.files.size(blob);
    const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    const created = await this.api.createFile(chunks, size + chunks * 16);
    let next = 0;
    let loaded = 0;
    const worker = async () => {
      while (next < chunks) {
        const index = next++;
        const start = index * CHUNK_SIZE;
        const plain = await this.files.read(blob, start, Math.min(start + CHUNK_SIZE, size));
        const sealed = wasm.streamSeal(key, prefix, index, index === chunks - 1, plain);
        await this.api.uploadChunk(created.id, index, sealed);
        loaded += plain.length;
        onProgress?.(loaded, size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, chunks) }, worker));
    await this.api.completeFile(created.id, attach);
    return { fileId: created.id, key: toBase64(key), prefix: toBase64(prefix), chunks };
  }

  /** Decrypts a file, verifying that every chunk is present and in order. */
  async downloadFile(ref: { fileId: string; key: string; prefix: string; chunks: number; mime?: string }, onProgress?: (loaded: number, total: number) => void): Promise<Blob> {
    const key = fromBase64(ref.key);
    const prefix = fromBase64(ref.prefix);
    const parts: Uint8Array[] = new Array(ref.chunks);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < ref.chunks) {
        const index = next++;
        const sealed = await this.api.downloadChunk(ref.fileId, index);
        // The server's limit plus a little: this is all held in memory.
        if (sealed.length > CHUNK_SIZE + 256) throw new Error("This file isn't what it should be.");
        parts[index] = wasm.streamOpen(key, prefix, index, index === ref.chunks - 1, sealed);
        done++;
        onProgress?.(done, ref.chunks);
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, ref.chunks) }, worker));
    return this.files.assemble(parts, ref.mime ?? "application/octet-stream");
  }

  /** Uploads attachments, then sends the message. Progress shows on the local echo. */
  async sendWithAttachments(
    groupKey: string,
    files: { blob: Blob; name: string; mime: string; width?: number; height?: number; thumb?: string; duration?: number; voice?: boolean; waveform?: string }[],
    body: MessageBody,
  ): Promise<void> {
    assertSendable(body);
    const id = randomId();
    const totalBytes = files.reduce((sum, file) => sum + this.files.size(file.blob), 0);
    const placeholders: Attachment[] = files.map((file) => ({
      fileId: "",
      key: "",
      prefix: "",
      chunks: 0,
      name: file.name,
      mime: file.mime,
      size: this.files.size(file.blob),
      width: file.width,
      height: file.height,
      thumb: file.thumb,
      duration: file.duration,
      voice: file.voice,
      waveform: file.waveform,
    }));
    const echo = this.ensureLocalEcho(groupKey, id, { ...body, attachments: placeholders });
    const groupId = echo.groupId;

    const limitMb = this.info?.max_upload_mb ?? 100;
    const tooBig = files.find((file) => this.files.size(file.blob) > limitMb * (1 << 20));
    if (tooBig) {
      this.markFailed(groupKey, id);
      throw new Error(`${tooBig.name} is larger than this server's ${limitMb} MB limit.`);
    }

    try {
      const attachments: Attachment[] = [];
      let uploaded = 0;
      for (const [index, file] of files.entries()) {
        const ref = await this.uploadBlob(file.blob, (loaded) => {
          const current = this.messageRow(groupId, id);
          if (!current) return;
          this.emit({
            type: "message",
            serverId: this.serverId,
            message: { ...this.toMessageView(current), uploadProgress: (uploaded + loaded) / Math.max(totalBytes, 1) },
            isNew: false,
          });
        });
        uploaded += this.files.size(file.blob);
        attachments.push({ ...placeholders[index]!, ...ref });
      }
      const finalBody: MessageBody = { ...body, attachments };
      this.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [this.sealJson("message", finalBody), groupId, id]);
      this.enqueue(groupKey, { kind: "message", id, body: finalBody, fileIds: attachments.map((item) => item.fileId) });
    } catch (error) {
      this.markFailed(groupKey, id);
      throw error;
    }
  }

  // --- Profile and account ---

  async updateProfile(changes: Partial<Profile>, avatarBlob?: Blob | null): Promise<void> {
    const self = this.users.get(this.account.userId);
    const profile: Profile = { ...(self?.profile ?? emptyProfile(this.account.username)), ...changes };
    let avatarFile: string | null | undefined = profile.avatar?.fileId ?? null;
    if (avatarBlob) {
      const ref = await this.uploadBlob(avatarBlob);
      profile.avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
      avatarFile = ref.fileId;
    } else if (avatarBlob === null) {
      profile.avatar = null;
      avatarFile = null;
    }
    const sealed = sealProfile(this.account.core.communityKey, this.account.core.identitySecret, this.account.username, profile);
    await this.api.updateMe({ profile: sealed, avatar_file: avatarFile });
  }

  async setHideLastSeen(hide: boolean): Promise<void> {
    await this.api.updateMe({ hide_last_seen: hide });
  }

  getDevices(): DeviceView[] {
    const self = this.users.get(this.account.userId);
    if (!self) return [];
    return [...self.devices.values()]
      .filter((device) => !device.revoked)
      .map((device) => ({
        id: device.id,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        isCurrent: device.id === this.account.deviceId,
        name: this.deviceNames.get(device.id) ?? "Device",
      }))
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.lastSeenAt - a.lastSeenAt);
  }

  /** Removes one of the account's other devices, and its access to every group. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.api.revokeDevice(deviceId);
    const self = await this.ensureUser(this.account.userId, true);
    const device = self?.devices.get(deviceId);
    if (device) device.revoked = true;
    for (const group of this.groups.values()) this.scheduleReconcile(group.id);
  }

  changePassword(current: string, next: string): Promise<void> {
    return changePassword(this.api, this.account.username, this.account.accountKey, current, next);
  }

  regenerateRecoveryKey(current: string): Promise<string> {
    return regenerateRecoveryKey(this.api, this.account.username, this.account.accountKey, current);
  }

  async signOut(): Promise<void> {
    await this.api.logout().catch((error) => console.warn("[zuna] logout", error));
    this.stop();
  }

  // --- Identity verification ---

  safetyCheck(userId: string): SafetyCheck | null {
    const user = this.users.get(userId);
    if (!user) return null;
    return {
      emoji: safetyEmoji(this.account.core.identityPublic, user.identityKey),
      trust: user.trust,
    };
  }

  async markVerified(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    if (user.trust === "changed") {
      this.db.run("UPDATE pinned_identities SET identity_key = ? WHERE user_id = ?", [user.identityKey, userId]);
    }
    this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, user.identityKey]);
    user.trust = "verified";
    this.persistUser(user);
    this.emit({ type: "users", serverId: this.serverId });
    await this.putVault(`verified:${userId}`, user.identityKey).catch((error) => console.warn("[zuna] saving verification", error));
  }

  async clearVerification(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    this.db.run("DELETE FROM verified WHERE user_id = ?", [userId]);
    user.trust = this.trustOf(userId, user.identityKey);
    this.persistUser(user);
    this.emit({ type: "users", serverId: this.serverId });
    await this.putVault(`verified:${userId}`, new Uint8Array(0)).catch(() => undefined);
  }

  // --- Group management ---

  async createGroup(name: string, memberIds: string[], historyVisible: boolean, avatarBlob?: Blob): Promise<string> {
    let avatar: AvatarRef | null = null;
    if (avatarBlob) {
      const ref = await this.uploadBlob(avatarBlob, undefined, true);
      avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
    }
    const created = await this.api.createGroup(historyVisible);
    const groupId = created.group.id;
    this.applyGroup(created.group);
    await this.withLock(groupId, async () => {
      await this.initGroup(created.group, memberIds, { name, avatar });
      this.addSystemRow(groupId, Date.now(), this.account.userId, { type: "group_created", actorId: this.account.userId });
    });
    this.emitConversations();
    return groupId;
  }

  async addMembers(groupId: string, userIds: string[]): Promise<void> {
    await this.withLock(groupId, async () => {
      await this.commitWithRetry(groupId, async () => {
        const group = await this.api.group(groupId);
        this.applyGroup(group);
        const missing = userIds.filter((id) => !group.members.some((member) => member.user_id === id));
        const packages: { deviceId: string; data: Uint8Array }[] = [];
        for (const userId of missing) packages.push(...(await this.claimKeyPackages(userId)));
        if (packages.length === 0) throw new Error("Those people have no devices available to add.");
        let grants: { user_id: string; data: Uint8Array }[] | undefined;
        if (group.history_visible) {
          // Hand older epoch keys to each new member, sealed so that only they can read them.
          grants = [];
          const keys = this.allEpochKeys(groupId);
          for (const userId of missing) {
            const user = await this.ensureUser(userId, true);
            if (!user) continue;
            const apiUser = await this.api.user(userId);
            if (!verifyHpkeKey(this.pinnedIdentity(userId) ?? user.identityKey, user.hpkeKey, decode(apiUser.hpke_key_sig))) continue;
            const signer = { userId: this.account.userId, deviceId: this.account.deviceId };
            grants.push({ user_id: userId, data: sealHistoryGrant(user.hpkeKey, groupId, userId, signer, this.account.deviceSecret, keys) });
          }
        }
        return { kind: "members", keyPackages: packages, addUsers: missing, grants };
      });
      const known = this.knownMembers(groupId);
      for (const id of userIds) known.add(id);
      this.setKnownMembers(groupId, known);
      this.addSystemRow(groupId, Date.now(), this.account.userId, {
        type: "member_added",
        actorId: this.account.userId,
        targetIds: userIds,
      });
    });
    this.emitConversations();
  }

  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.withLock(groupId, async () => {
      await this.commitWithRetry(groupId, async () => ({
        kind: "members",
        removeLeaves: this.treeMembers(groupId)
          .filter((member) => member.userId === userId)
          .map((member) => member.leaf),
        removeUsers: [userId],
      }));
      const known = this.knownMembers(groupId);
      known.delete(userId);
      this.setKnownMembers(groupId, known);
      this.addSystemRow(groupId, Date.now(), this.account.userId, {
        type: "member_removed",
        actorId: this.account.userId,
        targetIds: [userId],
      });
    });
    this.emitConversations();
  }

  async leaveGroup(groupId: string): Promise<void> {
    await this.api.leaveGroup(groupId);
    this.removeGroupLocally(groupId);
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.api.deleteGroup(groupId);
    this.removeGroupLocally(groupId);
  }

  async updateGroupMeta(groupId: string, changes: GroupMeta, avatarBlob?: Blob | null, historyVisible?: boolean): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;
    const meta: GroupMeta = { ...group.meta, ...changes };
    if (avatarBlob) {
      const ref = await this.uploadBlob(avatarBlob, undefined, true);
      meta.avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
    } else if (avatarBlob === null) {
      meta.avatar = null;
    }
    const version = (group.metaVersion ?? 0) + 1;
    await this.withLock(groupId, async () => {
      await this.ensureTreeClean(groupId);
      const epoch = this.rememberCurrentEpochKey(groupId);
      const key = this.epochKey(groupId, epoch)!;
      await this.api.setGroupMeta(groupId, this.sealGroupDetails(groupId, key, epoch, meta, version), epoch, historyVisible);
    });
    const current = this.groups.get(groupId) ?? group;
    current.meta = meta;
    current.metaVersion = version;
    this.persistGroup(current);
    this.emitConversations();
  }

  async setGroupRole(groupId: string, userId: string, role: GroupRole): Promise<void> {
    await this.api.setGroupRole(groupId, userId, role);
  }

  // --- Emotes ---

  async refreshEmotes(): Promise<void> {
    const set = await this.api.emotes();
    // Only ones with an ID that can go in an address, as the app asks the server for each picture.
    set.emotes = (Array.isArray(set.emotes) ? set.emotes : []).filter((emote) => parseEmoteRef(emote) && typeof emote.name === "string");
    this.emoteSet = set;
    this.setKv("emotes", set);
    this.emit({ type: "emotes", serverId: this.serverId });
  }

  getEmotes(): EmoteSet {
    return this.emoteSet;
  }

  emoteUrl(id: string, size: 1 | 2 | 3 | 4 = 2): string {
    return this.api.emoteUrl(id, size);
  }

  /** The emotes used in a text, recorded so a message keeps rendering if the set changes. */
  emotesIn(text: string): Record<string, EmoteRef> {
    const byName = new Map<string, Emote>(this.emoteSet.emotes.map((emote) => [emote.name, emote]));
    const out: Record<string, EmoteRef> = {};
    for (const word of text.split(/\s+/)) {
      const emote = byName.get(word);
      if (emote) out[word] = { id: emote.id, animated: emote.animated, zeroWidth: emote.zero_width, owner: emote.owner };
    }
    return out;
  }

  // --- Administration ---

  invites(): Promise<Invite[]> {
    return this.api.invites();
  }

  async createInvite(maxUses: number, expiresInSeconds: number): Promise<string> {
    const { code } = await this.api.createInvite(maxUses, expiresInSeconds);
    return inviteLink(this.account.serverUrl, code, this.account.core.communityKey);
  }

  linkForInvite(code: string): string {
    return inviteLink(this.account.serverUrl, code, this.account.core.communityKey);
  }

  revokeInvite(code: string): Promise<unknown> {
    return this.api.revokeInvite(code);
  }

  async updateServerSettings(body: Record<string, unknown>): Promise<void> {
    // Open sign-ups have no invite link to carry the key, so an admin who turns
    // them on is choosing to hand the community key to the server.
    if (body.registration === "open") {
      body = { ...body, community_key: toBase64Url(this.account.core.communityKey) };
    }
    await this.api.updateSettings(body);
  }

  async updateServerIcon(image: Blob): Promise<unknown> {
    return this.api.updateIcon(await this.files.read(image, 0, this.files.size(image)));
  }

  setEmoteSet(set: string): Promise<{ set_id: string; set_name: string; count: number }> {
    return this.api.setEmoteSet(set);
  }

  setServerRole(userId: string, role: "admin" | "member"): Promise<unknown> {
    return this.api.setRole(userId, role);
  }

  banUser(userId: string): Promise<unknown> {
    return this.api.ban(userId);
  }

  unbanUser(userId: string): Promise<unknown> {
    return this.api.unban(userId);
  }

  serverUrl(): string {
    return this.account.serverUrl;
  }
}
