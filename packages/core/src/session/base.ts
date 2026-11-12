// The state every part of ServerSession shares, and its constructor.
//
// ServerSession is one class, written in parts that each extend the one before:
// SessionBase, SessionLocal (local.ts), SessionVault (vault.ts), SessionChains (chains.ts),
// SessionDirectory (directory.ts), SessionRotation (rotation.ts), SessionGroups (groups.ts), SessionJoining (joining.ts),
// SessionChanges (changes.ts), SessionIngest (ingest.ts), SessionConversations
// (conversations.ts), SessionSending (sending.ts), SessionManagement (management.ts),
// SessionChannels (channels.ts), SessionServer (server.ts), SessionLifecycle (lifecycle.ts),
// and then ServerSession itself, in ../session.ts. A part calls those before it directly, and
// those after it through the abstract members at the end of this class, which TypeScript checks
// against each one.

import * as wasm from "@zuna/crypto";
import { Api, type ApiCall, type ApiChannel, type ApiDevice, type ApiGroup, type ApiMessage, type ApiSound, type ApiUser, type ApiVoiceState } from "../api";
import type { AccountState } from "../account";
import type { Link } from "../generations";
import { toBase64, utf8 } from "../encoding";
import type { LocalDb } from "../db";
import { blobFiles, type FileAdapter } from "../files";
import type { TrustManifest } from "../manifest";
import { MEDIA_KINDS } from "../media";
import { mediaTag } from "../search";
import { Socket, type SocketFrame } from "../socket";
import type { SignedRoster } from "../roster";
import type { WatchState } from "../watch";
import type { ConnectionState, CoreEvent, EmoteSet, LinkPreview, MediaKind, MessageBody, Preferences, PushSettings, ServerInfo, SystemEvent, VoiceUpdate } from "../types";
import type { IdentityState, CachedUser, GroupMeta, CachedGroup, CachedChannel, CachedSound, Mutex } from "./shared";
import type { LogStanding } from "./directory";
import type { Standing } from "./chains";

export abstract class SessionBase {
  readonly api: Api;
  protected mls: wasm.MlsClient;
  protected users = new Map<string, CachedUser>();
  protected groups = new Map<string, CachedGroup>();
  protected online = new Set<string>();
  /** Presence that came while the people were being listed, which is newer than the list's. */
  protected presenceWhileListing: Map<string, boolean> | null = null;
  /** Until when each person shows as online for something they did that this device saw (`madeAction`), in ms, and what ends it. */
  protected actedUntil = new Map<string, number>();
  protected actedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Waits to list the people again once older messages have moved their last seen on. */
  protected lastSeenMoved: ReturnType<typeof setTimeout> | undefined;
  protected prefs: Preferences = { pinned: [], hidden: [], muted: [], sendReadReceipts: true };
  /** Whether the person is using this device, and another of theirs, as the server last said. */
  protected active = false;
  protected activeElsewhere = false;
  /**
   * Whether the server takes this device to be in use, as it last said. It follows `active` a
   * moment behind, and it's what the server goes by when it pushes a phone nothing.
   */
  protected seenInUse = false;
  /** When the person last stopped using this device, and last used another one that isn't in use now (ms). */
  protected leftHereAt = 0;
  protected usedElsewhereAt = 0;
  /** Notifications waiting while the person is on another device. */
  protected waitingNotifications = new Set<ReturnType<typeof setTimeout>>();
  /** What the app asked for notifications: where to push, "off" to stop them, or null if it never said. */
  protected push: PushSettings | "off" | null = null;
  protected deviceNames = new Map<string, string>();
  protected locks = new Map<string, Mutex>();
  protected epochKeys = new Map<string, Uint8Array>();
  /** Messages that arrived live before their keys did, notified once they open. */
  protected awaitingKeys = new Set<string>();
  /** Devices something here named that this device is asking the server about (`learnDevice`). */
  protected learning = new Set<string>();
  protected syncing = new Map<string, { again: boolean; done: Promise<void> }>();
  protected socket: Socket;
  protected connection: ConnectionState = "connecting";
  protected info: ServerInfo | null = null;
  protected emoteSet: EmoteSet = { set_id: "", set_name: "", emotes: [] };
  protected searchKey: Uint8Array;
  /** The keyed name of each kind in the local index of what messages hold. */
  protected mediaTags: Map<MediaKind, string>;
  /** The same index's keyed name for a message that mentions this account or replies to it. */
  protected mentionTag: string;
  protected usersCursor = 0;
  protected lastTypingSent = new Map<string, number>();
  protected flushing: Promise<void> | null = null;
  /** Something came to wait while the outbox was being sent, which another pass sends. */
  protected flushAgain = false;
  protected flushRetry: ReturnType<typeof setTimeout> | undefined;
  /** Chats whose next message a channel's slow mode holds back, by conversation key, and until when (ms). */
  protected slowHeld = new Map<string, number>();
  /**
   * Chats whose last send failed in a way that may pass, until when, and how long the next wait
   * is, from 2.5 seconds doubling to half a minute: each waits on its own, and every other chat's messages go meanwhile.
   */
  protected retryHeld = new Map<string, number>();
  protected retryDelay = new Map<string, number>();
  /** Updates the conversations when the next chat muted for a while is heard again. */
  protected muteTimer: ReturnType<typeof setTimeout> | undefined;
  /** Erases the next disappearing message when it's due, and when that is (ms). */
  protected expiryTimer: ReturnType<typeof setTimeout> | undefined;
  protected nextExpiry = Infinity;
  protected reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When this device fetches more tokens, having run low (`topUpTokensSoon`). */
  protected tokenTopUp: ReturnType<typeof setTimeout> | undefined;
  /** Groups whose send key the server holds wrong, waiting for this device to put it right (`checkSendKey`). */
  protected sendKeyFixes = new Map<string, ReturnType<typeof setTimeout>>();
  /** The epoch and send key last found right for each group, so it isn't worked out again each time. */
  protected sendKeysChecked = new Map<string, string>();
  protected stopped = false;
  /** Why the server says this session is over, if it has. */
  protected signedOutReason: string | null = null;
  protected deletingAccount = false;
  protected signedOutRetry: ReturnType<typeof setTimeout> | undefined;
  /** The epoch each group's key was last checked against MLS at. */
  protected confirmedEpochs = new Map<string, number>();
  /**
   * Groups this device is joining by an external commit the server hasn't taken yet. MLS is already at the epoch
   * the join makes, which another device's join may win instead, so nothing keeps that epoch's key until it's taken.
   */
  protected externalJoins = new Set<string>();
  /** The epoch each group's tree was last found clean at, so sending needn't check it every time. */
  protected cleanEpochs = new Map<string, number>();
  /** Who holds each group's keys now, for showing its members. */
  protected treeUsersCache = new Map<string, Set<string>>();
  /**
   * certificateStanding's answers, by everything they're worked out from: whose it is, the key
   * pinned for them, their chain link by link, and the certificate itself. A commit checks every
   * leaf of the tree many times, each a signature check, and the answer can't differ for the same
   * inputs, so nothing about it can go stale.
   */
  protected standingCache = new Map<string, Standing | null>();
  protected rosters = new Map<string, { text: string; signed: SignedRoster | null }>();
  /** Leaves already warned about, so one ghost makes one warning. */
  protected warnedLeaves = new Set<string>();
  /** Messages that later ones say were sent, and that haven't arrived, by group and ID. */
  protected missing = new Map<string, { groupId: string; id: string; userId: string }>();
  protected missingTimer: ReturnType<typeof setTimeout> | undefined;
  protected manifest: TrustManifest | null = null;
  protected manifestWrite: Promise<void> = Promise.resolve();
  protected resealing = new Set<string>();
  /** Each person's chain of identity keys as far as it's been checked, oldest first. */
  protected chains = new Map<string, Link[]>();
  protected following = new Map<string, Promise<void>>();
  /** The newest key of a chain that disagrees with the one held, for comparing with its owner. */
  protected forkHeads = new Map<string, Uint8Array>();
  /** A device of this account is gone and no generation covers that yet. */
  protected removalsUncovered = false;
  protected rotationOpen = false;
  protected rotationTimer: ReturnType<typeof setTimeout> | undefined;
  protected sealingTimer: ReturnType<typeof setTimeout> | undefined;
  protected sealing = false;
  /** Whether the server has said which generation this account is at, since this session began. */
  protected accountKnown = false;
  protected channels = new Map<string, CachedChannel>();
  /** Who's in the voice channels and the calls, by device. */
  protected voiceStates = new Map<string, ApiVoiceState>();
  /** The calls going on in this person's conversations, by group. */
  protected calls = new Map<string, ApiCall>();
  /** The soundboard, by sound: only those whose details open and were signed by someone here. */
  protected sounds = new Map<string, CachedSound>();
  /** Sounds' files once fetched and checked, by file. */
  protected soundFiles = new Map<string, Promise<Blob>>();
  /** Sounds played lately, by the value each was sealed with, so one handed on again doesn't play twice. */
  protected playsSeen = new Map<string, number>();
  /**
   * The voice channel or call this device is in, what it says it's doing there, the epoch its key was
   * last for, and whether it still has to say it's starting the call, which rings everyone else.
   */
  protected activeVoice: { channelId: string; update: VoiceUpdate; epoch: number; ring: boolean } | null = null;
  /** What the room this device is in watches together, which is forgotten on leaving it. */
  protected watch: { channelId: string; state: WatchState } | null = null;
  /** The room this device has yet to ask what's on in, once the server says it's there. */
  protected watchAskFor: string | null = null;
  /** Signals about what's watched lately, by the value each was sealed with, so one handed on again counts once. */
  protected watchSeen = new Map<string, number>();
  /** Answers about to go to someone who came into the room, by their device. */
  protected watchAnswers = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each device was last told what's on because what it sent was behind. */
  protected watchCorrected = new Map<string, number>();
  /** How a video's title and picture are fetched on this device, if they are. */
  videoPreview: ((id: string) => Promise<{ title?: string; author?: string; image?: { data: string; width: number; height: number } }>) | null = null;
  protected voiceKeyTimer: ReturnType<typeof setTimeout> | undefined;
  protected joiningChannels: Promise<void> | null = null;
  protected grantTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Called when the server told us this session is over (banned, revoked). */
  onSignedOut: ((reason: string) => void) | null = null;
  /** Called when a session that seemed to be over turns out to be working. */
  onSignedIn: (() => void) | null = null;
  /** Called with what has to be kept for next time, when it changes. */
  onAccountChanged: ((account: AccountState) => void) | null = null;

  protected syncingAll: { again: boolean; done: Promise<void> } | null = null;
  protected uploadingKeys: { again: boolean; done: Promise<void> } | null = null;
  /** Groups being fetched because something arrived in one this device didn't know of. */
  protected discovering = new Set<string>();
  /** Replies' targets the server wouldn't give this member, by group and ID, so a page doesn't ask again each time it opens. */
  protected unreachableReplies = new Set<string>();
  /** How link previews are made on this device, if they are. */
  linkPreview: ((url: string) => Promise<LinkPreview | null>) | null = null;
  /** What each bot of this person's signed to show its key is the one its setup link made, as the server gave it. */
  protected botProofs = new Map<string, string>();

  constructor(
    readonly serverId: string,
    protected account: AccountState,
    protected readonly db: LocalDb,
    protected readonly dbKey: Uint8Array,
    protected readonly emit: (event: CoreEvent) => void,
    protected readonly deviceName: string,
    protected readonly files: FileAdapter = blobFiles,
    /** The app shows channels. One that doesn't takes no part in them. */
    protected readonly channelsOn: boolean = false,
    /** The app has calls in direct messages and groups. One that doesn't hears nothing of them. */
    protected readonly callsOn: boolean = false,
    /** The app lists bots in a section of their own. One that doesn't is given no chat with a bot nobody has written to yet. */
    protected readonly botsOn: boolean = false,
    /** How requests that name nobody go, as the host gives it (`ZunaClientOptions.sealedFetch`). */
    sealedFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    this.api = new Api(account.serverUrl);
    this.api.token = account.token;
    if (sealedFetch) this.api.sealedFetch = sealedFetch;
    this.api.prove = (input) => wasm.sign(this.account.deviceSecret, input);
    this.searchKey = wasm.hkdfSha256(dbKey, new Uint8Array(0), utf8("zuna/local/search"), 32);
    this.mediaTags = new Map(MEDIA_KINDS.map((kind) => [kind, mediaTag(this.searchKey, kind)]));
    this.mentionTag = mediaTag(this.searchKey, "mention");

    const state = this.db.all<{ k: Uint8Array; v: Uint8Array }>("SELECT k, v FROM mls_kv");
    this.mls = new wasm.MlsClient(
      account.devicePublic,
      account.deviceSecret,
      account.certificate,
      state.map((row) => [row.k, this.openLocal("mls", toBase64(row.k), row.v)]) as unknown as any[],
    );
    this.socket = new Socket(account.serverUrl, () => this.account.token, {
      onReady: () => void this.onConnected(),
      onFrame: (frame) => this.onFrame(frame),
      onDisconnect: () => {
        this.setConnection("offline");
        // Unknown until the server says again; better to notify than to miss something.
        this.usedElsewhereAt = 0;
        this.seenInUse = false;
        if (this.activeElsewhere) {
          this.activeElsewhere = false;
          this.emit({ type: "activity", serverId: this.serverId, elsewhere: false });
        }
      },
      onUnauthorized: () => this.signedOut("session_ended"),
    });
    this.loadCache();
  }

  // Defined by the parts above, and called by those below them.
  abstract stop(): void;
  protected abstract setConnection(state: ConnectionState): void;
  protected abstract signedOut(reason: string): void;
  protected abstract onConnected(): Promise<void>;
  protected abstract openLocal(name: string, row: string, data: Uint8Array): Uint8Array;
  protected abstract loadCache(): void;
  protected abstract loadChains(): void;
  protected abstract headOf(userId: string): Link | null;
  protected abstract headGeneration(userId: string): number;
  protected abstract certificateStanding(userId: string, root: Uint8Array, certificate: Uint8Array): Standing | null;
  protected abstract identityState(userId: string): IdentityState;
  protected abstract noteChainPosition(userId: string, position: { gen: number; hash: string }): void;
  protected abstract noteVerifiedPosition(userId: string, generation: number): void;
  protected abstract followChain(userId: string): Promise<void>;
  protected abstract logCurrent(): boolean;
  protected abstract logStanding(userId: string, deviceId: string, key: Uint8Array, certificate: Uint8Array): LogStanding;
  protected abstract logVersion(userId: string): string;
  protected abstract loggedGeneration(userId: string): number;
  protected abstract loggedLink(userId: string, generation: number): Uint8Array | null;
  protected abstract loggedRootDisagrees(userId: string): boolean;
  protected abstract loggedSealKey(device: ApiDevice, seal: Uint8Array, generation: number): "newest" | "older" | "unlogged" | "unknown";
  protected abstract noteNewlyKnown(userId: string): void;
  protected abstract noteLogStatus(status: { era: number; size: number } | null | undefined): void;
  protected abstract loggedRoot(userId: string): Uint8Array | null;
  protected abstract syncLogIfBehind(since: number): Promise<void>;
  protected abstract headForManifest(): { key: string; era: number; size: number; root: string } | undefined;
  protected abstract manifestHeadBehind(held: { era: number; size: number } | undefined): boolean;
  protected abstract noteManifestHeadWritten(): void;
  protected abstract takeManifestHead(log: { key: string; era: number; size: number; root: string }): void;
  protected abstract sealKeyOf(device: ApiDevice, key: Uint8Array): Uint8Array | null;
  protected abstract checkRemovals(api: ApiUser): void;
  protected abstract rotateSoon(delay: number): void;
  protected abstract syncAccountSoon(): void;
  protected abstract saveEpochKey(groupId: string, epoch: number, key: Uint8Array, source: "mls" | "vault" | "grant"): void;
  protected abstract joinedEpoch(groupId: string): number | null;
  protected abstract topUpKeyPackages(): Promise<void>;
  protected abstract dmWith(userId: string): CachedGroup | undefined;
  protected abstract warnOnce(key: string, message: string, userId?: string): void;
  protected abstract emitNewDevices(): void;
  protected abstract applyGroup(api: ApiGroup): CachedGroup;
  protected abstract isGroupAdmin(group: CachedGroup, userId: string): boolean;
  protected abstract emitConversations(): void;
  protected abstract backgroundSync(groupId: string): void;
  protected abstract pullChanges(groupId: string): Promise<void>;
  protected abstract noteArrivals(groupId: string): void;
  protected abstract scheduleReconcile(groupId: string): void;
  protected abstract topUpTokensSoon(now?: boolean): void;
  protected abstract compareTokenKeys(tag: { p: number; h: string }, from: string): void;
  protected abstract checkSendKey(groupId: string, epoch: number, sendKey: string | null | undefined): void;
  protected abstract staleLeaves(groupId: string): Promise<number[]>;
  protected abstract rotateIfOld(groupId: string): Promise<void>;
  protected abstract onFrame(frame: SocketFrame): void;
  protected abstract rescheduleAffectedByDeviceChange(userId: string): void;
  protected abstract ingest(message: ApiMessage, live: boolean): void;
  protected abstract readableNow(message: ApiMessage): boolean;
  protected abstract disappearAfter(group: CachedGroup | undefined): number;
  protected abstract noteTimerChange(groupId: string, actorId: string, seconds: number): void;
  protected abstract retryUndecryptable(groupId: string): void;
  protected abstract addSystemRow(groupId: string, createdAt: number, actor: string, system: SystemEvent, seq?: number): void;
  protected abstract conversationKey(group: CachedGroup): string;
  protected abstract isBlocked(userId: string): boolean;
  protected abstract watchMutes(): void;
  protected abstract resendPush(): void;
  abstract markRead(groupId: string, seq: number): Promise<void>;
  abstract updateGroupMeta(groupId: string, changes: GroupMeta, avatarBlob?: Blob | null, historyVisible?: boolean): Promise<void>;
  protected abstract holdsCommunityKey(channelId: string, userId: string, proof: string | null | undefined): boolean;
  protected abstract applyChannels(list: ApiChannel[], save?: boolean): void;
  protected abstract scheduleHistoryGrants(groupId: string): void;
  protected abstract noticeVoiceEpoch(): void;
  protected abstract forgetCall(groupId: string): void;
  protected abstract applySounds(list: ApiSound[], save?: boolean): void;
  protected abstract takeSignal(message: ApiMessage, body: MessageBody, from: string): void;
  abstract leaveGroup(groupId: string): Promise<void>;
}
