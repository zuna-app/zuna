// A live session with one server: everything between the UI and the network.
//
// The rule that keeps this reliable: all MLS operations on a group run one at a
// time under that group's lock, and commits are only applied in server order.
// Any device whose state can't be repaired by that simply rejoins the group
// with an external commit, so a bad state never ends a conversation.

import * as wasm from "@zuna/crypto";
import {
  Api,
  ApiError,
  decode,
  encodeBody,
  type ApiAccount,
  type ApiDevice,
  type ApiEvent,
  type ApiGroup,
  type ApiLink,
  type ApiMessage,
  type ApiReaction,
  type ApiUser,
} from "./api";
import {
  changePassword,
  inviteLink,
  planPasswordChange,
  planRecoveryChange,
  regenerateRecoveryKey,
  upgradeSignInKey,
  type AccountState,
} from "./account";
import {
  CONTENT_LABEL,
  coreFromJson,
  coreToJson,
  createCertificate,
  frameSigned,
  namesItsSender,
  openEnvelope,
  openHistoryGrant,
  openProfile,
  openProfileAtGeneration,
  openSignal,
  openVaultCore,
  openVaultItem,
  parseCertificate,
  randomId,
  reactionId,
  readSigned,
  readSignedGroupDetails,
  safetyEmoji,
  sealEnvelope,
  sealHistoryGrant,
  sealProfile,
  sealSignal,
  sealVaultCore,
  sealVaultItem,
  signGroupDetails,
  signHpkeKey,
  signProfileAtGeneration,
  signalEpoch,
  verifyCertificate,
  verifyCertificateAtGeneration,
  verifyHpkeKey,
  type DeviceCertificate,
  type VaultCore,
} from "./crypto";
import {
  ACCOUNT_PROTOCOL,
  buildLink,
  carries,
  keyCommitment,
  openBundle,
  planFromJson,
  planToJson,
  readHeldLink,
  rootHash,
  sealBridge,
  sealBundle,
  sealToSlot,
  signSealKey,
  signSealProof,
  slotsHash,
  verifyEnrollment,
  verifyLink,
  verifySealKey,
  verifySealProof,
  type Link,
  type LinkDevice,
  type RotationPlan,
  type SignedLink,
  type SlotKind,
} from "./generations";
import { equalBytes, fromBase64, fromUtf8, toBase64, toBase64Url, u64Bytes, utf8 } from "./encoding";
import type { LocalDb, SqlValue } from "./db";
import { blobFiles, type FileAdapter } from "./files";
import { linkInText } from "./links";
import { MEDIA_KINDS, mediaIn } from "./media";
import { notificationText, previewText } from "./notify";
import { SEARCH_INDEX_VERSION, indexTokens, mediaTag, queryTokens } from "./search";
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
  LinkPreview,
  MediaCounts,
  MediaKind,
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
/** How often a claim of someone's key packages is tried while the server says to slow down, and how far apart: it allows one every 2 seconds then. */
const CLAIM_ATTEMPTS = 6;
const CLAIM_WAIT_MS = 2100;
/** How long a message waits for its link's preview before it goes without one. */
const PREVIEW_WAIT_MS = 4000;
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
/** Past this, the time a device signed and the time the server says it got the message look wrong. */
const TIME_DIFFERS_MS = 24 * 3600 * 1000;
const SEARCH_REBUILD_BATCH = 200;
const VAULT_BATCH = 200;
/** The vault item that lists every pin and verification this account holds, and its preferences. */
const MANIFEST_ID = "manifest";
/** Past this, a manifest wouldn't fit in a vault item, and pins and verifications travel only one by one. */
const MAX_MANIFEST_BYTES = 200 << 10;
const DB_LABEL = (name: string) => utf8(`zuna/local/${name}`);
/** Keeps changes to this account's keys one at a time. Group IDs are hex, so it can't be one of those. */
const ACCOUNT_LOCK = "account";
const ROTATION_INTENT = "rotation_intent";
const ROTATION_ATTEMPTS = 6;
/** After this long failing to rotate, the person is told. */
const ROTATION_STUCK_MS = 24 * 3600 * 1000;
const MAX_REMOVAL_ROTATIONS = 5;
const REMOVAL_ROTATION_WINDOW_MS = 3600 * 1000;
/** Enough for anyone to have heard about a rotation by the time a key is forgotten, in a core with a size limit. */
const OLDER_HPKE_KEPT = 16;
/** A device that has held a leaf this long, as this device saw it, has continuity with what came before. */
const CONTINUITY_MS = 7 * 24 * 3600 * 1000;

/** How long things wait before a rotation. Tests shorten these. */
export const rotationTiming = {
  /** Removals close together share one rotation. */
  gatherMs: 2000,
  /** Another device takes over after up to this long, if nobody has rotated by then. */
  takeoverMs: 30_000,
  retryMs: 60_000,
};

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
  /** Its certificate is from a client that doesn't know about generations. */
  legacy?: boolean;
  /** As the server said, and for whoever uses them to check. */
  enrollProof?: string | null;
  sealKey?: string | null;
  sealSig?: string | null;
}

/** A rotation under way, kept so a crash can finish it with the same keys. */
interface RotationIntent {
  generation: number;
  /** As it's sent, so sending it again is the same request. */
  request: { link: { payload: string; by_prev: string; by_new: string; by_device: string } } & Record<string, unknown>;
  accountKey: string;
  core: ReturnType<typeof coreToJson>;
  /** What it's for besides new keys, to do again if another rotation gets in first. */
  plan: ReturnType<typeof planToJson>;
  once: boolean;
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
  createdAt: number;
  members: GroupMemberView[];
  readStates: Record<string, string | null>;
  readBy: Record<string, number>;
  ownRead: number;
  /** When the server said this device's person is no longer in this conversation. */
  removedAt?: number | null;
  /** People the server says left, not yet shown, until MLS confirms their keys are gone. */
  pendingRemovals?: Record<string, { actor: string; seq: number; at: number }>;
  /** A DM the server listed more than two people in, seen before anyone's known to be its other person. It's not used. */
  doubtful?: boolean;
}

/** One leaf of a group's MLS tree, and whether it really is the device it says. */
interface TreeMember {
  leaf: number;
  /** Who its certificate names, which proves nothing unless `genuine`. */
  userId: string;
  deviceId: string;
  /** Its certificate is signed by that person's identity key, for the signing key it really uses. */
  genuine: boolean;
  /** No key is known for that person yet, so nothing has been checked. It isn't genuine, but it isn't caught out either. */
  unchecked?: boolean;
  /** In a DM, someone who isn't one of its two people. */
  outsider?: boolean;
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
  unproven_delete_at: number | null;
}

interface StoredBody extends MessageBody {
  reactions?: ReactionView[];
  system?: SystemEvent;
  rawReactions?: ApiReaction[];
}

type OutboxEntry =
  /** `previewUrl`: the link whose preview was still being made when the message was sent. */
  | { kind: "message"; id: string; body: MessageBody; fileIds?: string[]; previewUrl?: string }
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

/** The vault's manifest: every pin and verification, by user, as base64 keys, an empty one for a cleared verification. */
interface TrustManifest {
  v: number;
  pins: Record<string, string>;
  verified: Record<string, string>;
  prefs?: unknown;
}

function parseManifest(value: unknown): TrustManifest | null {
  const manifest = value as Partial<TrustManifest> | null;
  const keys = (record: unknown): record is Record<string, string> =>
    !!record && typeof record === "object" && Object.values(record).every((key) => typeof key === "string");
  if (!manifest || !Number.isSafeInteger(manifest.v) || manifest.v! < 1 || !keys(manifest.pins) || !keys(manifest.verified)) return null;
  return { v: manifest.v!, pins: manifest.pins, verified: manifest.verified, prefs: manifest.prefs };
}

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

const signedFromApi = (wire: ApiLink): SignedLink => ({
  payload: decode(wire.payload),
  byPrev: decode(wire.by_prev),
  byNew: decode(wire.by_new),
  byDevice: decode(wire.by_device),
});

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
  /** The keyed name of each kind in the local index of what messages hold. */
  private mediaTags: Map<MediaKind, string>;
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
  private manifest: TrustManifest | null = null;
  private manifestWrite: Promise<void> = Promise.resolve();
  private resealing = new Set<string>();
  /** Each person's chain of identity keys as far as it's been checked, oldest first. */
  private chains = new Map<string, Link[]>();
  private following = new Map<string, Promise<void>>();
  /** The newest key of a chain that disagrees with the one held, for comparing with its owner. */
  private forkHeads = new Map<string, Uint8Array>();
  /** A device of this account is gone and no generation covers that yet. */
  private removalsUncovered = false;
  private rotationOpen = false;
  private rotationTimer: ReturnType<typeof setTimeout> | undefined;
  private sealingTimer: ReturnType<typeof setTimeout> | undefined;
  private sealing = false;
  /** Removals from before this server kept generations are nobody's cue to rotate. */
  private protocolSince: number | null = null;
  /** Called when the server told us this session is over (banned, revoked). */
  onSignedOut: ((reason: string) => void) | null = null;
  /** Called when a session that seemed to be over turns out to be working. */
  onSignedIn: (() => void) | null = null;
  /** Called with what has to be kept for next time, when it changes. */
  onAccountChanged: ((account: AccountState) => void) | null = null;

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
    this.mediaTags = new Map(MEDIA_KINDS.map((kind) => [kind, mediaTag(this.searchKey, kind)]));

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
    this.forgetUnprovenDeletions();
    void this.rebuildSearchIndex();
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
    clearTimeout(this.rotationTimer);
    clearTimeout(this.sealingTimer);
    this.rotationTimer = undefined;
    this.sealingTimer = undefined;
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
    this.noticeProtocol();
    if ((this.info.request_proofs ?? 0) >= 1 && !this.api.prove) {
      const { deviceSecret } = this.account;
      this.api.prove = (input) => wasm.sign(deviceSecret, input);
      // Once this device has signed a request, its session token alone can't remove devices, delete or act as an admin.
      await this.api.proveDevice().catch((error) => console.warn("[zuna] signing as this device", error));
    }
    // Which keys are current comes first of all, since the vault opens with them.
    // Not being able to tell is no reason to stop the messages from coming.
    await this.syncAccount().catch((error) => {
      if (error instanceof ApiError && error.status === 401) throw error;
      console.warn("[zuna] catching up on this account's keys", error);
    });
    // The vault comes next: it holds the keys this account already trusts,
    // which a new device must have before believing what the server says.
    await this.syncVault();
    this.checkManifestFloor();
    await this.syncUsers();
    await this.uploadPins();
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
    // This account's own key comes from its vault, never from what the server says.
    this.db.run("INSERT OR IGNORE INTO pinned_identities(user_id, identity_key, uploaded) VALUES(?, ?, 1)", [this.account.userId, this.account.core.rootPublic]);
    this.loadChains();
    this.rotationOpen = this.getKv<RotationIntent>(ROTATION_INTENT) !== null;
    this.protocolSince = this.getKv<number>("protocol_since");
    this.prefs = { ...this.prefs, ...(this.getKv<Preferences>("prefs") ?? {}) };
    this.manifest = this.getKv<TrustManifest>("manifest");
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
    for (const user of response.users) {
      if (user.id !== this.account.userId && (user.key_generation ?? 0) > this.headGeneration(user.id)) await this.followChain(user.id);
    }
    this.usersCursor = response.now - 5000;
    this.setKv("users_cursor", this.usersCursor);
    this.emit({ type: "users", serverId: this.serverId });
  }

  private pinnedIdentity(userId: string): Uint8Array | null {
    const row = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM pinned_identities WHERE user_id = ?", [userId]);
    return row?.identity_key ?? null;
  }

  /** The key this account verified for someone, if it has. Clearing it leaves an empty one. */
  private verifiedIdentity(userId: string): Uint8Array | null {
    const key = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM verified WHERE user_id = ?", [userId])?.identity_key;
    return key && key.length > 0 ? key : null;
  }

  private trustOf(userId: string, current: Uint8Array): TrustState {
    const pinned = this.pinnedIdentity(userId);
    if (pinned && !equalBytes(pinned, current)) return "changed";
    if (this.identityState(userId).forked) return "changed";
    const verified = this.verifiedIdentity(userId);
    if (!verified) return "unverified";
    if (!equalBytes(verified, current)) return "changed";
    // What was verified may since have been replaced, by someone who may have stolen it.
    return this.identityState(userId).trust_generation >= this.headGeneration(userId) ? "verified" : "unverified";
  }

  /**
   * Trust on first use: the first identity key seen for a user is pinned. A later
   * change to that first key means the server is lying or the account was replaced,
   * which gets a loud warning. Keys an account moves on to come as a chain from that
   * first one (see followChain). Pins and verifications are shared through the
   * vault, so a new device already knows what this account's other devices do.
   */
  private applyUser(api: ApiUser): CachedUser {
    const identityKey = decode(api.identity_key);
    const isSelf = api.id === this.account.userId;
    // Someone this account has verified is pinned to that key, whatever the server says now.
    const pinned = isSelf ? this.account.core.rootPublic : (this.pinnedIdentity(api.id) ?? this.verifiedIdentity(api.id));
    if (!this.pinnedIdentity(api.id)) {
      this.db.run("INSERT INTO pinned_identities(user_id, identity_key, uploaded) VALUES(?, ?, 0)", [api.id, pinned ?? identityKey]);
    }
    const previous = this.users.get(api.id);
    const changedNow = !!pinned && !equalBytes(pinned, identityKey) && previous?.trust !== "changed";
    const trustedKey = pinned ?? identityKey;

    const devices = new Map<string, CachedDevice>();
    for (const device of api.devices) {
      const certificate = decode(device.certificate);
      const standing = this.certificateStanding(api.id, trustedKey, certificate);
      if (!standing) {
        // From a generation this device hasn't got to yet, as far as it knows still the same device.
        const known = previous?.devices.get(device.id);
        if (known && (parseCertificate(certificate)?.generation ?? 0) > this.headGeneration(api.id)) devices.set(device.id, known);
        continue;
      }
      if (standing.cert.userId !== api.id || standing.cert.deviceId !== device.id) continue;
      // Certificates from an older generation only mean something if their device was
      // known before that generation ended. Someone with no history here can't tell.
      if (!standing.carried && previous && !previous.devices.has(device.id)) continue;
      devices.set(device.id, {
        id: device.id,
        signatureKey: standing.cert.signatureKey,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        revoked: device.revoked_at != null || !standing.carried,
        legacy: !standing.headSignature,
        enrollProof: device.enroll_proof ?? null,
        sealKey: device.seal_key ?? null,
        sealSig: device.seal_sig ?? null,
      });
    }

    if (isSelf) {
      for (const device of api.devices) {
        const key = devices.get(device.id)?.signatureKey;
        if (key && device.id !== this.account.deviceId) this.sealKeyOf(device, key);
      }
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

    const head = this.headOf(api.id);
    const opened = !api.profile
      ? null
      : head
        ? parseProfile(openProfileAtGeneration<unknown>(this.account.core.communityKey, head.identity, api.id, api.username, head.gen, decode(api.profile), decode(api.profile_sig)))
        : parseProfile(openProfile<unknown>(this.account.core.communityKey, trustedKey, api.username, decode(api.profile)));
    const user: CachedUser = {
      id: api.id,
      username: api.username,
      role: api.role,
      identityKey,
      hpkeKey: head?.hpke ?? decode(api.hpke_key),
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
    if (isSelf) {
      this.checkRemovals(api);
    } else if ((api.key_generation ?? 0) > this.headGeneration(api.id)) {
      void this.followChain(api.id).catch((error) => console.warn("[zuna] following a chain of keys", error));
    }
    return user;
  }

  private async ensureUser(userId: string, refresh = false): Promise<CachedUser | null> {
    if (!refresh) {
      const cached = this.users.get(userId);
      if (cached) return cached;
    }
    try {
      const api = await this.api.user(userId);
      const user = this.applyUser(api);
      if (userId === this.account.userId || (api.key_generation ?? 0) <= this.headGeneration(userId)) return user;
      await this.followChain(userId);
      return this.users.get(userId) ?? user;
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
    fetching: for (;;) {
      const items = this.modern ? await this.api.vaultItemsAtAnyGeneration(cursor) : await this.api.vaultItems(cursor);
      if (items.length === 0) break;
      for (const item of items) {
        const generation = item.generation ?? 0;
        // Sealed under a key this device doesn't have yet, so it stays unread until then.
        if (generation > this.account.core.generation) {
          this.syncAccountSoon();
          break fetching;
        }
        cursor = Math.max(cursor, item.seq);
        const key = this.vaultKeyFor(item.id, generation);
        if (!key) continue;
        let data: Uint8Array;
        try {
          data = openVaultItem(key, item.id, decode(item.data), generation);
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
        } else if (item.id === MANIFEST_ID) {
          this.applyManifest(data);
        } else if (item.id === "prefs") {
          // A manifest's copy is the current one. This item may be an older one, served again.
          if (this.manifest) continue;
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
          // The same goes for a verification the manifest lists.
          if (this.manifest && userId in this.manifest.verified) continue;
          this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, data]);
          // The person accepted this key on another device, so it's the one to expect here too.
          if (data.length > 0) this.db.run("INSERT OR REPLACE INTO pinned_identities(user_id, identity_key, uploaded) VALUES(?, ?, 1)", [userId, data]);
          this.refreshTrust(userId);
        } else if (item.id.startsWith("pin:")) {
          const userId = item.id.slice("pin:".length);
          this.db.run("INSERT OR IGNORE INTO pinned_identities(user_id, identity_key, uploaded) VALUES(?, ?, 1)", [userId, data]);
          this.refreshTrust(userId);
        } else if (item.id.startsWith("device:")) {
          this.deviceNames.set(item.id.slice("device:".length), fromUtf8(data));
          this.setKv("device_names", Object.fromEntries(this.deviceNames));
        } else if (item.id.startsWith("chain:")) {
          this.noteChainPosition(item.id.slice("chain:".length), data);
        } else if (item.id.startsWith("trust:")) {
          this.noteVerifiedPosition(item.id.slice("trust:".length), data);
        }
      }
      this.setKv("vault_cursor", cursor);
    }
    for (const groupId of touchedGroups) this.retryUndecryptable(groupId);
  }

  private refreshTrust(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    const trust = this.trustOf(userId, user.identityKey);
    if (trust === "changed" && user.trust !== "changed") {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: `The security key of ${user.profile.displayName} doesn't match the one your account knows. Their messages can't be trusted until you verify them again.`,
      });
    }
    user.trust = trust;
    this.persistUser(user);
  }

  /**
   * The key an item of this generation opens with, if it's to be believed at all.
   * Old keys may be in the wrong hands, so what decides who this account trusts is
   * only ever read at the current generation. Epoch keys only ever fill gaps, so
   * they can wait to be sealed again, until the generation closes.
   */
  private vaultKeyFor(id: string, generation: number): Uint8Array | null {
    const { accountKey, core } = this.account;
    if (generation === core.generation) return accountKey;
    if (generation < core.closedBelow || !id.startsWith("ek:")) return null;
    return core.olderKeys[generation] ?? null;
  }

  /** Puts items in the vault, unless this isn't the time. Returns whether it did. */
  private async putItems(items: { id: string; data: Uint8Array }[]): Promise<boolean> {
    const { accountKey, core } = this.account;
    const sealed = items.map(({ id, data }) => ({ id, data: sealVaultItem(accountKey, id, data, core.generation) }));
    if (!this.modern) {
      await this.api.putVaultItems(sealed);
      return true;
    }
    if (this.removalsUncovered || this.rotationOpen) return false;
    try {
      await this.api.putVaultItemsAt(core.generation, sealed);
      return true;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "stale_generation") throw error;
      this.syncAccountSoon();
      return false;
    }
  }

  private async putVault(id: string, data: Uint8Array): Promise<void> {
    await this.putItems([{ id, data }]);
  }

  /** Shares the keys pinned here with this account's other devices, a batch at a time. */
  private async uploadPins(): Promise<void> {
    for (;;) {
      const rows = this.db.all<{ user_id: string; identity_key: Uint8Array }>(
        "SELECT user_id, identity_key FROM pinned_identities WHERE uploaded = 0 LIMIT ?",
        [VAULT_BATCH],
      );
      if (rows.length === 0) break;
      const stored = await this.putItems(rows.map((row) => ({ id: `pin:${row.user_id}`, data: row.identity_key })));
      if (!stored) return;
      this.db.transaction(() => {
        for (const row of rows) this.db.run("UPDATE pinned_identities SET uploaded = 1 WHERE user_id = ?", [row.user_id]);
      });
    }
    if (this.manifestBehind()) await this.writeManifest();
    await this.uploadChainPositions();
  }

  // --- Vault manifest ---

  /**
   * Which items a device gets from the vault is the server's choice, and an older
   * copy of an item still opens. So one item, the manifest, holds every pin and
   * verification and the preferences, with a number only ever raised. Withholding
   * one pin or verification then does nothing, a device that has seen a manifest
   * refuses an older one, and each rotation seals the number into the vault core,
   * so a new device knows how far back is too far.
   */
  private applyManifest(data: Uint8Array): void {
    let manifest: TrustManifest | null;
    try {
      manifest = parseManifest(JSON.parse(fromUtf8(data)));
    } catch {
      manifest = null;
    }
    if (!manifest) return;
    const held = this.manifest?.v ?? 0;
    if (manifest.v < held) {
      this.warnOnce(`manifest/${manifest.v}`, "The server sent an older copy of the keys your account trusts. It was ignored.");
      return;
    }
    // Two devices writing at once give the same number, so the same number can still be news.
    if (manifest.v === held && JSON.stringify(manifest) === JSON.stringify(this.manifest)) return;
    // Only who changes needs their trust worked out again: a manifest lists everyone.
    const touched = new Set<string>();
    this.db.transaction(() => {
      for (const [userId, encoded] of Object.entries(manifest.verified)) {
        const key = fromBase64(encoded);
        const before = this.db.get<{ identity_key: Uint8Array }>("SELECT identity_key FROM verified WHERE user_id = ?", [userId])?.identity_key;
        if (before && equalBytes(before, key)) continue;
        this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, key]);
        if (key.length > 0) this.db.run("INSERT OR REPLACE INTO pinned_identities(user_id, identity_key, uploaded) VALUES(?, ?, 1)", [userId, key]);
        touched.add(userId);
      }
      for (const [userId, encoded] of Object.entries(manifest.pins)) {
        if (this.pinnedIdentity(userId)) continue;
        this.db.run("INSERT INTO pinned_identities(user_id, identity_key, uploaded) VALUES(?, ?, 1)", [userId, fromBase64(encoded)]);
        touched.add(userId);
      }
    });
    for (const [userId, encoded] of Object.entries(manifest.pins)) {
      const pinned = this.pinnedIdentity(userId);
      // Two devices of one account holding different keys for someone means one was shown a key that isn't theirs.
      if (pinned && !equalBytes(pinned, fromBase64(encoded)) && !(userId in manifest.verified)) {
        const name = this.users.get(userId)?.profile.displayName || "someone";
        this.warnOnce(`pin/${userId}`, `Another of your devices holds a different security key for ${name}. Compare emoji with them before trusting their messages.`, userId);
      }
    }
    this.manifest = manifest;
    this.setKv("manifest", manifest);
    if (manifest.prefs) {
      this.prefs = { ...this.prefs, ...parsePreferences(manifest.prefs) };
      this.setKv("prefs", this.prefs);
      this.emit({ type: "preferences", serverId: this.serverId });
      this.watchMutes();
      this.resendPush();
    }
    for (const userId of touched) this.refreshTrust(userId);
  }

  /** Whether this device holds a pin or verification the manifest doesn't list as it is here. */
  private manifestBehind(): boolean {
    const manifest = this.manifest;
    if (!manifest) return true;
    const pins = this.db.all<{ user_id: string }>("SELECT user_id FROM pinned_identities");
    if (pins.some((row) => !(row.user_id in manifest.pins))) return true;
    const verified = this.db.all<{ user_id: string; identity_key: Uint8Array }>("SELECT user_id, identity_key FROM verified");
    return verified.some((row) => manifest.verified[row.user_id] !== toBase64(row.identity_key));
  }

  /** Writes what this device holds as the next manifest, one at a time. */
  private writeManifest(): Promise<void> {
    this.manifestWrite = this.manifestWrite
      .then(async () => {
        const entries = (rows: { user_id: string; identity_key: Uint8Array }[]) => Object.fromEntries(rows.map((row) => [row.user_id, toBase64(row.identity_key)]));
        const manifest: TrustManifest = {
          v: (this.manifest?.v ?? 0) + 1,
          pins: entries(this.db.all("SELECT user_id, identity_key FROM pinned_identities ORDER BY user_id")),
          verified: entries(this.db.all("SELECT user_id, identity_key FROM verified ORDER BY user_id")),
          prefs: this.prefs,
        };
        const data = utf8(JSON.stringify(manifest));
        if (data.length > MAX_MANIFEST_BYTES || !(await this.putItems([{ id: MANIFEST_ID, data }]))) return;
        this.manifest = manifest;
        this.setKv("manifest", manifest);
      })
      .catch((error) => console.warn("[zuna] saving the manifest", error));
    return this.manifestWrite;
  }

  /** A new device shown less than the vault core says the manifest had reached was shown an older copy, or none. */
  private checkManifestFloor(): void {
    const floor = this.account.core.manifest ?? 0;
    if (floor > (this.manifest?.v ?? 0)) {
      this.warnOnce("manifest/floor", "Not everything your account trusts arrived from the server, so people you've verified may show as unverified here. Compare emoji with them again before trusting them.");
    }
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
    const items = rows.map((row) => ({ id: `ek:${row.group_id}:${row.epoch}`, data: this.openLocal("epoch", row.key) }));
    if (!(await this.putItems(items))) return;
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
    const grants = this.modern ? await this.api.historyGrantsAtAnyGeneration() : await this.api.historyGrants();
    for (const grant of grants) {
      const joined = this.joinedEpoch(grant.group_id);
      // Kept until this device is in the group and can tell what it may fill in.
      if (joined === null) continue;
      try {
        const opened = this.openGrant(grant.group_id, decode(grant.data));
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

  /** Someone who hasn't heard about a rotation yet may have sealed this to an older key. */
  private openGrant(groupId: string, sealed: Uint8Array): ReturnType<typeof openHistoryGrant> {
    const { core, userId } = this.account;
    for (const secret of core.olderHpkeSecrets) {
      try {
        return openHistoryGrant(secret, groupId, userId, sealed);
      } catch {
        // Not this one.
      }
    }
    return openHistoryGrant(core.hpkeSecret, groupId, userId, sealed);
  }

  private async grantAuthentic(groupId: string, grant: ReturnType<typeof openHistoryGrant>): Promise<boolean> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    if (group.members.find((member) => member.user_id === grant.signer.userId)?.role !== "admin") return false;
    const device = (await this.ensureUser(grant.signer.userId, true))?.devices.get(grant.signer.deviceId);
    return !!device && grant.signedBy(device.signatureKey);
  }

  // --- Account generations ---

  /** Whether this server keeps generations of account keys. */
  private get modern(): boolean {
    return (this.info?.account_protocol ?? (this.info ? 0 : (this.account.protocol ?? 0))) >= ACCOUNT_PROTOCOL;
  }

  private saveAccount(): void {
    this.onAccountChanged?.(this.account);
  }

  /** Remembers that this server keeps generations. If it says later that it doesn't, that gets said. */
  private noticeProtocol(): void {
    if (this.modern && !this.account.protocol) {
      this.account = { ...this.account, protocol: ACCOUNT_PROTOCOL };
      this.saveAccount();
    } else if (!this.modern && this.account.protocol && !this.getKv<boolean>("protocol_gone")) {
      this.setKv("protocol_gone", true);
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: "",
        message: "This server stopped supporting the way Zuna replaces your account's keys. It may have been changed to an older version.",
      });
    }
  }

  private loadChains(): void {
    for (const row of this.db.all<{ user_id: string; payload: Uint8Array; by_prev: Uint8Array; by_new: Uint8Array; by_device: Uint8Array }>(
      "SELECT user_id, payload, by_prev, by_new, by_device FROM identity_chain ORDER BY user_id, generation",
    )) {
      const link = readHeldLink({ payload: row.payload, byPrev: row.by_prev, byNew: row.by_new, byDevice: row.by_device });
      if (link) this.chains.set(row.user_id, [...this.chainOf(row.user_id), link]);
    }
  }

  private chainOf(userId: string): Link[] {
    return this.chains.get(userId) ?? [];
  }

  private headOf(userId: string): Link | null {
    return this.chainOf(userId).at(-1) ?? null;
  }

  private headGeneration(userId: string): number {
    return this.headOf(userId)?.gen ?? 0;
  }

  /**
   * Whether a certificate counts for someone: it's signed by their identity key of
   * the generation it names, and if that's an older one, by the first key if it's
   * from the very beginning, its device has been on the list of every link since.
   * That list is what makes a certificate someone signs later with a stolen old key
   * worth nothing. Null if it isn't signed, or is from further along than is known.
   */
  private certificateStanding(userId: string, root: Uint8Array, certificate: Uint8Array): { cert: DeviceCertificate; carried: boolean; headSignature: boolean } | null {
    const parsed = parseCertificate(certificate);
    if (!parsed) return null;
    const chain = this.chainOf(userId);
    if (parsed.generation > chain.length) return null;
    const cert = parsed.generation === 0 ? verifyCertificate(root, certificate) : verifyCertificateAtGeneration(chain[parsed.generation - 1]!.identity, certificate);
    if (!cert) return null;
    const device = { id: parsed.deviceId, key: parsed.signatureKey };
    return { cert, carried: chain.slice(parsed.generation).every((link) => carries(link, device)), headSignature: !!parsed.headSignature };
  }

  private identityState(userId: string): { forked: number; known_generation: number; known_hash: Uint8Array | null; trust_generation: number } {
    return (
      this.db.get("SELECT forked, known_generation, known_hash, trust_generation FROM identity_state WHERE user_id = ?", [userId]) ?? {
        forked: 0,
        known_generation: 0,
        known_hash: null,
        trust_generation: 0,
      }
    );
  }

  private updateIdentityState(userId: string, sql: string, params: SqlValue[]): void {
    this.db.run("INSERT OR IGNORE INTO identity_state(user_id) VALUES(?)", [userId]);
    this.db.run(`UPDATE identity_state SET ${sql} WHERE user_id = ?`, [...params, userId]);
  }

  private setVerifiedPosition(userId: string, generation: number): void {
    this.updateIdentityState(userId, "trust_generation = ?, trust_uploaded = 0", [generation]);
  }

  /** What a sibling device says it has reached on someone's chain. Two versions of it means trouble. */
  private noteChainPosition(userId: string, data: Uint8Array): void {
    let position: { gen: number; hash: string };
    try {
      position = JSON.parse(fromUtf8(data));
      if (!Number.isSafeInteger(position.gen) || typeof position.hash !== "string") return;
    } catch {
      return;
    }
    const held = this.chainOf(userId)[position.gen - 1];
    const expected = fromBase64(position.hash);
    if (held) {
      if (!equalBytes(held.hash, expected)) void this.noteFork(userId);
    } else if (position.gen > this.identityState(userId).known_generation) {
      this.updateIdentityState(userId, "known_generation = ?, known_hash = ?", [position.gen, expected]);
    }
  }

  private noteVerifiedPosition(userId: string, data: Uint8Array): void {
    let position: { gen: number };
    try {
      position = JSON.parse(fromUtf8(data));
      if (!Number.isSafeInteger(position.gen)) return;
    } catch {
      return;
    }
    if (position.gen <= this.identityState(userId).trust_generation) return;
    this.updateIdentityState(userId, "trust_generation = ?", [position.gen]);
    this.refreshTrust(userId);
  }

  private async uploadChainPositions(): Promise<void> {
    const rows = this.db.all<{ user_id: string; chain_uploaded: number; trust_uploaded: number; trust_generation: number }>(
      "SELECT user_id, chain_uploaded, trust_uploaded, trust_generation FROM identity_state WHERE chain_uploaded = 0 OR trust_uploaded = 0 LIMIT ?",
      [VAULT_BATCH],
    );
    if (rows.length === 0) return;
    const items: { id: string; data: Uint8Array }[] = [];
    for (const row of rows) {
      const head = this.headOf(row.user_id);
      if (!row.chain_uploaded && head) items.push({ id: `chain:${row.user_id}`, data: utf8(JSON.stringify({ gen: head.gen, hash: toBase64(head.hash) })) });
      if (!row.trust_uploaded) items.push({ id: `trust:${row.user_id}`, data: utf8(JSON.stringify({ gen: row.trust_generation })) });
    }
    if (!(await this.putItems(items))) return;
    this.db.transaction(() => {
      for (const row of rows) this.db.run("UPDATE identity_state SET chain_uploaded = 1, trust_uploaded = 1 WHERE user_id = ?", [row.user_id]);
    });
  }

  /** Takes on a link that's been checked: from here, what it says about devices goes. */
  private acceptLink(userId: string, link: Link): void {
    if (this.chainOf(userId).length >= link.gen) return;
    this.db.run("INSERT OR REPLACE INTO identity_chain(user_id, generation, payload, by_prev, by_new, by_device) VALUES(?, ?, ?, ?, ?, ?)", [
      userId,
      link.gen,
      link.payload,
      link.byPrev,
      link.byNew,
      link.byDevice,
    ]);
    this.updateIdentityState(userId, "chain_uploaded = 0", []);
    this.chains.set(userId, [...this.chainOf(userId), link]);
  }

  private followChain(userId: string): Promise<void> {
    const running = this.following.get(userId);
    if (running) return running;
    const run = this.readChain(userId).finally(() => this.following.delete(userId));
    this.following.set(userId, run);
    return run;
  }

  /**
   * Reads someone's chain of identity keys, each link checked against the one
   * before, going back to the key first pinned for them. The first valid link for
   * a generation stays. Another one for the same generation means someone with an
   * old key and the server's help is telling a different story, which is what the
   * loud warning is for.
   */
  private async readChain(userId: string): Promise<void> {
    const root = this.pinnedIdentity(userId);
    if (!root) return;
    let accepted = false;
    let lapsed = false;
    for (;;) {
      const chain = this.chainOf(userId);
      const wires = await this.api.identityLinks(userId, Math.max(chain.length - 1, 0));
      let advanced = false;
      for (const wire of wires) {
        const signed = signedFromApi(wire);
        const held = this.chainOf(userId);
        if (wire.generation <= held.length) {
          if (!equalBytes(signed.payload, held[wire.generation - 1]!.payload)) return this.noteFork(userId);
          continue;
        }
        const before = held.at(-1);
        const link = verifyLink(signed, {
          user: userId,
          gen: held.length + 1,
          prev: before?.hash ?? rootHash(userId, root),
          prevIdentity: before?.identity ?? root,
        });
        if (!link) return this.noteFork(userId);
        const state = this.identityState(userId);
        if (state.known_generation === link.gen && state.known_hash && !equalBytes(state.known_hash, link.hash)) return this.noteFork(userId);
        // What was verified was the key this replaces, so it only carries over from a
        // device that has been around too long to be someone's quick invention.
        if (this.verifiedIdentity(userId) && state.trust_generation === link.gen - 1) {
          if (this.hasContinuity(userId, link.signer)) this.setVerifiedPosition(userId, link.gen);
          else lapsed = true;
        }
        this.acceptLink(userId, link);
        accepted = true;
        advanced = true;
      }
      if (!advanced || wires.length < 200) break;
    }
    if (!accepted) return;
    this.applyUser(await this.api.user(userId));
    if (lapsed) {
      const dm = this.dmWith(userId);
      if (dm) this.addSystemRow(dm.id, Date.now(), userId, { type: "identity_rotated", actorId: userId });
    }
    this.rescheduleAffectedByDeviceChange(userId);
    this.emit({ type: "users", serverId: this.serverId });
    this.emitConversations();
    await this.uploadChainPositions().catch(() => undefined);
  }

  private hasContinuity(userId: string, deviceId: string): boolean {
    const row = this.db.get<{ at: number }>("SELECT at FROM device_first_leaf WHERE user_id = ? AND device_id = ?", [userId, deviceId]);
    return !!row && Date.now() - row.at >= CONTINUITY_MS;
  }

  /** Two versions of someone's chain. What's held stays, and the existing warning says what this means. */
  private async noteFork(userId: string): Promise<void> {
    if (this.identityState(userId).forked) return;
    this.updateIdentityState(userId, "forked = 1", []);
    const root = this.pinnedIdentity(userId);
    if (root) {
      const shown = await this.readWholeChain(userId, root).catch(() => null);
      // A shorter version of what's held changes nothing, so what's held stays what's compared.
      const held = this.chainOf(userId);
      const onlyHeld = !shown?.length || shown.every((link, index) => {
        const mine = held[index];
        return !!mine && equalBytes(mine.hash, link.hash);
      });
      if (shown && !onlyHeld) this.forkHeads.set(userId, shown.at(-1)!.identity);
    }
    if (userId === this.account.userId) {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: "The server showed this device a different history of your account's keys. Someone may be trying to take over your account.",
      });
      return;
    }
    this.refreshTrust(userId);
    const dm = this.dmWith(userId);
    if (dm) this.addSystemRow(dm.id, Date.now(), userId, { type: "identity_changed", actorId: userId, targetIds: [userId] });
    this.emit({ type: "users", serverId: this.serverId });
  }

  /** The chain the server shows now, checked from the start, without holding on to it. */
  private async readWholeChain(userId: string, root: Uint8Array): Promise<Link[]> {
    const links: Link[] = [];
    for (;;) {
      const wires = await this.api.identityLinks(userId, links.length);
      for (const wire of wires) {
        const before = links.at(-1);
        const link = verifyLink(signedFromApi(wire), {
          user: userId,
          gen: links.length + 1,
          prev: before?.hash ?? rootHash(userId, root),
          prevIdentity: before?.identity ?? root,
        });
        if (!link) throw new Error("that chain doesn't hold together");
        links.push(link);
      }
      if (wires.length < 200) return links;
    }
  }

  /**
   * Whether this account's other devices should count a device. A list signed by a
   * link says so for those on it. Otherwise it has to show it came from someone who
   * opened a slot, which a stolen identity key can't do. An account still lacking a
   * slot can't ask that of everyone, since an honest device may have had no slot to
   * open, but that's only a device from before, which this device already knows.
   */
  private ownDeviceAccepted(deviceId: string, device: { signatureKey: Uint8Array; enrollProof?: string | null } | undefined): boolean {
    const { core, userId } = this.account;
    const { password, recovery } = core.slots;
    const lacksSlot = !password || !recovery;
    if (!device) return lacksSlot;
    const head = this.headOf(userId);
    if (head && carries(head, { id: deviceId, key: device.signatureKey })) return true;
    const proof = decode(device.enrollProof);
    if (proof.length > 0 && [password, recovery].some((slot) => !!slot && verifyEnrollment(slot.sign, userId, deviceId, device.signatureKey, proof))) return true;
    if (!lacksSlot) return false;
    const known = this.users.get(userId)?.devices.get(deviceId);
    return !!known && equalBytes(known.signatureKey, device.signatureKey);
  }

  /**
   * The key a device of this account really signs with, if the server's entry for it
   * holds up. Certificates are public and the rest of an entry is the server's word,
   * so all of it is held to what the certificate says.
   */
  private certifiedKey(device: ApiDevice): Uint8Array | null {
    const { userId, core } = this.account;
    const standing = this.certificateStanding(userId, core.rootPublic, decode(device.certificate));
    if (!standing?.carried || standing.cert.userId !== userId || standing.cert.deviceId !== device.id) return null;
    return equalBytes(standing.cert.signatureKey, decode(device.signature_key)) ? standing.cert.signatureKey : null;
  }

  /**
   * What to seal this account's key to for one of its devices, if that device signed
   * it and it isn't older than what the device has said before. A server could
   * otherwise offer an old one again, and a copy of the device taken back then would
   * go on working. One from before these said their generation counts until it has.
   */
  private sealKeyOf(device: ApiDevice, key: Uint8Array): Uint8Array | null {
    const { userId } = this.account;
    const seal = decode(device.seal_key);
    if (seal.length !== 32) return null;
    const seen = this.getKv<Record<string, number>>("seal_seen") ?? {};
    const newest = seen[device.id] ?? -1;
    const generation = device.seal_generation;
    if (generation != null && verifySealProof(key, userId, device.id, generation, seal, decode(device.seal_proof))) {
      if (generation < newest) {
        this.warnOnce(`old-seal/${device.id}/${generation}`, "The server offered an old key for one of your devices. It wasn't used.", userId);
        return null;
      }
      if (generation > newest) this.setKv("seal_seen", { ...seen, [device.id]: generation });
      return seal;
    }
    return newest < 0 && verifySealKey(key, userId, device.id, seal, decode(device.seal_sig)) ? seal : null;
  }

  /** Devices gone from this account that no generation covers yet, so someone holds keys they shouldn't. */
  private uncoveredRemovals(api: ApiUser): string[] {
    const { userId, deviceId } = this.account;
    const head = this.headOf(userId);
    return api.devices
      .filter((device) => {
        if (device.revoked_at == null || device.id === deviceId) return false;
        if (head) {
          const cert = parseCertificate(decode(device.certificate));
          if (cert?.deviceId === device.id && carries(head, { id: device.id, key: cert.signatureKey })) return true;
          return cert?.generation === head.gen;
        }
        return this.protocolSince !== null && device.revoked_at >= this.protocolSince;
      })
      .map((device) => device.id);
  }

  private checkRemovals(api: ApiUser): void {
    if (!this.modern || this.stopped || this.protocolSince === null) return;
    const uncovered = this.uncoveredRemovals(api).length > 0;
    this.removalsUncovered = uncovered;
    if (uncovered && !this.rotationTimer) this.rotateSoon(Math.random() * rotationTiming.takeoverMs);
  }

  private rotateSoon(delay: number): void {
    clearTimeout(this.rotationTimer);
    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = undefined;
      void this.rotateForRemovals();
    }, delay);
  }

  private async rotateForRemovals(): Promise<void> {
    if (this.stopped) return;
    // Only the server says a device was removed, and each rotation costs every contact
    // a link to follow. Replacing keys only ever waits a little: it's never skipped.
    const recent = (this.getKv<number[]>("removal_rotations") ?? []).filter((at) => Date.now() - at < REMOVAL_ROTATION_WINDOW_MS);
    if (recent.length >= MAX_REMOVAL_ROTATIONS) {
      this.warnOnce("removal-rotations", "The server keeps saying devices were removed from your account, so Zuna has slowed down replacing your keys. If you haven't been removing devices, your server may be misbehaving.");
      this.rotateSoon(REMOVAL_ROTATION_WINDOW_MS / MAX_REMOVAL_ROTATIONS);
      return;
    }
    const before = this.account.core.generation;
    try {
      await this.withLock(ACCOUNT_LOCK, () => this.rotateLocked({}, true));
      if (this.account.core.generation !== before) this.setKv("removal_rotations", [...recent, Date.now()]);
      this.setKv("rotation_stuck_since", 0);
      this.sealOlderSoon(0);
    } catch (error) {
      console.warn("[zuna] rotating this account's keys", error);
      if (this.stopped || (error instanceof ApiError && error.status === 401)) return;
      const since = this.getKv<number>("rotation_stuck_since") || Date.now();
      this.setKv("rotation_stuck_since", since);
      if (Date.now() - since > ROTATION_STUCK_MS && !this.getKv<boolean>("rotation_stuck_said")) {
        this.setKv("rotation_stuck_said", true);
        this.emit({
          type: "security",
          serverId: this.serverId,
          userId: "",
          message: "Zuna hasn't been able to finish replacing your account's keys after a device was removed. It keeps trying.",
        });
      }
      this.rotateSoon(rotationTiming.retryMs);
    }
  }

  /** Moves this account to a new generation of keys, doing what the plan says as part of it. */
  async rotate(plan: RotationPlan = {}): Promise<void> {
    await this.withLock(ACCOUNT_LOCK, () => this.rotateLocked(plan, false));
    this.sealOlderSoon(0);
  }

  private async rotateLocked(plan: RotationPlan, onlyForRemovals: boolean): Promise<void> {
    for (let attempt = 0; attempt < ROTATION_ATTEMPTS; attempt++) {
      const unfinished = await this.settleIntent(true);
      if (unfinished) await this.rotateLocked(unfinished, false);
      await this.catchUp();
      if (onlyForRemovals && this.uncoveredRemovals(await this.api.user(this.account.userId)).length === 0) {
        this.removalsUncovered = false;
        return;
      }
      await this.syncVault();
      const intent = await this.prepareRotation(plan);
      try {
        await this.sendIntent(intent);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.retryable) throw error;
        this.closeIntent();
        if (error instanceof ApiError && (error.code === "stale_generation" || error.code === "devices_changed")) continue;
        throw error;
      }
    }
    throw new Error("This account's keys are changing too often right now. Please try again.");
  }

  /** Makes the next generation and writes it down, so a crash from here on carries on with these same keys. */
  private async prepareRotation(plan: RotationPlan): Promise<RotationIntent> {
    const { userId, username, deviceId, devicePublic, deviceSecret, accountKey: oldKey, core } = this.account;
    const generation = core.generation + 1;
    const me = await this.api.user(userId);
    const accountKey = wasm.randomBytes(32);
    const identity = wasm.signingKeygen();
    const hpke = wasm.hpkeKeygen();

    // Any device with a good certificate that's new to this one gets the usual alert now, before it could be carried.
    this.applyUser(me);
    const devices: LinkDevice[] = [];
    const removed: string[] = [];
    for (const device of me.devices) {
      if (device.revoked_at != null) continue;
      if (device.id === deviceId) {
        devices.push({ id: deviceId, key: devicePublic });
        continue;
      }
      const key = this.certifiedKey(device);
      if (key && this.ownDeviceAccepted(device.id, { signatureKey: key, enrollProof: device.enroll_proof })) devices.push({ id: device.id, key });
      else removed.push(device.id);
    }
    if (removed.length > 0) {
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId,
        message: "The server listed a device for your account that never signed in. It was removed.",
      });
    }

    const slots = { ...core.slots };
    const newSlots = new Map((plan.slots ?? []).map((slot) => [slot.kind, slot]));
    for (const slot of newSlots.values()) slots[slot.kind] = { seal: slot.seal, sign: slot.sign };
    const kinds = Object.keys(slots) as SlotKind[];
    const lacksSlot = kinds.length < 2;
    const firstKey = lacksSlot ? (core.firstKey ?? (core.generation === 0 ? oldKey : null)) : null;

    const next: VaultCore = {
      identityPublic: identity.publicKey,
      identitySecret: identity.secretKey,
      hpkePublic: hpke.publicKey,
      hpkeSecret: hpke.secretKey,
      communityKey: core.communityKey,
      generation,
      rootPublic: core.rootPublic,
      rootSecret: core.rootSecret,
      olderKeys: { ...core.olderKeys, [core.generation]: oldKey },
      olderHpkeSecrets: [...core.olderHpkeSecrets, core.hpkeSecret].slice(-OLDER_HPKE_KEPT),
      firstKey,
      closedBelow: core.closedBelow,
      slots,
      manifest: this.manifest?.v ?? 0,
    };
    const head = this.headOf(userId);
    const signed = buildLink(
      {
        user: userId,
        gen: generation,
        prev: head?.hash ?? rootHash(userId, core.rootPublic),
        identity: identity.publicKey,
        hpke: hpke.publicKey,
        keyCommit: keyCommitment(accountKey, userId, generation),
        slotsHash: slotsHash(slots),
        devices,
        removed,
        signer: deviceId,
      },
      core.identitySecret,
      identity.secretKey,
      deviceSecret,
    );
    const link = readHeldLink(signed)!;

    const bundles: { device_id: string; data: Uint8Array }[] = [];
    for (const { id, key } of devices) {
      const seal = this.sealKeyOf(me.devices.find((item) => item.id === id)!, key);
      if (seal) bundles.push({ device_id: id, data: sealBundle(seal, userId, id, generation, link.hash, accountKey) });
    }
    const request = {
      expected_generation: core.generation,
      link: { generation, payload: signed.payload, by_prev: signed.byPrev, by_new: signed.byNew, by_device: signed.byDevice },
      hpke_key_sig: signHpkeKey(core.rootSecret, hpke.publicKey),
      vault_core: sealVaultCore(accountKey, next, userId),
      profile_sig: me.profile ? signProfileAtGeneration(identity.secretKey, userId, generation, decode(me.profile)) : undefined,
      slots: kinds.map((kind) => {
        const sealedKey = sealToSlot(slots[kind]!.seal, kind, username, generation, link.hash, accountKey);
        const made = newSlots.get(kind);
        return made
          ? { kind, seal_key: made.seal, sign_key: made.sign, sealed_secret: made.sealedSecret, sealed_key: sealedKey }
          : { kind, sealed_key: sealedKey };
      }),
      drop_wrappers: kinds,
      bridge: firstKey ? sealBridge(firstKey, userId, generation, accountKey) : undefined,
      bundles,
      items: this.trustItems(accountKey, generation),
      password: plan.password,
      recovery: plan.recovery,
    };
    const intent: RotationIntent = {
      generation,
      request: encodeBody(request) as RotationIntent["request"],
      accountKey: toBase64(accountKey),
      core: coreToJson(next),
      plan: planToJson(plan),
      once: !!plan.once,
    };
    this.setKv(ROTATION_INTENT, intent);
    this.rotationOpen = true;
    return intent;
  }

  /** Everything in the vault that decides who this account trusts, sealed under the new key in one go. */
  private trustItems(accountKey: Uint8Array, generation: number): { id: string; data: Uint8Array }[] {
    const seal = (id: string, data: Uint8Array) => ({ id, data: sealVaultItem(accountKey, id, data, generation) });
    const items: { id: string; data: Uint8Array }[] = [];
    for (const row of this.db.all<{ user_id: string; identity_key: Uint8Array }>("SELECT user_id, identity_key FROM pinned_identities")) {
      items.push(seal(`pin:${row.user_id}`, row.identity_key));
    }
    for (const row of this.db.all<{ user_id: string; identity_key: Uint8Array }>("SELECT user_id, identity_key FROM verified")) {
      items.push(seal(`verified:${row.user_id}`, row.identity_key));
    }
    for (const row of this.db.all<{ user_id: string; trust_generation: number }>("SELECT user_id, trust_generation FROM identity_state")) {
      const head = this.headOf(row.user_id);
      if (head) items.push(seal(`chain:${row.user_id}`, utf8(JSON.stringify({ gen: head.gen, hash: toBase64(head.hash) }))));
      if (row.trust_generation > 0) items.push(seal(`trust:${row.user_id}`, utf8(JSON.stringify({ gen: row.trust_generation }))));
    }
    items.push(seal("prefs", utf8(JSON.stringify(this.prefs))));
    for (const [id, name] of this.deviceNames) items.push(seal(`device:${id}`, utf8(name)));
    return items;
  }

  private closeIntent(): void {
    this.db.run("DELETE FROM kv WHERE k = ?", [ROTATION_INTENT]);
    this.rotationOpen = false;
  }

  private async sendIntent(intent: RotationIntent): Promise<void> {
    await this.api.rotate(intent.request);
    await this.installIntent(intent);
  }

  private async installIntent(intent: RotationIntent): Promise<void> {
    const wire = intent.request.link;
    const link = readHeldLink({ payload: fromBase64(wire.payload), byPrev: fromBase64(wire.by_prev), byNew: fromBase64(wire.by_new), byDevice: fromBase64(wire.by_device) });
    if (!link) throw new Error("a rotation in progress couldn't be read");
    await this.install(fromBase64(intent.accountKey), coreFromJson(intent.core), [link]);
  }

  /**
   * Finishes a rotation a restart interrupted. The server says whether it went
   * through, and if it did, whether it was this device's. If nothing happened it's
   * sent again as the same bytes, unless nobody would learn the key it sets. If
   * something else got in first, what it was for is returned, to be done again on
   * top of that: the rest of it never happened.
   */
  private async settleIntent(rethrow = false): Promise<RotationPlan | null> {
    const intent = this.getKv<RotationIntent>(ROTATION_INTENT);
    if (!intent) return null;
    const overtaken = () => {
      this.closeIntent();
      return intent.once ? null : planFromJson(intent.plan);
    };
    try {
      const { core, userId } = this.account;
      if (core.generation >= intent.generation) {
        // Stopped between the two databases.
        if (core.generation === intent.generation && toBase64(core.identityPublic) === intent.core.identityPublic) await this.installIntent(intent);
        else this.closeIntent();
        return null;
      }
      const state = await this.api.account();
      if (state.generation >= intent.generation) {
        const [link] = await this.api.identityLinks(userId, intent.generation - 1);
        if (link?.payload !== intent.request.link.payload) return overtaken();
        await this.installIntent(intent);
        return null;
      }
      if (intent.once) {
        this.closeIntent();
        return null;
      }
      await this.sendIntent(intent);
      return null;
    } catch (error) {
      if (error instanceof ApiError && (error.code === "stale_generation" || error.code === "devices_changed")) return overtaken();
      if (error instanceof ApiError && !error.retryable && error.status !== 401) {
        this.closeIntent();
        return null;
      }
      if (rethrow || (error instanceof ApiError && error.status === 401)) throw error;
      console.warn("[zuna] finishing a rotation", error);
      return null;
    }
  }

  /** Takes on a generation: keys first, since everything after is only bookkeeping that can be redone. */
  private async install(accountKey: Uint8Array, core: VaultCore, links: Link[]): Promise<void> {
    const { userId } = this.account;
    this.account = { ...this.account, accountKey, core };
    this.saveAccount();
    this.db.transaction(() => {
      for (const link of links) this.acceptLink(userId, link);
      this.db.run("DELETE FROM kv WHERE k = ?", [ROTATION_INTENT]);
      this.db.run("UPDATE pinned_identities SET uploaded = 0");
    });
    this.rotationOpen = false;
    this.removalsUncovered = false;
    this.setKv("rotation_stuck_since", 0);
    this.setKv("rotation_stuck_said", false);
    try {
      await this.replaceSealKey();
      const me = await this.api.user(userId);
      await this.ensureCertificate(me);
      this.applyUser(await this.api.user(userId));
      this.rescheduleAffectedByDeviceChange(userId);
      await this.uploadPins();
      // The manifest so far is sealed under the old key, which nothing believes now.
      await this.writeManifest();
      await this.uploadEpochKeys();
      await this.topUpKeyPackages();
    } catch (error) {
      console.warn("[zuna] after a rotation", error);
    }
    this.emit({ type: "users", serverId: this.serverId });
  }

  /** A copy of a device taken once should stop being useful, so the key each rotation seals to changes. */
  private async replaceSealKey(): Promise<void> {
    const seal = wasm.hpkeKeygen();
    this.account = { ...this.account, sealPublic: seal.publicKey, sealSecret: seal.secretKey, sealOlder: this.account.sealSecret };
    this.saveAccount();
    await this.publishSealKey();
  }

  private async publishSealKey(): Promise<void> {
    const { userId, deviceId, deviceSecret, sealPublic, core } = this.account;
    const seal = sealPublic!;
    await this.api.setSealKey(deviceId, seal, signSealKey(deviceSecret, userId, deviceId, seal), core.generation, signSealProof(deviceSecret, userId, deviceId, core.generation, seal));
  }

  /** Gives this device a seal key, and a certificate that says what generation it's from. */
  private async prepareDevice(): Promise<void> {
    const { userId, deviceId } = this.account;
    const me = await this.api.user(userId);
    const own = me.devices.find((device) => device.id === deviceId);
    if (!this.account.sealPublic) {
      const seal = wasm.hpkeKeygen();
      this.account = { ...this.account, sealPublic: seal.publicKey, sealSecret: seal.secretKey };
      this.saveAccount();
    }
    // One from before seal keys said which generation they're from gets that said once.
    if (own && (!equalBytes(decode(own.seal_key), this.account.sealPublic!) || own.seal_generation == null)) await this.publishSealKey();
    await this.ensureCertificate(me);
  }

  /** A certificate from this generation, whichever way this device has got here. */
  private async ensureCertificate(me: ApiUser): Promise<void> {
    const { userId, deviceId, devicePublic, core, certificate } = this.account;
    const parsed = parseCertificate(certificate);
    if (!parsed?.headSignature || parsed.generation !== core.generation) {
      const next = createCertificate(core.rootSecret, { userId, deviceId, signatureKey: devicePublic, generation: core.generation }, core.identitySecret);
      this.account = { ...this.account, certificate: next };
      this.saveAccount();
      this.mls.setCredential(next);
    }
    const own = me.devices.find((device) => device.id === deviceId);
    if (own && !equalBytes(decode(own.certificate), this.account.certificate)) {
      await this.api.setCertificate(deviceId, this.account.certificate);
    }
  }

  private syncAccountSoon(): void {
    if (this.stopped) return;
    void this.syncAccount().catch((error) => console.warn("[zuna] catching up on this account's keys", error));
  }

  /** Catches up with which generation of keys this account is at. */
  private async syncAccount(): Promise<void> {
    if (!this.modern) return;
    await this.withLock(ACCOUNT_LOCK, async () => {
      const unfinished = await this.settleIntent();
      if (unfinished) await this.rotateLocked(unfinished, false);
      await this.catchUp();
    });
  }

  private async catchUp(): Promise<void> {
    await this.prepareDevice();
    const state = await this.api.account();
    if (this.protocolSince !== state.protocol_since) {
      this.protocolSince = state.protocol_since;
      this.setKv("protocol_since", state.protocol_since);
    }
    const { core, userId } = this.account;
    // Signing in gets the keys, and the chain that leads to them comes from the server.
    if (this.headGeneration(userId) < core.generation) {
      await this.readChain(userId);
      const head = this.headOf(userId);
      if (head?.gen === core.generation && !equalBytes(head.identity, core.identityPublic)) await this.noteFork(userId);
    }
    if (state.generation > core.generation) await this.followRotation(state);
    else if (state.generation === core.generation) this.refreshCore(state);
    await this.deliverBundles(state);
    if (this.account.core.generation > 0 && (state.older_items > 0 || this.account.core.closedBelow < this.account.core.generation)) {
      this.sealOlderSoon(Math.random() * rotationTiming.takeoverMs);
    }
    this.checkRemovals(await this.api.user(userId));
  }

  /**
   * Follows a rotation another device made. Anyone can seal to a public key, and
   * someone with the old identity key can write a link, so all of this has to hold:
   * the links follow from what's held, the first was signed by a device this one
   * accepts (later ones are authorized by that one's key), this device is on the
   * newest, and the key it was given is the key that link commits to.
   */
  private async followRotation(state: ApiAccount): Promise<void> {
    const { userId, deviceId, devicePublic, core } = this.account;
    const wires = await this.api.identityLinks(userId, core.generation);
    const links: Link[] = [];
    for (const wire of wires) {
      const before = links.at(-1) ?? this.headOf(userId);
      const link = verifyLink(signedFromApi(wire), {
        user: userId,
        gen: (before?.gen ?? 0) + 1,
        prev: before?.hash ?? rootHash(userId, core.rootPublic),
        prevIdentity: before?.identity ?? core.rootPublic,
      });
      if (!link) return this.noteFork(userId);
      if (links.length === 0 && !(await this.signerAccepted(link))) return this.noteFork(userId);
      links.push(link);
    }
    const head = links.at(-1);
    if (!head || head.gen !== state.generation) return;
    if (!carries(head, { id: deviceId, key: devicePublic })) {
      this.signedOut("device_revoked");
      return;
    }
    // A device that couldn't be sealed to waits for another to do it.
    if (state.bundle?.generation !== head.gen) return;
    const accountKey = this.openOwnBundle(head, decode(state.bundle.data));
    if (!accountKey || !equalBytes(head.keyCommit, keyCommitment(accountKey, userId, head.gen))) return this.noteFork(userId);
    let next: VaultCore;
    try {
      next = openVaultCore(accountKey, decode(state.vault_core), head.gen, userId);
    } catch {
      return this.noteFork(userId);
    }
    const fits = next.generation === head.gen && equalBytes(next.identityPublic, head.identity) && equalBytes(next.hpkePublic, head.hpke) && equalBytes(slotsHash(next.slots), head.slotsHash);
    if (!fits) return this.noteFork(userId);
    await this.install(accountKey, next, links);
    void this.syncVault().catch((error) => console.warn("[zuna] vault", error));
  }

  private openOwnBundle(head: Link, sealed: Uint8Array): Uint8Array | null {
    const { userId, deviceId, sealSecret, sealOlder } = this.account;
    for (const secret of [sealSecret, sealOlder]) {
      if (!secret) continue;
      try {
        return openBundle(secret, userId, deviceId, head.gen, head.hash, sealed);
      } catch {
        // Sealed to the other key, or to nobody.
      }
    }
    return null;
  }

  private async signerAccepted(link: Link): Promise<boolean> {
    const { userId, deviceId } = this.account;
    const signer = link.devices.find((device) => device.id === link.signer);
    if (!signer) return false;
    if (signer.id === deviceId) return true;
    const head = this.headOf(userId);
    if (head && carries(head, signer)) return true;
    const proof = (await this.api.user(userId)).devices.find((device) => device.id === signer.id)?.enroll_proof;
    return this.ownDeviceAccepted(signer.id, { signatureKey: signer.key, enrollProof: proof });
  }

  /** A new core at this generation: a slot made before any rotation, or a generation closing. */
  private refreshCore(state: ApiAccount): void {
    const { accountKey, core, userId } = this.account;
    let next: VaultCore;
    try {
      next = openVaultCore(accountKey, decode(state.vault_core), core.generation, userId);
    } catch {
      return;
    }
    if (next.generation !== core.generation || !equalBytes(next.identityPublic, core.identityPublic)) return;
    const head = this.headOf(userId);
    if (head && !equalBytes(slotsHash(next.slots), head.slotsHash)) return;
    const merged: VaultCore =
      core.generation === 0
        ? { ...core, slots: { ...next.slots, ...core.slots } }
        : { ...core, closedBelow: Math.max(core.closedBelow, next.closedBelow), olderKeys: next.olderKeys, firstKey: next.firstKey };
    if (JSON.stringify(coreToJson(merged)) === JSON.stringify(coreToJson(core))) return;
    this.account = { ...this.account, core: merged };
    this.saveAccount();
  }

  /** Seals the account key for a device that couldn't be sealed to when this generation was made. */
  private async deliverBundles(state: ApiAccount): Promise<void> {
    const { userId, deviceId, accountKey, core } = this.account;
    const head = this.headOf(userId);
    if (!head || state.generation !== core.generation || state.missing_bundles.length === 0) return;
    const me = await this.api.user(userId);
    const bundles: { device_id: string; data: Uint8Array }[] = [];
    for (const id of state.missing_bundles) {
      const device = me.devices.find((item) => item.id === id);
      if (!device || id === deviceId || device.revoked_at != null) continue;
      const key = this.certifiedKey(device);
      const seal = key && this.ownDeviceAccepted(id, { signatureKey: key, enrollProof: device.enroll_proof }) ? this.sealKeyOf(device, key) : null;
      if (seal) bundles.push({ device_id: id, data: sealBundle(seal, userId, id, head.gen, head.hash, accountKey) });
    }
    if (bundles.length > 0) await this.api.putBundles(head.gen, bundles);
  }

  private sealOlderSoon(delay: number): void {
    if (this.sealingTimer || this.sealing || this.stopped) return;
    this.sealingTimer = setTimeout(() => {
      this.sealingTimer = undefined;
      void this.sealOlderItems().catch((error) => console.warn("[zuna] sealing older vault items", error));
    }, delay);
  }

  /**
   * Seals what's left in the vault under the current key, so someone who has an
   * older one and only later gets the server's data finds nothing to open, and then
   * closes the generation: from then on, nothing older is believed. Only epoch keys
   * carry over. Everything else was sealed with the rotation, and an older copy of
   * it may be something planted under a stolen key.
   */
  private async sealOlderItems(): Promise<void> {
    if (this.sealing) return;
    this.sealing = true;
    try {
      const { accountKey, core, userId } = this.account;
      if (core.generation === 0 || core.closedBelow >= core.generation) return;
      for (;;) {
        const items = await this.api.olderVaultItems(VAULT_BATCH);
        if (items.length === 0) break;
        const sealed: { id: string; data: Uint8Array }[] = [];
        const remove: string[] = [];
        for (const item of items) {
          const key = core.olderKeys[item.generation ?? 0];
          if (!key || !item.id.startsWith("ek:")) {
            remove.push(item.id);
            continue;
          }
          try {
            const data = openVaultItem(key, item.id, decode(item.data), item.generation ?? 0);
            sealed.push({ id: item.id, data: sealVaultItem(accountKey, item.id, data, core.generation) });
          } catch {
            remove.push(item.id);
          }
        }
        await this.api.resealVault(core.generation, sealed, remove);
      }
      const closed: VaultCore = { ...core, closedBelow: core.generation, olderKeys: {} };
      await this.api.closeGeneration(core.generation, sealVaultCore(accountKey, closed, userId));
      if (this.account.core.generation === core.generation) {
        this.account = { ...this.account, core: closed };
        this.saveAccount();
      }
    } finally {
      this.sealing = false;
    }
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
    // One made before this device set this nobody could add to a group, so it's replaced whatever its age.
    const lastResortStale = !this.getKv<boolean>("last_resort_usable") || Date.now() - status.last_resort_at > LAST_RESORT_MAX_AGE_MS;
    if (needOneTime === 0 && !lastResortStale) return;
    const packages: Uint8Array[] = [];
    for (let i = 0; i < needOneTime; i++) packages.push(this.mls.generateKeyPackage(false));
    const lastResort = lastResortStale ? this.mls.generateKeyPackage(true) : undefined;
    this.saveMls();
    await this.api.addKeyPackages(packages, lastResort);
    if (lastResort) this.setKv("last_resort_usable", true);
  }

  /**
   * The server lets one person take another's key packages only so often, so
   * that nobody can use up someone's one-time packages. Past that, as when
   * adding the same person to many groups at once, it waits for the next one.
   */
  private async claimWithPatience(userId: string): Promise<{ device_id: string; data: string }[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.api.claimKeyPackages(userId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || attempt >= CLAIM_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, CLAIM_WAIT_MS));
      }
    }
  }

  /** Claims key packages for a user's devices, keeping only ones their identity key vouches for. */
  private async claimKeyPackages(userId: string, exceptDevice?: string): Promise<{ deviceId: string; data: Uint8Array }[]> {
    const user = await this.ensureUser(userId, true);
    if (!user) return [];
    const pinned = this.pinnedIdentity(userId) ?? user.identityKey;
    const claimed = await this.claimWithPatience(userId);
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
      const standing = this.certificateStanding(userId, pinned, credential);
      const known = user.devices.get(item.device_id);
      const genuine =
        !!standing?.carried &&
        standing.cert.userId === userId &&
        standing.cert.deviceId === item.device_id &&
        !!known &&
        !known.revoked &&
        equalBytes(this.mls.keyPackageSignatureKey(data), standing.cert.signatureKey);
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

  private warnOnce(key: string, message: string, userId = ""): void {
    if (this.warnedLeaves.has(key)) return;
    this.warnedLeaves.add(key);
    this.emit({ type: "security", serverId: this.serverId, userId, message });
  }

  /** The two people of a DM, or the one, for saved messages. */
  private dmPeople(group: CachedGroup): string[] {
    return [...new Set([this.account.userId, group.peerId ?? this.account.userId])];
  }

  /** Whether this device has been part of a group, so that a server saying it never started is wrong. */
  private startedHere(groupId: string): boolean {
    if (this.joinedEpoch(groupId) !== null) return true;
    if (this.db.get("SELECT 1 FROM epoch_keys WHERE group_id = ? LIMIT 1", [groupId])) return true;
    return this.hasMlsGroup(groupId) && this.mlsEpoch(groupId) > 0;
  }

  /**
   * Starting a group over would mean believing the server about who's in it, with
   * nothing to compare it with, so a group that has already started never does.
   */
  private refuseRewind(groupId: string): void {
    if (!this.startedHere(groupId)) return;
    this.warnOnce(`rewind/${groupId}`, "The server said one of your conversations never started, which can't be right. Zuna didn't start it over, so that conversation won't work until the server stops saying so.");
    throw new Error("This conversation can't be used right now: the server's answer about it doesn't hold together.");
  }

  private refuseDoubtful(groupId: string): void {
    if (this.groups.get(groupId)?.doubtful) throw new Error("This conversation can't be used: the server listed more than two people in a direct message.");
  }

  private applyGroup(api: ApiGroup): CachedGroup {
    const previous = this.groups.get(api.id);
    const selfId = this.account.userId;
    // What a conversation is, and for a DM who it's with, is settled when it's first
    // seen. The server's list is only its word, and a DM is between two people.
    const kind = previous?.kind ?? api.kind;
    const others = [...new Set(api.members.map((member) => member.user_id))].filter((id) => id !== selfId);
    let peerId: string | null = null;
    let doubtful = false;
    if (kind === "dm") {
      if (previous && !previous.doubtful) {
        peerId = previous.peerId;
      } else {
        peerId = others[0] ?? previous?.peerId ?? selfId;
        doubtful = others.length > 1;
      }
      if (others.some((id) => id !== peerId)) {
        this.warnOnce(`dm-roster/${api.id}`, "The server listed someone else in one of your direct messages. They were left out, and any keys they got are being taken back.");
      }
    }
    const listed = api.members.filter((member) => kind !== "dm" || member.user_id === selfId || member.user_id === peerId);
    const group: CachedGroup = {
      id: api.id,
      kind,
      peerId,
      epoch: api.epoch,
      seq: api.seq,
      meta: previous?.meta ?? {},
      metaBlob: api.meta,
      metaEpoch: api.meta_epoch,
      metaVersion: previous?.metaVersion ?? 0,
      createdAt: api.created_at,
      members: listed.map((member) => ({ userId: member.user_id, role: member.role, joinedAt: member.joined_at })),
      readStates: Object.fromEntries(listed.map((member) => [member.user_id, member.read_state])),
      readBy: previous?.readBy ?? {},
      ownRead: previous?.ownRead ?? 0,
      // The server listing us as a member means we're in it after all.
      removedAt: null,
      pendingRemovals: previous?.pendingRemovals,
      doubtful,
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
   * count only until signed ones are seen, and an admin's app replaces them. They
   * never say whether history is shared: anyone could have written that.
   */
  private acceptGroupDetails(group: CachedGroup, opened: unknown): void {
    if (opened === null) return;
    const signed = readSignedGroupDetails(group.id, opened);
    if (!signed) {
      const legacy = parseGroupDetails(opened);
      if (legacy && !group.metaVersion) {
        delete legacy.historyVisible;
        group.meta = legacy;
      }
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

  /** Seals a group's details for an epoch, signed by this device. Whether history is shared goes with them. */
  private sealGroupDetails(groupId: string, key: Uint8Array, epoch: number, meta: GroupMeta, version: number): Uint8Array {
    const signer = { userId: this.account.userId, deviceId: this.account.deviceId };
    const group = this.groups.get(groupId);
    const details: GroupMeta = { ...meta, historyVisible: meta.historyVisible ?? (group ? this.sharesHistory(group) : false) };
    return sealSignal(key, "meta", groupId, epoch, signGroupDetails(groupId, details, version, signer, this.account.deviceSecret));
  }

  /**
   * Whether someone added to a group gets its history. That's an admin's signed
   * choice, never the server's word, so without the details an admin signed, it's no.
   */
  private sharesHistory(group: CachedGroup): boolean {
    return group.meta.historyVisible ?? false;
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
    let seq: number | null = null;
    const signed = readSigned(sealed);
    if (signed) {
      const device = this.users.get(userId)?.devices.get(signed.deviceId);
      const key = this.epochKey(group.id, signed.epoch);
      if (!device || !key) return;
      const opened = openEnvelope<unknown>(key, device.signatureKey, "read", group.id, userId, signed.epoch, signed.envelope);
      seq = opened.ok ? parseReadState(opened.value) : null;
    } else {
      // Unsigned, it can only be this account's own, sealed to its key so its other
      // devices keep up. Apps from before positions were signed sealed others' with the
      // group's key, which any member holds, saying nothing of whose they were, so the
      // server could have put one under anyone's name.
      if (sealed[0] !== 1 || userId !== this.account.userId) return;
      const body = sealed.subarray(1);
      // A position sealed to this account stays as it was until it's next written, so
      // it may be under an older key. The worst a stolen one can do is mark things read.
      for (const key of [this.account.accountKey, ...Object.values(this.account.core.olderKeys)]) {
        if (seq === null) seq = parseReadState(openSignal<unknown>(key, "read", group.id, body));
      }
    }
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
      this.db.run("DELETE FROM media WHERE group_id = ?", [groupId]);
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
        const result = this.mls.joinFromWelcome(decode(welcome.data), utf8(welcome.group_id)) as { epoch: number };
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
    const group = this.groups.get(groupId);
    const people = group?.kind === "dm" ? this.dmPeople(group) : null;
    const out: TreeMember[] = members.map((member) => {
      const cert = parseCertificate(member.credential);
      if (!cert) return { leaf: member.leafIndex, userId: "", deviceId: "", genuine: false };
      const found = { leaf: member.leafIndex, userId: cert.userId, deviceId: cert.deviceId };
      if (people && !people.includes(cert.userId)) return { ...found, genuine: false, outsider: true };
      // Someone not known yet is looked up by checkTree, which runs on any change to the tree.
      // Until that's worked, nothing about this leaf has been checked, so it counts for nothing.
      const pinned = this.pinnedIdentity(cert.userId);
      if (!pinned) return { ...found, genuine: false, unchecked: true };
      const standing = this.certificateStanding(cert.userId, pinned, member.credential);
      return { ...found, genuine: !!standing?.carried && equalBytes(standing.cert.signatureKey, member.signatureKey) };
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
      if (!cert) continue;
      // A certificate from a generation not seen yet says there's more of that person's chain to
      // read. If it's this person's own, this device is what's behind, and it catches up first.
      if (cert.userId === this.account.userId && cert.generation > this.headGeneration(cert.userId)) await this.syncAccount();
      else if (!this.pinnedIdentity(cert.userId) || cert.generation > this.headGeneration(cert.userId)) await this.ensureUser(cert.userId, true);
    }
  }

  /** Notes who's in a tree shared with this device, which is the only proof of how long a device has been around. */
  private noteLeaves(groupId: string): void {
    const now = Date.now();
    for (const member of this.treeMembers(groupId)) {
      if (member.genuine) this.db.run("INSERT OR IGNORE INTO device_first_leaf(user_id, device_id, at) VALUES(?, ?, ?)", [member.userId, member.deviceId, now]);
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
    this.noteLeaves(groupId);
    const bad = this.treeMembers(groupId).filter((member) => !member.genuine && !member.unchecked && member.leaf !== this.mls.ownLeafIndex(utf8(groupId)));
    for (const member of bad) {
      const warned = `${groupId}/${member.leaf}/${this.mlsEpoch(groupId)}`;
      if (this.warnedLeaves.has(warned)) continue;
      this.warnedLeaves.add(warned);
      const owner = member.userId ? this.users.get(member.userId)?.profile.displayName : null;
      this.emit({
        type: "security",
        serverId: this.serverId,
        userId: member.userId,
        message: member.outsider
          ? `${owner ?? "Someone"} isn't part of one of your direct messages, but was given its keys. They're being removed.`
          : owner
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
      this.noteArrivalsAtJoin(groupId);
      void this.uploadEpochKeys().catch(() => undefined);
      return true;
    }
    return false;
  }

  /**
   * A commit says who it adds, but joining takes a whole tree on trust, so whoever's
   * in it that this device hadn't heard of gets the same warning as an unexpected
   * join. A brand new device has heard of nobody, and takes the tree as it finds it.
   */
  private noteArrivalsAtJoin(groupId: string): void {
    const known = this.knownMembers(groupId);
    const inTree = this.treeUsers(groupId);
    if (known.size > 0) {
      for (const userId of inTree) {
        if (!known.has(userId) && userId !== this.account.userId) this.addSystemRow(groupId, Date.now(), userId, { type: "unexpected_join", actorId: userId });
      }
    }
    this.setKnownMembers(groupId, new Set([...known, ...inTree]));
  }

  /** Makes sure this device can use the group, starting it if nobody has yet. */
  private async ensureReady(groupId: string): Promise<void> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    this.refuseDoubtful(groupId);
    if (group.epoch === 0) {
      this.refuseRewind(groupId);
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
      await this.checkTree(groupId);
      // Nothing goes to a leaf nobody could check. This can wait until the server answers.
      const roster = new Set(this.groups.get(groupId)?.members.map((member) => member.userId));
      if (this.treeMembers(groupId).some((member) => member.unchecked && roster.has(member.userId))) {
        throw new ApiError(0, "unchecked_member", "Couldn't check who's in this conversation yet. This will go when the server answers.");
      }
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
   * Starts a group's MLS state. Two people may race to start a DM. The server
   * accepts one, and the loser receives a Welcome from the winner. Who gets the
   * keys is who the person asked for: the server's list is never what decides it.
   */
  private async initGroup(group: ApiGroup, extraUsers: string[], meta?: GroupMeta): Promise<void> {
    const cached = this.groups.get(group.id);
    const selfId = this.account.userId;
    if (cached?.kind !== "dm" && group.created_by !== selfId) throw new Error("This conversation hasn't been started yet.");
    const targets = cached?.kind === "dm" ? this.dmPeople(cached) : [...new Set([selfId, ...extraUsers])];

    const groupBytes = utf8(group.id);
    this.mls.deleteGroup(groupBytes);
    this.mls.createGroup(groupBytes);
    this.saveMls();

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
    this.noteLeaves(group.id);
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
      this.noteLeaves(groupId);
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
    if (!cached || cached.removedAt || cached.doubtful) return false;
    if (!this.hasMlsGroup(groupId)) {
      const group = await this.api.group(groupId);
      this.applyGroup(group);
      if (group.epoch === 0) return false;
      await this.processWelcomesFor(groupId);
      if (!this.hasMlsGroup(groupId)) {
        await this.repair(groupId);
        if (!this.hasMlsGroup(groupId)) return false;
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
    // Caught up, and still behind: a commit this device couldn't apply. If it's
    // been waiting for someone able to deal with that, this may be them.
    if (!page.has_more && group && !group.removedAt && this.hasMlsGroup(groupId) && group.epoch > this.mlsEpoch(groupId)) {
      await this.repair(groupId);
    }
    return page.has_more;
  }

  private async applyEvent(event: ApiEvent): Promise<void> {
    if (event.kind === "member_left") {
      // Only said so by the server. It's shown once MLS bears it out.
      const group = this.groups.get(event.group_id);
      if (group && event.target_user) {
        group.pendingRemovals = {
          ...group.pendingRemovals,
          [event.target_user]: { actor: event.sender_user, seq: event.seq, at: event.created_at },
        };
        this.persistGroup(group);
        this.announceConfirmedRemovals(event.group_id);
      }
      this.scheduleReconcile(event.group_id);
      return;
    }
    if (event.kind === "commit_voided") {
      this.db.run("DELETE FROM epoch_starts WHERE group_id = ? AND epoch > ?", [event.group_id, event.epoch]);
      this.noteVoidedCommit(event);
      // A device that got past that epoch has gone somewhere nobody else will follow.
      if (this.hasMlsGroup(event.group_id) && this.mlsEpoch(event.group_id) > event.epoch) await this.repair(event.group_id);
      return;
    }
    this.db.run("INSERT OR REPLACE INTO epoch_starts(group_id, epoch, seq) VALUES(?, ?, ?)", [event.group_id, event.epoch, event.seq]);
    await this.applyCommit(event);
  }

  /** People the server said left, whose keys are now really gone. */
  private announceConfirmedRemovals(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group?.pendingRemovals || !this.hasMlsGroup(groupId)) return;
    const inTree = new Set(this.treeUsers(groupId));
    const pending = { ...group.pendingRemovals };
    let changed = false;
    for (const [target, { actor, seq, at }] of Object.entries(pending)) {
      if (inTree.has(target)) continue;
      changed = true;
      delete pending[target];
      if (target === actor) {
        this.addSystemRow(groupId, at, target, { type: "member_left", actorId: target }, seq);
      } else {
        // That they're gone is proven. Who did it is only the server's word, so it isn't repeated.
        this.addSystemRow(groupId, at, actor, { type: "member_removed", targetIds: [target] }, seq);
      }
    }
    if (changed) {
      group.pendingRemovals = pending;
      this.persistGroup(group);
    }
  }

  /** The epoch a device left a group's tree, if it has. */
  private departedAt(groupId: string, deviceId: string): number | null {
    return this.db.get<{ epoch: number }>("SELECT epoch FROM device_departures WHERE group_id = ? AND device_id = ?", [groupId, deviceId])?.epoch ?? null;
  }

  private recordDepartures(groupId: string, epoch: number, removed: Uint8Array[]): void {
    const present = new Set(this.treeMembers(groupId).filter((member) => member.genuine).map((member) => member.deviceId));
    for (const deviceId of present) this.db.run("DELETE FROM device_departures WHERE group_id = ? AND device_id = ?", [groupId, deviceId]);
    for (const credential of removed) {
      const cert = parseCertificate(credential);
      // A real device still here means what went was something using its certificate.
      if (cert && !present.has(cert.deviceId)) {
        this.db.run("INSERT OR REPLACE INTO device_departures(group_id, device_id, epoch) VALUES(?, ?, ?)", [groupId, cert.deviceId, epoch]);
      }
    }
  }

  /**
   * A commit nobody can apply: it reached the server well formed, but no member's
   * MLS state can follow it, and neither can anyone rejoin past it. Whoever's device
   * still has the last good state brings the group back to it, and everyone who
   * never got past that epoch simply carries on. Nobody has to accept anything new,
   * since they keep the keys they already trust.
   */
  private async voidBrokenCommit(groupId: string, cause: unknown): Promise<void> {
    const group = await this.api.group(groupId);
    this.applyGroup(group);
    const groupBytes = utf8(groupId);
    const held = this.hasMlsGroup(groupId);
    const local = held ? this.mlsEpoch(groupId) : 0;
    // With nothing held, only the start of a group can be undone.
    if (group.epoch <= local || (!held && group.epoch > 1)) return;
    console.warn("[zuna] undoing a commit nobody can apply", cause);
    try {
      await this.api.voidCommits(groupId, group.epoch, local, held ? this.mls.exportGroupInfo(groupBytes) : new Uint8Array(0));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403) throw error;
      // Being refused this says nothing about still being in the group. Someone else may yet be able to.
      this.warnOnce(`stuck/${groupId}/${group.epoch}`, "One of your conversations has a broken update that only one of its admins can undo. It will carry on once one of them opens Zuna.");
      return;
    }
    this.applyGroup(await this.api.group(groupId));
  }

  /** Who's told that a commit was undone: anyone it happened in front of, not a device reading about it later. */
  private noteVoidedCommit(event: ApiEvent): void {
    const joined = this.joinedEpoch(event.group_id);
    if (joined === null || joined > event.epoch) return;
    const name = this.users.get(event.target_user ?? "")?.profile.displayName ?? "someone";
    this.warnOnce(`voided/${event.group_id}/${event.seq}`, `A broken update from ${name} in one of your conversations was undone, and the conversation carries on.`, event.target_user ?? "");
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
    this.treeUsersCache.delete(groupId);
    if (processed.selfRemoved) {
      await this.afterBeingRemoved(groupId);
      return;
    }
    this.rememberCurrentEpochKey(groupId);
    void this.uploadEpochKeys().catch(() => undefined);
    await this.checkTree(groupId);
    this.recordDepartures(groupId, processed.epoch, processed.removedCredentials);
    await this.checkCommitAuthority(event, processed);
    this.describeCommit(event, processed, usersBefore);
    this.announceConfirmedRemovals(groupId);
    this.retryUndecryptable(groupId);
  }

  /**
   * This device was taken out of a group's tree. If the server says this person
   * has left, so be it. If they're still a member, someone with no right to has
   * removed them: this device goes straight back in, and says so.
   */
  private async afterBeingRemoved(groupId: string): Promise<void> {
    let stillMember = false;
    try {
      const group = await this.api.group(groupId);
      this.applyGroup(group);
      stillMember = group.members.some((member) => member.user_id === this.account.userId);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error;
    }
    if (!stillMember) {
      this.markRemoved(groupId);
      return;
    }
    this.emit({
      type: "security",
      serverId: this.serverId,
      userId: this.account.userId,
      message: "A member removed this device from one of your conversations without permission. It has rejoined.",
    });
    await this.repair(groupId);
  }

  /**
   * MLS proves who made a commit, not whether they may. Only admins add people
   * or remove anyone who hasn't already left. A commit can't be taken back once
   * everyone has applied it, so this says what happened and the group heals: someone
   * added against the rules is removed as stale, and someone removed rejoins.
   */
  private async checkCommitAuthority(
    event: ApiEvent,
    processed: { senderCredential: Uint8Array; isExternal: boolean; addedCredentials: Uint8Array[]; removedCredentials: Uint8Array[] },
  ): Promise<void> {
    const groupId = event.group_id;
    if (processed.addedCredentials.length === 0 && processed.removedCredentials.length === 0) return;
    const sender = parseCertificate(processed.senderCredential);
    const look = () => {
      const group = this.groups.get(groupId);
      const present = new Set(this.treeMembers(groupId).filter((member) => member.genuine).map((member) => member.deviceId));
      const senderIsAdmin = !!group && !!sender && this.isGroupAdmin(group, sender.userId);
      const addedWithoutRight = !senderIsAdmin && processed.addedCredentials.length > 0;
      const removedWithoutRight =
        !senderIsAdmin &&
        processed.removedCredentials.some((credential) => {
          const cert = parseCertificate(credential);
          if (!cert || !group) return false;
          // Rejoining replaces a device's own old leaf.
          if (processed.isExternal && cert.deviceId === sender?.deviceId) return false;
          // A real device still here means what went wasn't really it.
          if (present.has(cert.deviceId)) return false;
          const onRoster = group.members.some((member) => member.userId === cert.userId);
          const revoked = this.users.get(cert.userId)?.devices.get(cert.deviceId)?.revoked;
          return onRoster && !revoked;
        });
      return { addedWithoutRight, removedWithoutRight };
    };
    let found = look();
    if (!found.addedWithoutRight && !found.removedWithoutRight) return;
    // What's known here may be behind. Only what the server says now counts.
    try {
      this.applyGroup(await this.api.group(groupId));
      if (sender) await this.ensureUser(sender.userId, true);
      for (const credential of processed.removedCredentials) {
        const cert = parseCertificate(credential);
        if (cert) await this.ensureUser(cert.userId, true);
      }
    } catch (error) {
      console.warn("[zuna] checking a commit", error);
    }
    found = look();
    if (!found.addedWithoutRight && !found.removedWithoutRight) return;
    const name = sender ? (this.users.get(sender.userId)?.profile.displayName ?? "A member") : "A member";
    this.emit({
      type: "security",
      serverId: this.serverId,
      userId: sender?.userId ?? "",
      message: `${name} changed who's in one of your conversations without permission. Zuna is putting it right.`,
    });
    this.scheduleReconcile(groupId);
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
    // Those the server already told us about get their notice from that.
    const pending = this.groups.get(groupId)?.pendingRemovals ?? {};
    const unannounced = new Set([...removedUsers].filter((user) => !pending[user]));
    if (unannounced.size > 0 && senderCert && this.isRosterRemoval(groupId, unannounced) && !this.alreadyAnnouncedRemoval(groupId, unannounced)) {
      this.addSystemRow(groupId, event.created_at, senderCert.userId, {
        type: "member_removed",
        actorId: senderCert.userId,
        targetIds: [...unannounced],
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

  /**
   * Gets this device back in step with a group. Rejoining fixes anything that went
   * wrong on this device. If nobody can rejoin either, because what the group moved
   * on to doesn't hold together, it's undone if this person is able to do that, and
   * otherwise waits for someone who is. What this device has isn't lost either way.
   * Only MLS refusing what the group moved on to says that: a server or a network
   * having a bad moment says nothing about the group, so it's just tried again later.
   */
  private async repair(groupId: string): Promise<void> {
    try {
      await this.joinExternal(groupId);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) throw error;
      console.warn("[zuna] couldn't rejoin a conversation", error);
      if (!(error instanceof ApiError)) {
        try {
          await this.voidBrokenCommit(groupId, error);
          if (!this.hasMlsGroup(groupId) && this.groups.get(groupId)?.epoch === 0 && !this.startedHere(groupId)) {
            const group = await this.api.group(groupId);
            await this.initGroup(group, []);
          }
        } catch (voidError) {
          if (voidError instanceof ApiError && (voidError.status === 403 || voidError.status === 404)) throw voidError;
          console.warn("[zuna] couldn't undo a broken update", voidError);
        }
      }
    }
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
    if (!group || group.doubtful || !this.hasMlsGroup(groupId)) return [];
    const roster = new Set(group.members.map((member) => member.userId));
    const own = this.mls.ownLeafIndex(utf8(groupId));
    const stale: number[] = [];
    for (const member of this.treeMembers(groupId)) {
      if (member.leaf === own) continue;
      // Not caught out, only not checked yet. ensureTreeClean waits for that.
      if (member.unchecked && roster.has(member.userId)) continue;
      if (!member.genuine || !roster.has(member.userId)) {
        stale.push(member.leaf);
        continue;
      }
      let device = this.users.get(member.userId)?.devices.get(member.deviceId);
      if (!device) {
        // Our list may be behind: only act on what the server says right now.
        device = (await this.ensureUser(member.userId, true))?.devices.get(member.deviceId);
      }
      if (device?.revoked) {
        stale.push(member.leaf);
      } else if (member.userId === this.account.userId && this.modern && !this.ownDeviceAccepted(member.deviceId, device)) {
        // A valid certificate only takes someone's identity key. Nobody knows this
        // person's own devices better than this one, and whoever this is never signed in.
        stale.push(member.leaf);
        const warned = `${groupId}/own/${member.deviceId}`;
        if (!this.warnedLeaves.has(warned)) {
          this.warnedLeaves.add(warned);
          this.emit({
            type: "security",
            serverId: this.serverId,
            userId: member.userId,
            message: "A device claiming to be yours, which never signed in, tried to join one of your conversations. It's being removed.",
          });
        }
      }
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
    this.announceConfirmedRemovals(groupId);
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
        void this.uploadPins().catch(() => undefined);
        this.emit({ type: "users", serverId: this.serverId });
        this.emitConversations();
        this.rescheduleAffectedByDeviceChange((data as ApiUser).id);
        break;
      case "vault":
        void this.syncVault().catch((error) => console.warn("[zuna] vault", error));
        break;
      case "account":
        this.syncAccountSoon();
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

  /** What a reaction is, if it's what it says: the signature says whose it is, and the authenticated data which message it's on. */
  private openReaction(groupId: string, messageId: string, reaction: ApiReaction): ReturnType<typeof parseReaction> {
    const key = this.epochKey(groupId, reaction.epoch);
    if (!key) return null;
    const data = decode(reaction.data);
    const signed = readSigned(data);
    if (signed) {
      const device = this.users.get(reaction.user_id)?.devices.get(signed.deviceId);
      if (!device || signed.epoch !== reaction.epoch) return null;
      const opened = openEnvelope<{ id?: unknown }>(key, device.signatureKey, "reaction", groupId, messageId, reaction.epoch, signed.envelope);
      return opened.ok && opened.value?.id === reaction.id ? parseReaction(opened.value) : null;
    }
    // From before reactions were signed, with only its ID to say whose it is.
    const opened = parseReaction(openSignal<unknown>(key, "reaction", groupId, data));
    return opened && reactionId(reaction.user_id, messageId, opened.key) === reaction.id ? opened : null;
  }

  private openReactions(groupId: string, messageId: string, raw: ApiReaction[]): ReactionView[] {
    const grouped = new Map<string, ReactionView>();
    for (const reaction of raw) {
      const opened = this.openReaction(groupId, messageId, reaction);
      if (!opened) continue;
      const entry = grouped.get(opened.key) ?? { key: opened.key, emote: opened.emote, userIds: [] };
      if (!entry.userIds.includes(reaction.user_id)) entry.userIds.push(reaction.user_id);
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
    // A message's author never changes. A signature only proves who signed what's arriving now.
    if (existing && existing.sender_user !== message.sender_user) {
      this.warnOnce(`author/${message.group_id}/${message.id}`, "The server tried to change who wrote a message in one of your conversations. The message was left as it was.");
      return;
    }
    let status: MessageStatus = "sent";
    let body: StoredBody | null = null;
    let raw: Uint8Array | null = null;
    // Nothing local is erased on the server's word: only a deletion its author, or a
    // group's admin, signed does that. Otherwise the copy is hidden, and kept a while.
    const kept = message.deleted_at !== null && existing && (existing.body || existing.raw) && !this.deletionProven(message) ? existing : null;
    let heldAfterLeaving: Uint8Array | null = null;
    if (!message.deleted_at && message.envelope) {
      const envelope = decode(message.envelope);
      const key = this.epochKey(message.group_id, message.epoch);
      const device = this.users.get(message.sender_user)?.devices.get(message.sender_device);
      if (!this.couldBeSent(message)) {
        status = "unverified";
        raw = envelope;
      } else if (!key || !device) {
        status = "undecryptable";
        raw = envelope;
      } else {
        const opened = openEnvelope<unknown>(key, device.signatureKey, "message", message.group_id, message.id, message.epoch, envelope);
        if (opened.ok && !namesItsSender(opened.value, message.sender_user, message.sender_device)) {
          status = "unverified";
          raw = envelope;
        } else if (opened.ok) {
          this.keyProvedItself(message.group_id, message.epoch);
          const parsed = parseMessageBody(opened.value);
          if (parsed && this.changedAfterLeaving(message, existing, parsed)) {
            status = "unverified";
            raw = envelope;
            heldAfterLeaving = existing!.body;
          } else if (parsed) {
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
      : (kept?.body ?? heldAfterLeaving);

    let rowId: number;
    const isNew = !existing || existing.seq === null;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, created_at, edited_at, deleted_at, pinned_at, pinned_by, status, body, raw, unproven_delete_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(group_id, id) DO UPDATE SET seq = excluded.seq, updated_seq = excluded.updated_seq, sender_device = excluded.sender_device,
           epoch = excluded.epoch, created_at = excluded.created_at, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at,
           pinned_at = excluded.pinned_at, pinned_by = excluded.pinned_by, status = excluded.status, body = excluded.body, raw = excluded.raw,
           unproven_delete_at = excluded.unproven_delete_at`,
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
          kept ? kept.status : status,
          stored,
          kept ? kept.raw : raw,
          kept ? (kept.unproven_delete_at ?? Date.now()) : null,
        ],
      );
      rowId = this.db.get<{ row_id: number }>("SELECT row_id FROM messages WHERE group_id = ? AND id = ?", [message.group_id, message.id])!.row_id;
      this.db.run("DELETE FROM search WHERE rowid = ?", [rowId]);
      this.db.run("DELETE FROM media WHERE row_id = ?", [rowId]);
      if (body) this.indexMessage(rowId, message.group_id, body);
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

  /**
   * Only the server enforces that content is sent under the current epoch, so a
   * malicious server working with someone removed could slip in new-looking
   * messages under an old key. This catches a message from a device in an epoch
   * after it left, and one that came after a later epoch had already begun. Genuinely
   * old messages are unaffected: they fit the order the group's commits came in.
   */
  private couldBeSent(message: ApiMessage): boolean {
    const left = this.departedAt(message.group_id, message.sender_device);
    if (left !== null && message.epoch >= left) return false;
    const next =this.db.get<{ seq: number }>("SELECT seq FROM epoch_starts WHERE group_id = ? AND epoch = ?", [message.group_id, message.epoch + 1]);
    return !next || message.seq < next.seq;
  }

  /**
   * Whether this changes what a message says, from a device this one already saw
   * leave the group. An edit keeps the message's place, so it gets past couldBeSent
   * when sealed under a key from before the device left, which it still holds. An
   * honest server refuses that, so it can only be one made before it left that's
   * arriving late, or one made after with the server's help, and this can't tell.
   * The copy held stays, so trying again later still finds the change.
   */
  private changedAfterLeaving(message: ApiMessage, existing: MessageRow | undefined, parsed: MessageBody): boolean {
    if (!existing?.body || existing.seq === null || this.departedAt(message.group_id, message.sender_device) === null) return false;
    const held = parseMessageBody(this.openJson<StoredBody>("message", existing.body));
    return !!held && JSON.stringify(held) !== JSON.stringify(parsed);
  }

  /**
   * Whether a deletion is what its author, or in a group one of its admins, asked
   * for: their device signed it, under an epoch from before that device left.
   * Who's an admin is the server's word, as it is for history grants.
   */
  private deletionProven(message: ApiMessage): boolean {
    if (!message.deletion || !message.deleted_by) return false;
    const signed = readSigned(decode(message.deletion));
    if (!signed) return false;
    const key = this.epochKey(message.group_id, signed.epoch);
    const device = this.users.get(message.deleted_by)?.devices.get(signed.deviceId);
    if (!key || !device) return false;
    const left = this.departedAt(message.group_id, signed.deviceId);
    if (left !== null && signed.epoch >= left) return false;
    const opened = openEnvelope<{ by?: unknown }>(key, device.signatureKey, "deletion", message.group_id, message.id, signed.epoch, signed.envelope);
    if (!opened.ok || opened.value?.by !== message.deleted_by) return false;
    if (message.deleted_by === message.sender_user) return true;
    const group = this.groups.get(message.group_id);
    return group?.kind === "group" && this.isGroupAdmin(group, message.deleted_by);
  }

  /** A copy kept after a deletion nobody proved goes once that's long enough ago. */
  private forgetUnprovenDeletions(): void {
    this.db.run("UPDATE messages SET body = NULL, raw = NULL, unproven_delete_at = NULL WHERE unproven_delete_at < ?", [Date.now() - REMOVED_KEPT_MS]);
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
    // A copy kept after a deletion the server claimed stays out of sight.
    const stored = row.deleted_at === null ? this.storedBody(row) : {};
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
    if (body.sentAt !== undefined && Math.abs(body.sentAt - (row.edited_at ?? row.created_at)) > TIME_DIFFERS_MS) view.timeDiffers = true;
    return view;
  }

  private replyPreview(groupId: string, id: string): ReplyPreview {
    const row = this.messageRow(groupId, id);
    if (!row) return { id, senderId: "", text: "", hasAttachment: false, deleted: false };
    if (!row.body || row.deleted_at !== null) return { id, senderId: row.sender_user, text: "", hasAttachment: false, deleted: row.deleted_at !== null };
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
        historyVisible: this.sharesHistory(group),
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
    await this.writeManifest();
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

  /** How many photos, files, links and so on a chat holds, among its messages on this device. */
  mediaCounts(groupId: string): MediaCounts {
    const counts = Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, 0])) as MediaCounts;
    const rows = this.db.all<{ kind: string; count: number }>(
      `SELECT d.kind, SUM(d.count) AS count FROM media d JOIN messages m ON m.row_id = d.row_id
       WHERE d.group_id = ? AND m.deleted_at IS NULL AND m.status = 'sent' GROUP BY d.kind`,
      [groupId],
    );
    for (const row of rows) {
      const kind = MEDIA_KINDS.find((item) => this.mediaTags.get(item) === row.kind);
      if (kind) counts[kind] = Number(row.count);
    }
    return counts;
  }

  /** A page of a chat's messages that hold one kind, newest first, from those on this device. */
  loadMedia(groupId: string, kind: MediaKind, before?: number, limit = PAGE_SIZE): { messages: MessageView[]; hasMore: boolean } {
    const rows = this.db.all<MessageRow>(
      `SELECT m.* FROM media d JOIN messages m ON m.row_id = d.row_id
       WHERE d.group_id = ? AND d.kind = ? AND m.deleted_at IS NULL AND m.status = 'sent' AND m.seq < ?
       ORDER BY m.seq DESC LIMIT ?`,
      [groupId, this.mediaTags.get(kind) ?? "", before ?? Number.MAX_SAFE_INTEGER, limit + 1],
    );
    return { messages: rows.slice(0, limit).map((row) => this.toMessageView(row)), hasMore: rows.length > limit };
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
    // Whoever this message is for is who the person chose, whatever else the server says.
    const people = new Set([this.account.userId, peerId]);
    const listed = new Set(created.group.members.map((member) => member.user_id));
    // A conversation this device already knows stays what it was, so naming one for someone else changes nothing.
    const held = this.groups.get(created.group.id);
    const elsewhere = !!held && (held.kind !== "dm" || held.peerId !== peerId);
    if (created.group.kind !== "dm" || elsewhere || listed.size !== people.size || [...people].some((id) => !listed.has(id))) {
      this.warnOnce(`dm-reply/${created.group.id}`, "The server answered with the wrong people for a new direct message, so nothing was sent.");
      throw new Error("This message wasn't sent: the server's answer about this conversation doesn't hold together.");
    }
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

  /**
   * Sends a message. It appears immediately and survives restarts until delivered.
   * With `previewUrl`, a link whose preview isn't made yet, it waits a moment for
   * that preview, so a link pasted and sent at once still gets one.
   */
  sendMessage(groupKey: string, body: MessageBody, options: { previewUrl?: string } = {}): MessageView {
    assertSendable(body);
    const id = randomId();
    const view = this.ensureLocalEcho(groupKey, id, body);
    this.enqueue(groupKey, { kind: "message", id, body, previewUrl: this.pendingPreview(body, options.previewUrl) });
    return view;
  }

  /** How link previews are made on this device, if they are. */
  linkPreview: ((url: string) => Promise<LinkPreview | null>) | null = null;

  private pendingPreview(body: MessageBody, url: string | undefined): string | undefined {
    return url && !body.preview && this.linkPreview && body.text?.includes(url) ? url : undefined;
  }

  /** Adds a preview that's ready within a few seconds to a message about to go, and shows it here too. */
  private async withPreview(groupKey: string, id: string, body: MessageBody, url: string): Promise<MessageBody> {
    const made = this.linkPreview?.(url).catch(() => null) ?? Promise.resolve(null);
    const preview = await Promise.race([made, new Promise<null>((resolve) => setTimeout(() => resolve(null), PREVIEW_WAIT_MS))]);
    if (!preview || !body.text?.includes(preview.url)) return body;
    const withPreview: MessageBody = { ...body, preview };
    const groupId = this.groupForKey(groupKey)?.id ?? `pending:${groupKey}`;
    this.db.run("UPDATE messages SET body = ? WHERE group_id = ? AND id = ?", [this.sealJson("message", withPreview), groupId, id]);
    const row = this.messageRow(groupId, id);
    if (row) this.emit({ type: "message", serverId: this.serverId, message: this.toMessageView(row), isNew: false });
    return withPreview;
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
          const envelope = sealEnvelope(key, this.account.deviceSecret, "message", entry.groupId, entry.id, epoch, this.signedBody(entry.body));
          this.ingest(await this.api.editMessage(entry.groupId, entry.id, epoch, envelope), false);
        }),
      );
      return;
    }
    // Messages go in order, so the ones after it wait for its preview too.
    const body = entry.previewUrl ? await this.withPreview(groupKey, entry.id, entry.body, entry.previewUrl) : entry.body;
    const groupId = await this.groupIdForKey(groupKey);
    await this.withLock(groupId, async () => {
      await this.ensureReady(groupId);
      await this.rotateIfOld(groupId);
      this.moveLocalEcho(groupKey, groupId, entry.id);
      await this.sealAndRetry(groupId, async (epoch, key) => {
        const envelope = sealEnvelope(key, this.account.deviceSecret, "message", groupId, entry.id, epoch, this.signedBody(body));
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

  /** What goes under this device's signature: the message, when it was sent, and who's sending it. */
  private signedBody(body: MessageBody): MessageBody & { sentAt: number; by: { user: string; device: string } } {
    return { ...body, sentAt: Date.now(), by: { user: this.account.userId, device: this.account.deviceId } };
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
      this.refuseDoubtful(groupId);
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
    // A leaf with an older certificate gets the new one in any commit, and that's
    // how everyone sharing this group finds out about a rotation the server may be keeping from them.
    const old = !!row && Date.now() - row.created_at >= EPOCH_MAX_AGE_MS;
    if (!old && !this.leafIsBehind(groupId)) return;
    await this.commitWithRetry(groupId, async () => ({ kind: "update" }));
  }

  private leafIsBehind(groupId: string): boolean {
    const groupBytes = utf8(groupId);
    const own = this.mls.ownLeafIndex(groupBytes);
    const members = this.mls.members(groupBytes) as { leafIndex: number; credential: Uint8Array }[];
    const leaf = members.find((member) => member.leafIndex === own);
    return !!leaf && !equalBytes(leaf.credential, this.account.certificate);
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
    await this.deleteSigned(groupId, id);
    this.emitConversations();
  }

  /** Deletes several messages for everyone, in order. */
  async deleteMessages(groupId: string, ids: string[]): Promise<void> {
    for (const id of ids) await this.deleteSigned(groupId, id);
    this.emitConversations();
  }

  /** This device signs the deletion, so other members' apps can tell it from the server's word before erasing their copies. */
  private async deleteSigned(groupId: string, id: string): Promise<void> {
    const { userId, deviceId, deviceSecret } = this.account;
    await this.withLock(groupId, () =>
      this.sealAndRetry(groupId, async (epoch, epochKey) => {
        const deletion = frameSigned(deviceId, epoch, sealEnvelope(epochKey, deviceSecret, "deletion", groupId, id, epoch, { by: userId }));
        this.ingest(await this.api.deleteMessage(groupId, id, epoch, deletion), false);
      }),
    );
  }

  async setPinned(groupId: string, id: string, pinned: boolean): Promise<void> {
    this.ingest(await this.api.pin(groupId, id, pinned), false);
  }

  async toggleReaction(groupId: string, messageId: string, key: string, emote?: EmoteRef): Promise<void> {
    const { userId, deviceId, deviceSecret } = this.account;
    const row = this.messageRow(groupId, messageId);
    const current = row ? (this.storedBody(row)?.reactions ?? []) : [];
    const already = current.some((item) => item.key === key && item.userIds.includes(userId));
    await this.withLock(groupId, async () => {
      if (already) {
        // Another device may have made it, or two devices the same one, and only an open reaction says what it is.
        const { reactions } = await this.api.message(groupId, messageId);
        for (const reaction of reactions) {
          if (reaction.user_id !== userId || this.openReaction(groupId, messageId, reaction)?.key !== key) continue;
          this.ingest(await this.api.removeReaction(groupId, messageId, reaction.id), false);
        }
        return;
      }
      const id = randomId();
      await this.sealAndRetry(groupId, async (epoch, epochKey) => {
        const data = frameSigned(deviceId, epoch, sealEnvelope(epochKey, deviceSecret, "reaction", groupId, messageId, epoch, { id, key, emote }));
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
    const { userId, deviceId, deviceSecret, accountKey } = this.account;
    let framed: Uint8Array;
    if (this.prefs.sendReadReceipts) {
      const key = this.epochKey(groupId, epoch);
      if (!key) return;
      framed = frameSigned(deviceId, epoch, sealEnvelope(key, deviceSecret, "read", groupId, userId, epoch, { seq }));
    } else {
      // The position is sealed to our own account key, so our other devices stay
      // in sync while nobody else can read it.
      const sealed = sealSignal(accountKey, "read", groupId, epoch, { seq });
      framed = new Uint8Array(sealed.length + 1);
      framed[0] = 1;
      framed.set(sealed, 1);
    }
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
    options: { previewUrl?: string } = {},
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
      this.enqueue(groupKey, {
        kind: "message",
        id,
        body: finalBody,
        fileIds: attachments.map((item) => item.fileId),
        previewUrl: this.pendingPreview(finalBody, options.previewUrl),
      });
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
    const { core, userId, username } = this.account;
    const sealed = sealProfile(core.communityKey, core.rootSecret, username, profile);
    const head = this.headOf(userId);
    await this.api.updateMe({
      profile: sealed,
      profile_sig: head ? signProfileAtGeneration(core.identitySecret, userId, head.gen, sealed) : undefined,
      avatar_file: avatarFile,
    });
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
    if (this.modern) this.rotateSoon(rotationTiming.gatherMs);
  }

  async changePassword(current: string, next: string): Promise<void> {
    const { username, accountKey, core } = this.account;
    if (!this.modern) return changePassword(this.api, username, accountKey, current, next);
    const { plan, keys } = await planPasswordChange(this.api, username, current, next, core);
    await this.rotateProving(plan, keys);
  }

  async regenerateRecoveryKey(current: string): Promise<string> {
    const { username, accountKey, core } = this.account;
    if (!this.modern) return regenerateRecoveryKey(this.api, username, accountKey, current);
    const { plan, keys, recoveryKey } = await planRecoveryChange(this.api, username, current, core);
    await this.rotateProving(plan, keys);
    return recoveryKey;
  }

  /** Rotates, and if the current password was refused, sees whether it only needs moving to a newer sign-in key. */
  private async rotateProving(plan: RotationPlan, keys: { authKey: Uint8Array; legacyAuthKey: Uint8Array }): Promise<void> {
    try {
      await this.rotate(plan);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "invalid_credentials") throw error;
      const target = { serverUrl: this.api.baseUrl, username: this.account.username };
      await upgradeSignInKey(this.api, target, "password", keys, error);
      await this.rotate(plan);
    }
  }

  async signOut(): Promise<void> {
    await this.api.logout().catch((error) => console.warn("[zuna] logout", error));
    this.stop();
  }

  // --- Identity verification ---

  safetyCheck(userId: string): SafetyCheck | null {
    const user = this.users.get(userId);
    if (!user) return null;
    const { core, userId: selfId } = this.account;
    // Only the keys in use now show that two people hold the same chain. Someone on
    // a client from before generations can't compute that, so both go by the first keys.
    const legacy = [selfId, userId].some((id) => [...(this.users.get(id)?.devices.values() ?? [])].some((device) => !device.revoked && device.legacy !== false));
    const theirs = this.forkHeads.get(userId) ?? this.headOf(userId)?.identity ?? user.identityKey;
    return {
      emoji: legacy ? safetyEmoji(core.rootPublic, user.identityKey) : safetyEmoji(core.identityPublic, theirs),
      trust: user.trust,
      covers: legacy ? `roots:${toBase64(user.identityKey)}` : `heads:${toBase64(theirs)}`,
    };
  }

  /**
   * The person compared the emoji `covers` names, so that key is the only one this
   * goes by, whatever the server says by now. If nothing shown fits it any more,
   * nothing changes, and the emoji have to be compared again.
   */
  async markVerified(userId: string, covers: string): Promise<void> {
    const root = this.pinnedIdentity(userId);
    if (!root || !this.users.has(userId)) return;
    const [scheme, encoded] = covers.split(":");
    const compared = fromBase64(encoded ?? "");
    const outdated = new Error("What you compared isn't what the server shows now. Compare the emoji again.");
    let pin = root;
    let chain: Link[] | null = null;
    if (!equalBytes(compared, scheme === "heads" ? (this.headOf(userId)?.identity ?? root) : root)) {
      // Only a chain ending in exactly that key can replace what's held.
      const shown = scheme === "heads" && this.identityState(userId).forked ? await this.readWholeChain(userId, root).catch(() => null) : null;
      if (shown && equalBytes(shown.at(-1)?.identity ?? root, compared)) {
        chain = shown;
      } else {
        // Otherwise it's a first key that isn't the one known, which leaves a chain from that one with nothing to follow from.
        if (scheme === "heads" && this.chainOf(userId).length > 0) throw outdated;
        pin = compared;
        if (scheme !== "heads") chain = [];
      }
    }
    const user = this.users.get(userId);
    if (!user || !equalBytes(user.identityKey, pin)) throw outdated;

    const repinned = !equalBytes(pin, root);
    const forked = !!this.identityState(userId).forked;
    this.db.transaction(() => {
      if (chain) {
        this.db.run("DELETE FROM identity_chain WHERE user_id = ?", [userId]);
        this.chains.delete(userId);
        for (const link of chain) this.acceptLink(userId, link);
      }
      if (forked) this.updateIdentityState(userId, "forked = 0, known_generation = 0, known_hash = NULL, chain_uploaded = 0", []);
      if (repinned) this.db.run("UPDATE pinned_identities SET identity_key = ?, uploaded = 0 WHERE user_id = ?", [pin, userId]);
      this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, pin]);
      this.setVerifiedPosition(userId, this.headGeneration(userId));
    });
    this.forkHeads.delete(userId);
    if (chain || forked || repinned) {
      const fresh = await this.api.user(userId).catch(() => null);
      if (fresh) this.applyUser(fresh);
      this.rescheduleAffectedByDeviceChange(userId);
    }
    this.refreshTrust(userId);
    this.emit({ type: "users", serverId: this.serverId });
    await this.putVault(`verified:${userId}`, pin).catch((error) => console.warn("[zuna] saving verification", error));
    await this.uploadPins().catch((error) => console.warn("[zuna] saving a known key", error));
  }

  async clearVerification(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    // An empty key says it was cleared, which the manifest carries to other devices.
    this.db.run("INSERT OR REPLACE INTO verified(user_id, identity_key) VALUES(?, ?)", [userId, new Uint8Array(0)]);
    user.trust = this.trustOf(userId, user.identityKey);
    this.persistUser(user);
    this.emit({ type: "users", serverId: this.serverId });
    await this.putVault(`verified:${userId}`, new Uint8Array(0)).catch(() => undefined);
    await this.writeManifest();
  }

  // --- Group management ---

  async createGroup(name: string, memberIds: string[], historyVisible: boolean, avatarBlob?: Blob): Promise<string> {
    let avatar: AvatarRef | null = null;
    if (avatarBlob) {
      const ref = await this.uploadBlob(avatarBlob, undefined, true);
      avatar = { ...ref, mime: this.files.type(avatarBlob) || "image/webp" };
    }
    const created = await this.api.createGroup(historyVisible);
    if (created.group.kind !== "group" || created.group.created_by !== this.account.userId) {
      throw new Error("The group wasn't created: the server's answer doesn't hold together.");
    }
    const groupId = created.group.id;
    this.applyGroup(created.group);
    await this.withLock(groupId, async () => {
      await this.initGroup(created.group, memberIds, { name, avatar, historyVisible });
      this.addSystemRow(groupId, Date.now(), this.account.userId, { type: "group_created", actorId: this.account.userId });
    });
    this.emitConversations();
    return groupId;
  }

  async addMembers(groupId: string, userIds: string[]): Promise<void> {
    await this.withLock(groupId, async () => {
      await this.commitWithRetry(groupId, async () => {
        const group = await this.api.group(groupId);
        const cached = this.applyGroup(group);
        const missing = userIds.filter((id) => !group.members.some((member) => member.user_id === id));
        const packages: { deviceId: string; data: Uint8Array }[] = [];
        for (const userId of missing) packages.push(...(await this.claimKeyPackages(userId)));
        if (packages.length === 0) throw new Error("Those people have no devices available to add.");
        let grants: { user_id: string; data: Uint8Array }[] | undefined;
        if (this.sharesHistory(cached)) {
          // Hand older epoch keys to each new member, sealed so that only they can read them.
          grants = [];
          const keys = this.allEpochKeys(groupId);
          for (const userId of missing) {
            const user = await this.ensureUser(userId, true);
            if (!user) continue;
            const apiUser = await this.api.user(userId);
            // A chain's newest link names this key itself, and was checked when it came.
            if (!this.headOf(userId) && !verifyHpkeKey(this.pinnedIdentity(userId) ?? user.identityKey, user.hpkeKey, decode(apiUser.hpke_key_sig))) continue;
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
    if (historyVisible !== undefined) meta.historyVisible = historyVisible;
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

  // --- Search index ---

  /** Builds the search index again after the way it's hashed changed, a little at a time. */
  private async rebuildSearchIndex(): Promise<void> {
    if (this.getKv<number>("search_version") === SEARCH_INDEX_VERSION) return;
    try {
      this.db.run("DELETE FROM search");
      this.db.run("DELETE FROM media");
      let after = 0;
      for (;;) {
        const rows = this.db.all<MessageRow>("SELECT * FROM messages WHERE row_id > ? AND body IS NOT NULL ORDER BY row_id LIMIT ?", [after, SEARCH_REBUILD_BATCH]);
        if (rows.length === 0) break;
        this.db.transaction(() => {
          for (const row of rows) {
            after = row.row_id;
            const body = this.storedBody(row);
            if (body) this.indexMessage(row.row_id, row.group_id, body);
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      this.setKv("search_version", SEARCH_INDEX_VERSION);
    } catch (error) {
      console.warn("[zuna] rebuilding the search index", error);
    }
  }

  /**
   * Indexes a message's words for search, and what it holds for its chat's details.
   * The rebuild can reach a message ingested while it ran, so either may come second.
   */
  private indexMessage(rowId: number, groupId: string, body: MessageBody): void {
    const words = [body.text ?? "", ...(body.attachments ?? []).map((item) => item.name)].join(" ");
    const tokens = indexTokens(this.searchKey, words);
    if (tokens) this.db.run("INSERT OR REPLACE INTO search(rowid, tokens) VALUES(?, ?)", [rowId, tokens]);
    for (const [kind, count] of mediaIn(body)) {
      this.db.run("INSERT OR REPLACE INTO media(row_id, group_id, kind, count) VALUES(?, ?, ?, ?)", [rowId, groupId, this.mediaTags.get(kind)!, count]);
    }
  }
}
