// ServerSession, in part (see base.ts): starting, syncing and stopping, and the frames the server sends over the socket.

import { ApiError, type ApiEvent, type ApiGroup, type ApiMessage, type ApiReactionChange, type ApiUser } from "../api";
import { checkEnvelope, readSigned } from "../crypto";
import { fromBase64, toBase64 } from "../encoding";
import { decodeFrameData, type SocketFrame } from "../socket";
import type { ConnectionState, ServerInfo } from "../types";
import { SYNC_CONCURRENCY, TYPING_FRESH_MS, SIGNED_OUT_RETRY_MS, eachLimited, validReactionChange } from "./shared";
import { SessionServer } from "./server";

export abstract class SessionLifecycle extends SessionServer {
  // --- Lifecycle ---

  start(): void {
    this.markStaleSendsFailed();
    this.forgetOldRemovedGroups();
    this.forgetUnprovenDeletions();
    this.forgetLongExpired();
    void this.rebuildSearchIndex();
    this.connect();
  }

  protected connect(): void {
    this.stopped = false;
    this.expireMessages();
    this.setConnection("connecting");
    this.socket.start();
  }

  stop(): void {
    this.stopped = true;
    this.socket.stop();
    for (const timer of this.actedTimers.values()) clearTimeout(timer);
    this.actedTimers.clear();
    clearTimeout(this.lastSeenMoved);
    this.lastSeenMoved = undefined;
    clearTimeout(this.flushRetry);
    clearTimeout(this.missingTimer);
    clearTimeout(this.muteTimer);
    clearTimeout(this.expiryTimer);
    this.nextExpiry = Infinity;
    clearTimeout(this.signedOutRetry);
    clearTimeout(this.rotationTimer);
    clearTimeout(this.sealingTimer);
    clearTimeout(this.voiceKeyTimer);
    clearTimeout(this.tokenTopUp);
    this.tokenTopUp = undefined;
    this.rotationTimer = undefined;
    this.sealingTimer = undefined;
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
    this.reconcileTimers.clear();
    for (const timer of this.sendKeyFixes.values()) clearTimeout(timer);
    this.sendKeyFixes.clear();
    for (const timer of this.grantTimers.values()) clearTimeout(timer);
    this.grantTimers.clear();
    for (const timer of this.chainRetries.values()) clearTimeout(timer);
    this.chainRetries.clear();
    for (const timer of this.waitingNotifications) clearTimeout(timer);
    this.waitingNotifications.clear();
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

  protected setConnection(state: ConnectionState): void {
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
  protected signedOut(reason: string): void {
    this.stop();
    this.setConnection("offline");
    // This device asked for its account to go, and finishes that itself.
    if (this.deletingAccount) return;
    if (this.signedOutReason !== reason) {
      this.signedOutReason = reason;
      this.emit({ type: "signed_out", serverId: this.serverId, reason });
      this.onSignedOut?.(reason);
    }
    if (reason === "session_ended") {
      this.signedOutRetry = setTimeout(() => this.connect(), SIGNED_OUT_RETRY_MS);
    }
  }

  protected async onConnected(): Promise<void> {
    if (this.signedOutReason) {
      this.signedOutReason = null;
      this.emit({ type: "signed_in", serverId: this.serverId });
      this.onSignedIn?.();
    }
    this.setConnection("syncing");
    // The server only gives a device that went quiet a moment to come back.
    if (this.activeVoice) {
      // What the room watches may have changed meanwhile, so it's asked again once the server has this device back.
      this.watchAskFor = this.activeVoice.channelId;
      this.sayVoice();
      if (this.watch?.state.video) this.socket.measureClock();
    }
    try {
      await this.syncAll();
      if (this.socket.connected) this.setConnection("online");
      // A device signed in has none yet: it fetches them now, never when something is about to go.
      this.topUpTokensSoon(true);
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

  /**
   * Catches up on everything, one catch-up at a time: a quick drop and reconnect while one is
   * running asks it to go round again rather than starting a second beside it.
   */
  protected syncAll(): Promise<void> {
    if (this.syncingAll) {
      this.syncingAll.again = true;
      return this.syncingAll.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await this.syncAllOnce();
        } while (entry.again && !this.stopped);
      } finally {
        this.syncingAll = null;
      }
    })();
    this.syncingAll = entry;
    return entry.done;
  }

  protected async syncAllOnce(): Promise<void> {
    // What the server says about itself, and its emotes, have nothing to do with the
    // account's keys, so they're asked for alongside them rather than each waiting its turn.
    const info = this.api.info();
    info.catch(() => undefined);
    const emotes = this.refreshEmotes().then(
      () => null,
      (error: unknown) => error,
    );
    // Which keys are current comes first of all, since the vault opens with them.
    // Not being able to tell is no reason to stop the messages from coming.
    await this.syncAccount().catch((error) => {
      if (error instanceof ApiError && error.status === 401) throw error;
      console.warn("[zuna] catching up on this account's keys", error);
    });
    const server = await info;
    // The log's key is the core's alone (logKey), and isn't part of what the apps are told.
    delete server.log_key;
    this.info = server;
    this.emit({ type: "settings", serverId: this.serverId, info: this.info });
    // The vault comes next: it holds the keys this account already trusts,
    // which a new device must have before believing what the server says.
    await this.syncVault();
    this.checkManifestFloor();
    // The log of who holds which keys comes before the list of people, which is judged by it.
    // Not being able to read it leaves what was counted counted, and nothing new.
    await this.syncLog().catch((error) => {
      if (error instanceof ApiError && error.status === 401) throw error;
      console.warn("[zuna] reading the log of keys", error);
    });
    await this.syncUsers();
    this.emitNewDevices();
    await this.checkBotProofs();
    await this.saveTrust();
    await this.processWelcomes();
    // A group that arrives while the list is on its way won't be in it, so only
    // groups we already knew about can have been taken away.
    const known = [...this.groups.keys()];
    // An app that doesn't show channels takes no part in them.
    const groups = (await this.api.groups()).filter((group) => group.kind !== "channel" || this.channelsOn);
    const seen = new Set(groups.map((group) => group.id));
    for (const group of groups) this.applyGroup(group);
    for (const id of known) {
      if (!seen.has(id)) this.markRemoved(id);
    }
    this.emitConversations();
    // The list just said where each group is, so one this device has caught up with,
    // at the same epoch, needn't ask for its changes. The rest catch up a few at a time.
    const behind: string[] = [];
    for (const group of groups) {
      if (this.hasMlsGroup(group.id) && this.mlsEpoch(group.id) === group.epoch && this.syncedSeq(group.id) >= group.seq) {
        this.scheduleReconcile(group.id);
      } else {
        behind.push(group.id);
      }
    }
    await eachLimited(behind, SYNC_CONCURRENCY, (id) => this.syncGroup(id));
    // Channels, calls and the soundboard don't wait on one another. None of them is any
    // reason to miss messages, and emotes are cosmetic.
    const optional = await Promise.allSettled([this.syncChannels(), this.syncCalls(), this.syncSounds(), emotes.then((error) => (error ? Promise.reject(error) : undefined))]);
    optional.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      if (result.reason instanceof ApiError && result.reason.status === 401) throw result.reason;
      console.warn(`[zuna] catching up on ${["channels", "calls", "the soundboard", "emotes"][index]}`, result.reason);
    });
    // After joining, since a grant is only good for epochs before this device came in. Key
    // packages, for being added to groups, are another matter, so they go alongside.
    await Promise.all([this.processHistoryGrants(), this.topUpKeyPackages()]);
    await this.uploadEpochKeys();
    await this.sendUnsentReads();
    // Back online, so whatever was waiting to try again goes now.
    this.retryHeld.clear();
    this.retryDelay.clear();
    void this.flushOutbox();
  }

  // --- Realtime frames ---

  protected onFrame(frame: SocketFrame): void {
    const data = frame.d;
    switch (frame.t) {
      case "message":
        this.onLiveMessage(data as ApiMessage);
        break;
      case "reaction":
        this.onLiveReaction(data as ApiReactionChange);
        break;
      case "event":
        void this.onLiveEvent(data as ApiEvent).catch((error) => console.warn("[zuna] event", error));
        break;
      case "group": {
        if ((data as ApiGroup).kind === "channel" && !this.channelsOn) break;
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
      case "channels":
        void this.syncChannels().catch((error) => console.warn("[zuna] channels", error));
        break;
      case "voice":
        this.onVoiceFrame(data);
        break;
      case "voice_ended":
        this.onVoiceEnded(data);
        break;
      case "screen_ended":
        if (this.channelsOn || this.callsOn) this.emit({ type: "screen_ended", serverId: this.serverId, channelId: data.channel_id, reason: data.reason });
        break;
      case "call":
        this.onCallFrame(data);
        break;
      case "read":
        this.onLiveRead(data);
        break;
      case "typing":
        this.onLiveTyping(data);
        break;
      case "activity": {
        const elsewhere = (data.active_devices as string[]).some((id) => id !== this.account.deviceId);
        this.seenInUse = (data.active_devices as string[]).includes(this.account.deviceId);
        // How long ago the person used their other devices, of those used lately.
        const recent = Object.entries(data.recent_devices as Record<string, number>).filter(([id]) => id !== this.account.deviceId);
        this.usedElsewhereAt = Math.max(0, ...recent.map(([, ago]) => Date.now() - ago));
        if (elsewhere !== this.activeElsewhere) {
          this.activeElsewhere = elsewhere;
          this.emit({ type: "activity", serverId: this.serverId, elsewhere });
        }
        break;
      }
      case "presence":
        this.onPresence(data);
        break;
      case "user": {
        const user = data as ApiUser;
        const before = this.keysOf(user.id);
        this.applyUser(user);
        void this.checkBotProofs()
          .then(() => this.saveTrust())
          .catch(() => undefined);
        this.emit({ type: "users", serverId: this.serverId });
        this.emitConversations();
        // Only a change to who they are or which devices they have can change their groups' trees:
        // a new name or picture needn't reconcile every group they're in.
        if (this.keysOf(user.id) !== before || user.key_generation > this.headGeneration(user.id)) this.rescheduleAffectedByDeviceChange(user.id);
        break;
      }
      case "vault":
        void this.syncVault().catch((error) => console.warn("[zuna] vault", error));
        break;
      case "account":
        this.syncAccountSoon();
        break;
      case "log":
        this.noteLogStatus(data as { era: number; size: number });
        break;
      case "settings":
        this.info = data as ServerInfo;
        this.setKv("info", this.info);
        this.emit({ type: "settings", serverId: this.serverId, info: this.info });
        break;
      case "emotes":
        void this.refreshEmotes().catch((error) => console.warn("[zuna] emotes", error));
        break;
      case "sounds":
        void this.syncSounds().catch((error) => console.warn("[zuna] soundboard", error));
        break;
      case "sound":
        this.onSoundFrame(data);
        break;
      case "watch":
        this.onWatchFrame(data);
        break;
      case "device_revoked":
        if (data.device_id === this.account.deviceId) this.signedOut("device_revoked");
        break;
      case "force_logout":
        this.signedOut(data.reason ?? "session_ended");
        break;
    }
  }

  /** What about someone bears on their groups' trees: their keys, standing and devices, as one string to compare. */
  protected keysOf(userId: string): string {
    const user = this.users.get(userId);
    if (!user) return "";
    const devices = [...user.devices.values()].map((device) => `${device.id}:${toBase64(device.signatureKey)}:${device.revoked}`).sort();
    return [user.role, user.banned, user.deleted, toBase64(user.identityKey), toBase64(user.hpkeKey), this.headGeneration(userId), ...devices].join("|");
  }

  protected rescheduleAffectedByDeviceChange(userId: string): void {
    for (const group of this.groups.values()) {
      if (group.members.some((member) => member.userId === userId)) this.scheduleReconcile(group.id);
    }
  }

  /**
   * A group heard of only through a message or event in it, as when its own frame was missed:
   * fetched, then caught up on, as its frame would have. One this member can't see is left be.
   */
  protected discoverGroup(groupId: string): void {
    if (this.discovering.has(groupId) || this.stopped) return;
    this.discovering.add(groupId);
    void this.api
      .group(groupId)
      .then((group) => {
        // Its own frame may have come meanwhile, which already caught up on it.
        if (this.groups.has(groupId) || (group.kind === "channel" && !this.channelsOn)) return;
        this.applyGroup(group);
        this.emitConversations();
        this.backgroundSync(groupId);
      })
      .catch(() => undefined)
      .finally(() => this.discovering.delete(groupId));
  }

  protected onLiveMessage(message: ApiMessage): void {
    if (!this.groups.has(message.group_id)) {
      this.discoverGroup(message.group_id);
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

  /** A reaction added or taken back, which moves its message on in the change feed as any change to it does. */
  protected onLiveReaction(change: ApiReactionChange): void {
    if (!validReactionChange(change)) return;
    if (!this.groups.has(change.group_id)) {
      this.discoverGroup(change.group_id);
      return;
    }
    this.applyReactionChange(change);
    const synced = this.syncedSeq(change.group_id);
    if (change.updated_seq === synced + 1) {
      this.setSyncedSeq(change.group_id, change.updated_seq);
    } else if (change.updated_seq > synced) {
      this.backgroundSync(change.group_id);
    }
  }

  protected async onLiveEvent(event: ApiEvent): Promise<void> {
    if (!this.groups.has(event.group_id)) {
      this.discoverGroup(event.group_id);
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

  protected onLiveRead(data: { group_id: string; user_id: string; data: string }): void {
    const group = this.groups.get(data.group_id);
    if (!group) return;
    this.applyReadState(group, data.user_id, fromBase64(data.data));
    this.persistGroup(group);
    const seq = data.user_id === this.account.userId ? group.ownRead : (group.readBy[data.user_id] ?? 0);
    this.emit({ type: "read", serverId: this.serverId, groupId: data.group_id, userId: data.user_id, seq });
    if (data.user_id === this.account.userId) this.emitConversations();
    // Reading this person's messages in a direct message shows them online for a while, as on
    // Telegram (`updateReadHistoryOutbox`, for a chat with one person only).
    else if (group.kind === "dm") this.madeAction(data.user_id, Date.now());
  }

  /** Someone typing, who only the signature inside says: the server isn't told. */
  protected onLiveTyping(data: { group_id: string; data: string }): void {
    const signed = readSigned(decodeFrameData(data.data));
    const key = signed && this.epochKey(data.group_id, signed.epoch);
    if (!signed || !key) return;
    const checked = checkEnvelope<{ at?: unknown }>(key, "typing", data.group_id, "typing", signed.epoch, signed.envelope, (signer) => this.deviceKey(signer));
    if (checked.state !== "signed") return;
    const userId = checked.signer.userId;
    const at = checked.value?.at;
    if (userId === this.account.userId || this.isBlocked(userId) || typeof at !== "number" || Math.abs(Date.now() - at) > TYPING_FRESH_MS) return;
    this.emit({ type: "typing", serverId: this.serverId, groupId: data.group_id, userId });
    // Typing shows them online for a while, as on Telegram (`SendActionManager::registerFor`).
    this.madeAction(userId, Date.now());
  }

  protected onPresence(data: { user_id: string; online: boolean; last_seen_at?: number }): void {
    if (data.online) this.online.add(data.user_id);
    else this.online.delete(data.user_id);
    this.presenceWhileListing?.set(data.user_id, data.online);
    if (data.last_seen_at) this.noteLastSeen(data.user_id, data.last_seen_at);
    this.emitPresence(data.user_id);
  }
}
