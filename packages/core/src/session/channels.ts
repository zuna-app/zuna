// ServerSession, in part (see base.ts): channels, voice channels, calls, and watching YouTube together in them.

import { decode, type ApiCall, type ApiChannel, type ApiVoiceState } from "../api";
import { channelProof, openChannelDetails, sealChannelDetails } from "../channels";
import { readFounding } from "../roster";
import { checkEnvelope, frameSigned, randomId, readSigned, sealEnvelope, sealHistoryGrant, verifyHpkeKey } from "../crypto";
import { equalBytes, toBase64, u64Bytes, utf8 } from "../encoding";
import { VOICE_LABEL, voiceIdentity } from "../voice";
import { parseChannelDetails, parseWatch } from "../validate";
import { decodeFrameData } from "../socket";
import { NOT_A_YOUTUBE_LINK, readYouTubeLink, sameWatch, WATCH_RATES, watchBeats, watchPosition, type WatchSignal, type WatchState, type WatchVideo } from "../watch";
import type { CallView, ChannelType, ChannelView, ScreenAccess, VoiceAccess, VoiceMember, VoiceUpdate, WatchView } from "../types";
import { GRANT_JITTER_MS, voiceTiming, WATCH_ANSWERERS, WATCH_ANSWER_STEP_MS, WATCH_CORRECT_EVERY_MS, WATCH_DETAILS_WAIT_MS, WATCH_FRESH_MS, type CachedChannel, slowModeOf } from "./shared";
import { SessionManagement } from "./management";

export abstract class SessionChannels extends SessionManagement {
  // --- Channels ---

  /** Whether someone on a channel's roster showed they hold the community key. */
  protected holdsCommunityKey(channelId: string, userId: string, proof: string | null | undefined): boolean {
    return !!proof && equalBytes(decode(proof), channelProof(this.account.core.communityKey, channelId, userId));
  }

  /** Takes on what the server lists, believing only the details a device of someone here signed. */
  protected applyChannels(list: ApiChannel[], save = true): void {
    const versions = this.getKv<Record<string, number>>("channel_versions") ?? {};
    const next = new Map<string, CachedChannel>();
    for (const api of list) {
      const previous = this.channels.get(api.id);
      let details = previous?.details ?? null;
      let version = Math.max(previous?.version ?? 0, versions[api.id] ?? 0);
      const signed = openChannelDetails(this.account.core.communityKey, api.id, decode(api.details));
      if (signed && signed.version >= version) {
        const device = this.users.get(signed.signer.userId)?.devices.get(signed.signer.deviceId);
        const parsed = parseChannelDetails(signed.details);
        if (device && parsed && signed.signedBy(device.signatureKey)) {
          details = parsed;
          version = signed.version;
        } else if (!device) {
          // Not known yet. Looked up, and read again once that's done.
          void this.ensureUser(signed.signer.userId, true)
            .then((user) => {
              if (!user?.devices.has(signed.signer.deviceId)) return;
              this.applyChannels([...this.channels.values()].map((channel) => channel.api));
              void this.joinChannels();
            })
            .catch(() => undefined);
        }
      }
      next.set(api.id, { api, details, version });
      versions[api.id] = version;
    }
    this.channels = next;
    // Turned off where this device is watching: it stops, as the server refuses any more of it there.
    if (this.watch && next.get(this.watch.channelId)?.api.watch === false) this.forgetWatch();
    if (!save) return;
    this.setKv("channels", list);
    this.setKv("channel_versions", versions);
    this.emit({ type: "channels", serverId: this.serverId });
    // A slow mode made shorter, or turned off, lets what it held back try again.
    if (this.slowHeld.size > 0) {
      this.slowHeld.clear();
      void this.flushOutbox();
    }
  }

  /** The server's channels and who's in them, then joining any this device isn't in yet. */
  protected async syncChannels(): Promise<void> {
    if (!this.channelsOn) return;
    const { channels, voice } = await this.api.channels();
    this.applyChannels(channels);
    // Calls are listed by themselves.
    for (const [device, state] of this.voiceStates) {
      if (!state.call) this.voiceStates.delete(device);
    }
    for (const state of voice) this.voiceStates.set(state.device_id, state);
    this.emit({ type: "channels", serverId: this.serverId });
    await this.joinChannels();
  }

  /** One at a time, since each is a commit everyone in that channel has to work through. */
  protected joinChannels(): Promise<void> {
    this.joiningChannels ??= this.joinMissingChannels().finally(() => {
      this.joiningChannels = null;
    });
    return this.joiningChannels;
  }

  protected async joinMissingChannels(): Promise<void> {
    // A private bot stays out of channels, whatever a server lists for it.
    if (this.account.bot && !this.account.bot.listed) return;
    // Looks again each time, since more may be made meanwhile, and tries each once.
    const tried = new Set<string>();
    for (;;) {
      const id = [...this.channels.keys()].find((id) => {
        const group = this.groups.get(id);
        // One whose details don't open would mean this device doesn't hold the same community key as the others,
        // and one this account knows as something else isn't a channel, whatever the server lists.
        return !tried.has(id) && !!this.channels.get(id)?.details && !this.notAChannel(id) && (!group || group.removedAt || !this.hasMlsGroup(id));
      });
      if (!id || this.stopped) return;
      tried.add(id);
      await this.joinChannel(id).catch((error) => console.warn("[zuna] joining a channel", error));
    }
  }

  /** Comes into a channel. It needs no other member online, though only one can hand over its history. */
  protected async joinChannel(id: string): Promise<void> {
    if (this.notAChannel(id)) throw new Error("That isn't a channel.");
    const self = this.account.userId;
    const held = this.groups.get(id);
    if (!held || held.removedAt || !held.members.some((member) => member.userId === self)) {
      // A bot gets nothing from before it came in.
      const { group } = await this.api.joinChannel(id, channelProof(this.account.core.communityKey, id, self), !this.account.bot);
      if (group.kind !== "channel" || group.id !== id) throw new Error("The server sent an invalid response about this channel.");
      this.applyGroup(group);
    }
    await this.withLock(id, () => this.ensureReady(id));
    this.uploadEpochKeysSoon();
    this.emitConversations();
  }

  /** Someone is waiting for a channel's older keys. Whichever member's device gets there first hands them over. */
  protected scheduleHistoryGrants(groupId: string): void {
    if (this.grantTimers.has(groupId) || this.stopped) return;
    const timer = setTimeout(() => {
      this.grantTimers.delete(groupId);
      void this.withLock(groupId, () => this.grantChannelHistory(groupId)).catch((error) => console.warn("[zuna] handing on a channel's keys", error));
    }, Math.random() * GRANT_JITTER_MS);
    this.grantTimers.set(groupId, timer);
  }

  /**
   * Whether this device knows a conversation to be a channel, by everything it has: what it holds it
   * as, the charter in its MLS state, and what this account's vault kept its keys under. A group's
   * roster there, or a vault that says otherwise, means it isn't, whatever the server calls it.
   */
  protected knownChannel(groupId: string): boolean {
    if (this.groups.get(groupId)?.kind !== "channel") return false;
    const vaulted = this.vaultKind(groupId);
    if (vaulted && (vaulted === "disputed" || vaulted.kind !== "channel")) return false;
    const bytes = this.hasMlsGroup(groupId) ? this.rosterIn(groupId) : undefined;
    return !bytes || readFounding(groupId, bytes)?.kind === "channel";
  }

  protected async grantChannelHistory(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    // A channel's keys are for anyone on the server. Nothing else's ever are.
    if (!group || !this.knownChannel(groupId) || group.removedAt || !this.hasMlsGroup(groupId)) return;
    const inTree = new Set(this.treeUsers(groupId));
    const signer = { userId: this.account.userId, deviceId: this.account.deviceId };
    for (const userId of group.historyWanted ?? []) {
      // Only once they're really in: until then, it's only the server saying so. Their commit will bring this back.
      if (userId === this.account.userId || !inTree.has(userId)) continue;
      const user = await this.ensureUser(userId, true);
      if (!user) continue;
      const apiUser = await this.api.user(userId);
      // A chain's newest link names this key itself, and was checked when it came.
      if (!this.headOf(userId) && !verifyHpkeKey(this.pinnedIdentity(userId) ?? user.identityKey, user.hpkeKey, decode(apiUser.hpke_key_sig))) continue;
      const sealed = sealHistoryGrant(user.hpkeKey, groupId, userId, signer, this.account.deviceSecret, this.allEpochKeys(groupId));
      await this.api.grantChannelHistory(groupId, userId, sealed);
    }
  }

  /** Whether the server lists as a channel what this device or this account's vault holds as something else. */
  protected notAChannel(id: string): boolean {
    const group = this.groups.get(id);
    const vaulted = this.vaultKind(id);
    return (!!group && group.kind !== "channel") || (!!vaulted && (vaulted === "disputed" || vaulted.kind !== "channel"));
  }

  /** Every channel on this server, in order. */
  getChannels(): ChannelView[] {
    const now = Date.now();
    return [...this.channels.values()]
      .filter(({ api }) => !this.notAChannel(api.id))
      .sort((a, b) => a.api.position - b.api.position || a.api.created_at - b.api.created_at)
      .map(({ api, details }) => {
        const group = this.groups.get(api.id);
        return {
          id: api.id,
          type: api.type,
          key: `group:${api.id}`,
          name: details?.name ?? "",
          topic: details?.topic ?? "",
          category: details?.category ?? "",
          bitrate: details?.bitrate ?? 0,
          position: api.position,
          userLimit: api.user_limit,
          screenLimit: api.screen_limit,
          sounds: api.sounds,
          watch: api.watch !== false,
          slowMode: slowModeOf(api),
          unreadable: !details,
          conversation: group && !group.removedAt ? this.conversationOf(group, now) : null,
        };
      });
  }

  /** Makes a channel, for a server admin. Everyone else's apps join it by themselves. */
  async createChannel(input: { type: ChannelType; name: string; topic?: string; category?: string; bitrate?: number; userLimit?: number; screenLimit?: number; sounds?: boolean; watch?: boolean; slowMode?: number }): Promise<string> {
    const id = randomId();
    const details = parseChannelDetails(input);
    if (!details) throw new Error("A channel needs a name.");
    const { communityKey } = this.account.core;
    const sealed = sealChannelDetails(communityKey, id, details, 1, { userId: this.account.userId, deviceId: this.account.deviceId }, this.account.deviceSecret);
    const created = await this.api.createChannel({
      id,
      type: input.type,
      details: sealed,
      user_limit: input.userLimit ?? 0,
      screen_limit: input.screenLimit ?? 0,
      sounds: input.sounds,
      watch: input.watch,
      slow_mode: input.slowMode ?? 0,
      proof: channelProof(communityKey, id, this.account.userId),
    });
    if (created.group.id !== id || created.group.kind !== "channel" || created.channel.id !== id) {
      throw new Error("The channel wasn't created because the server sent an invalid response.");
    }
    this.applyGroup(created.group);
    await this.withLock(id, () => this.initGroup(created.group, []));
    this.channels.set(id, { api: created.channel, details, version: 1 });
    this.applyChannels([...this.channels.values()].map((channel) => channel.api));
    this.emitConversations();
    return id;
  }

  /** Changes what a channel says about itself, for a server admin. */
  async updateChannel(id: string, changes: { name?: string; topic?: string; category?: string; bitrate?: number; userLimit?: number; screenLimit?: number; sounds?: boolean; watch?: boolean; slowMode?: number }): Promise<void> {
    const channel = this.channels.get(id);
    if (!channel) throw new Error("That channel doesn't exist.");
    const { userLimit, screenLimit, sounds, watch, slowMode, ...text } = changes;
    const details = parseChannelDetails({ ...channel.details, ...text });
    if (!details) throw new Error("A channel needs a name.");
    const version = channel.version + 1;
    const sealed = sealChannelDetails(this.account.core.communityKey, id, details, version, { userId: this.account.userId, deviceId: this.account.deviceId }, this.account.deviceSecret);
    await this.api.updateChannel(id, sealed, { userLimit, screenLimit, sounds, watch, slowMode });
    this.channels.set(id, {
      api: {
        ...channel.api,
        details: toBase64(sealed),
        user_limit: userLimit ?? channel.api.user_limit,
        screen_limit: screenLimit ?? channel.api.screen_limit,
        sounds: sounds ?? channel.api.sounds,
        watch: watch ?? channel.api.watch,
        slow_mode: slowMode ?? channel.api.slow_mode,
      },
      details,
      version,
    });
    this.applyChannels([...this.channels.values()].map((item) => item.api));
    this.emitConversations();
  }

  async reorderChannels(ids: string[]): Promise<void> {
    for (const [position, id] of ids.entries()) {
      const channel = this.channels.get(id);
      if (channel) channel.api = { ...channel.api, position };
    }
    this.emit({ type: "channels", serverId: this.serverId });
    await this.api.orderChannels(ids);
  }

  async deleteChannel(id: string): Promise<void> {
    await this.api.deleteChannel(id);
    this.channels.delete(id);
    this.removeGroupLocally(id);
    this.emit({ type: "channels", serverId: this.serverId });
  }

  // --- Voice ---

  protected voiceMember(state: ApiVoiceState): VoiceMember {
    return {
      channelId: state.channel_id,
      userId: state.user_id,
      deviceId: state.device_id,
      muted: state.muted,
      deafened: state.deafened,
      serverMuted: state.server_muted,
      camera: state.camera,
      screen: state.screen,
      since: state.since,
    };
  }

  /** Who's in the voice channels and the calls, as each device says. */
  getVoiceMembers(): VoiceMember[] {
    return [...this.voiceStates.values()].map((state) => this.voiceMember(state));
  }

  protected onVoiceFrame(data: { channel_id: string; device_id: string; user_id: string; call?: boolean; state: ApiVoiceState | null }): void {
    if (data.call ? !this.callsOn : !this.channelsOn) return;
    if (data.state) this.voiceStates.set(data.device_id, { ...data.state, call: !!data.call });
    else this.voiceStates.delete(data.device_id);
    // Once the server says this device is in the room, it may ask what's on there.
    if (data.state && data.device_id === this.account.deviceId && this.watchAskFor === data.channel_id && this.activeVoice?.channelId === data.channel_id) {
      this.watchAskFor = null;
      this.askWatch(data.channel_id);
    }
    this.emit({
      type: "voice",
      serverId: this.serverId,
      channelId: data.channel_id,
      userId: data.user_id,
      deviceId: data.device_id,
      member: data.state ? this.voiceMember(data.state) : null,
    });
  }

  protected onVoiceEnded(data: { channel_id: string; reason: string }): void {
    if (!this.channelsOn && !this.callsOn) return;
    if (this.activeVoice?.channelId === data.channel_id) {
      this.activeVoice = null;
      this.forgetWatch();
    }
    this.emit({ type: "voice_ended", serverId: this.serverId, channelId: data.channel_id, reason: data.reason });
  }

  /** Tells the app when the voice channel or call this device is in has moved to a new key. */
  protected noticeVoiceEpoch(): void {
    const voice = this.activeVoice;
    if (!voice || !this.hasMlsGroup(voice.channelId)) return;
    const epoch = this.mlsEpoch(voice.channelId);
    if (epoch === voice.epoch) return;
    voice.epoch = epoch;
    this.emit({ type: "voice_key", serverId: this.serverId, channelId: voice.channelId });
  }

  /** Whether a room is a conversation's call, rather than a voice channel's. */
  protected isCall(groupId: string): boolean {
    const kind = this.groups.get(groupId)?.kind;
    return kind === "dm" || kind === "group";
  }

  protected async readyForVoice(channelId: string): Promise<void> {
    if (this.isCall(channelId)) {
      if (!this.hasMlsGroup(channelId)) await this.withLock(channelId, () => this.ensureReady(channelId));
    } else if (this.groups.get(channelId)?.kind !== "channel") await this.joinChannel(channelId);
    else if (!this.hasMlsGroup(channelId)) await this.withLock(channelId, () => this.ensureReady(channelId));
  }

  /**
   * How to reach a voice channel's room, or a conversation's call. It lets this device in, and nothing
   * else: its media is under keys only members have.
   */
  async voiceAccess(channelId: string): Promise<VoiceAccess> {
    await this.readyForVoice(channelId);
    const access = this.isCall(channelId) ? await this.api.callToken(channelId) : await this.api.voiceToken(channelId);
    if (access.identity !== voiceIdentity(this.account.userId, this.account.deviceId)) throw new Error("The server sent an invalid response about this voice channel.");
    return { url: access.url, token: access.token, identity: access.identity, serverMuted: access.server_muted };
  }

  /**
   * Asks to share a screen, which throws with something to tell the person if the server's rules say no.
   * The share goes out over this device's own connection, once the room says so, with the computer's
   * sound where that was asked for and the server allows it.
   */
  async voiceScreenAccess(channelId: string, how: { sound: boolean }): Promise<ScreenAccess> {
    const access = this.isCall(channelId) ? await this.api.startCallScreen(channelId, how) : await this.api.startScreen(channelId, how);
    return { sound: access.sound === true };
  }

  /** Gives up this device's place to share a screen, once it's stopped. */
  async voiceScreenStop(channelId: string): Promise<void> {
    if (this.isCall(channelId)) await this.api.stopCallScreen(channelId);
    else await this.api.stopScreen(channelId);
  }

  /** Stops someone else's screen share, for a server admin. */
  async voiceScreenStopOf(channelId: string, userId: string): Promise<void> {
    await this.api.stopScreenOf(channelId, userId);
  }

  /**
   * A voice channel's or a call's media key for its current epoch, straight from MLS. It's kept
   * nowhere, unlike the keys to messages, so a later member or a stolen vault can't open a
   * recording of a call. Anyone who shouldn't be in the group goes first.
   */
  async voiceKey(channelId: string): Promise<{ epoch: number; key: Uint8Array }> {
    return this.withLock(channelId, async () => {
      const kind = this.groups.get(channelId)?.kind;
      if ((kind !== "channel" && !this.isCall(channelId)) || this.groups.get(channelId)?.removedAt || !this.hasMlsGroup(channelId)) {
        throw new Error(kind === "channel" ? "This device isn't in that channel yet." : "This device isn't in that conversation yet.");
      }
      await this.pullChanges(channelId);
      await this.ensureTreeClean(channelId);
      const epoch = this.mlsEpoch(channelId);
      return { epoch, key: this.mls.exportSecret(utf8(channelId), VOICE_LABEL, u64Bytes(epoch), 32) };
    });
  }

  /**
   * What this device is doing in a voice channel or a call, for those who may know, or null once it's
   * left. Coming into a call with `ring` starts it, ringing everyone else, if nobody's in it yet.
   */
  setVoiceState(channelId: string | null, update: VoiceUpdate | null, ring = false): void {
    if (!channelId || !update) {
      this.activeVoice = null;
      clearTimeout(this.voiceKeyTimer);
      this.voiceKeyTimer = undefined;
      this.forgetWatch();
      this.watchAskFor = null;
      this.socket.sendVoice(null, null);
      return;
    }
    if (this.activeVoice?.channelId !== channelId) {
      this.watchVoiceKey(voiceTiming.checkEveryMs);
      // What another room watched is nothing to this one, which is asked once the server has this device in it.
      this.forgetWatch();
      this.watchAskFor = channelId;
      this.socket.measureClock();
    }
    const epoch = this.hasMlsGroup(channelId) ? this.mlsEpoch(channelId) : 0;
    const same = this.activeVoice?.channelId === channelId;
    this.activeVoice = { channelId, update, epoch: same ? this.activeVoice!.epoch : epoch, ring: (same && this.activeVoice!.ring) || (ring && this.isCall(channelId)) };
    this.sayVoice();
  }

  /** Gives the room a new key once its epoch has lasted too long, while this device is in it. */
  protected watchVoiceKey(delay: number): void {
    clearTimeout(this.voiceKeyTimer);
    this.voiceKeyTimer = setTimeout(() => void this.renewOldVoiceKey().catch((error) => console.warn("[zuna] renewing a call's key", error)), delay);
  }

  protected voiceKeyAge(channelId: string): number {
    if (!this.hasMlsGroup(channelId)) return 0;
    const row = this.db.get<{ created_at: number }>("SELECT created_at FROM epoch_keys WHERE group_id = ? AND epoch = ?", [channelId, this.mlsEpoch(channelId)]);
    return row ? Date.now() - row.created_at : 0;
  }

  protected async renewOldVoiceKey(): Promise<void> {
    const channelId = this.activeVoice?.channelId;
    if (!channelId || this.stopped) return;
    if (this.voiceKeyAge(channelId) >= voiceTiming.maxEpochAgeMs) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * voiceTiming.jitterMs));
      await this.withLock(channelId, async () => {
        await this.pullChanges(channelId);
        // Someone else in the room may have got there first.
        if (this.activeVoice?.channelId === channelId && this.voiceKeyAge(channelId) >= voiceTiming.maxEpochAgeMs) {
          await this.commitWithRetry(channelId, async () => ({ kind: "update" }));
        }
      });
    }
    if (this.activeVoice?.channelId === channelId) this.watchVoiceKey(voiceTiming.checkEveryMs);
  }

  /** Tells the server what this device is doing, and asks it to ring only until it's been heard asking. */
  protected sayVoice(): void {
    const voice = this.activeVoice;
    if (!voice) return;
    if (this.socket.sendVoice(voice.channelId, voice.update, voice.ring)) voice.ring = false;
  }

  // --- Calls ---

  protected callView(call: ApiCall): CallView {
    return { groupId: call.group_id, startedBy: call.started_by, startedAt: call.started_at, ringing: [...call.ringing], declined: [...call.declined] };
  }

  /** The calls going on in this person's conversations. Who's in each are the voice members under its group. */
  getCalls(): CallView[] {
    return [...this.calls.values()].map((call) => this.callView(call));
  }

  /** The calls going on and who's in them, as the server has it, once connected. */
  protected async syncCalls(): Promise<void> {
    if (!this.callsOn || !this.info?.calls) return;
    const { calls, voice } = await this.api.calls();
    this.calls = new Map(calls.filter((call) => !this.groups.get(call.group_id)?.removedAt).map((call) => [call.group_id, call]));
    for (const [device, state] of this.voiceStates) {
      if (state.call) this.voiceStates.delete(device);
    }
    for (const state of voice) this.voiceStates.set(state.device_id, { ...state, call: true });
    this.emit({ type: "calls", serverId: this.serverId });
  }

  /**
   * How a call stands. It's the server's word, like who's in a voice channel: it can say someone's calling
   * who isn't, but not let anyone hear the call who isn't in the conversation.
   */
  protected onCallFrame(data: { group_id: string; call: ApiCall | null }): void {
    if (!this.callsOn) return;
    if (data.call && !this.groups.get(data.group_id)?.removedAt) this.calls.set(data.group_id, data.call);
    else this.calls.delete(data.group_id);
    const call = this.calls.get(data.group_id);
    this.emit({ type: "call", serverId: this.serverId, groupId: data.group_id, call: call ? this.callView(call) : null });
  }

  /** A conversation this device is no longer in has no call for it. */
  protected forgetCall(groupId: string): void {
    let changed = this.calls.delete(groupId);
    for (const [device, state] of this.voiceStates) {
      if (state.call && state.channel_id === groupId) {
        this.voiceStates.delete(device);
        changed = true;
      }
    }
    if (changed) this.emit({ type: "calls", serverId: this.serverId });
  }

  /**
   * Gets a conversation ready for a call, starting a direct message nobody has written in yet, and says
   * which group the call is in. Coming into it is up to the room, through `voiceAccess`.
   */
  async prepareCall(key: string): Promise<string> {
    if (!this.callsOn || !this.info?.calls) throw new Error("This server doesn't support calls.");
    if (key === `user:${this.account.userId}`) throw new Error("There's nobody to call here.");
    if (key.startsWith("user:") && this.isBlocked(key.slice(5))) throw new Error("You blocked this person.");
    const groupId = await this.groupIdForKey(key);
    const group = this.groups.get(groupId);
    if (!group || group.removedAt || !this.isCall(groupId)) throw new Error("There's nobody to call here.");
    if (!this.hasMlsGroup(groupId)) await this.withLock(groupId, () => this.ensureReady(groupId));
    return groupId;
  }

  /** Rings people in the conversation again, from inside its call: those named, or everyone not in it. */
  async ringCall(groupId: string, userIds: string[] = []): Promise<void> {
    await this.api.ringCall(groupId, userIds);
  }

  /** Stops a call ringing this person, on all their devices. */
  async declineCall(groupId: string): Promise<void> {
    await this.api.declineCall(groupId);
  }

  /** Takes someone out of a voice channel, for a server admin. */
  async voiceDisconnect(channelId: string, userId: string): Promise<void> {
    await this.api.voiceDisconnect(channelId, userId);
  }

  /** Mutes someone until an admin unmutes them. It's the media server that makes this stick. */
  async voiceMute(channelId: string, userId: string, muted: boolean): Promise<void> {
    await this.api.voiceMute(channelId, userId, muted);
  }

  // --- Watching together ---

  /** The server's clock as near as this device can tell, which every state's time is on. */
  protected serverNow(): number {
    return this.socket.now() + this.socket.clockOffset;
  }

  protected watchView(state: WatchState): WatchView | null {
    const video = state.video;
    if (!video) return null;
    return {
      session: state.session,
      video: { id: video.id, startedBy: video.by, title: video.title ?? "", author: video.author ?? "", image: video.image },
      playing: state.playing,
      position: state.position,
      // On this device's clock, so that no app deals with how far it is from the server's.
      at: state.at - this.socket.clockOffset,
      rate: state.rate,
      changedBy: state.user,
    };
  }

  /** What a voice channel or a call this device is in watches together, or null when nothing's on. */
  getWatch(channelId: string): WatchView | null {
    const held = this.heldWatch(channelId);
    return held ? this.watchView(held) : null;
  }

  /** The state this device holds for a room, if it's in that room. */
  protected heldWatch(channelId: string): WatchState | null {
    return this.activeVoice?.channelId === channelId && this.watch?.channelId === channelId ? this.watch.state : null;
  }

  /** Throws with something to tell the person when this device can't change what a room watches. */
  protected watchable(channelId: string): void {
    const call = this.isCall(channelId);
    if (this.activeVoice?.channelId !== channelId || !this.hasMlsGroup(channelId)) throw new Error(call ? "Join the call to watch together." : "Join the voice channel to watch together.");
    if (!call && this.channels.get(channelId)?.api.watch === false) throw new Error("Watching together is off in this voice channel.");
  }

  /**
   * Puts a YouTube video on for everyone in the room, from a link. This device fetches its title
   * and picture, as it would a link's preview, so the person should have agreed to contact
   * YouTube first. The others' devices contact nobody until their people press Watch.
   */
  async watchStart(channelId: string, url: string): Promise<void> {
    const link = readYouTubeLink(url);
    if (!link) throw new Error(NOT_A_YOUTUBE_LINK);
    this.watchable(channelId);
    const preview = this.videoPreview;
    let details: Partial<WatchVideo> = {};
    if (preview) {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), WATCH_DETAILS_WAIT_MS));
      details = (await Promise.race([preview(link.id).catch(() => null), timeout])) ?? {};
    }
    // It may have been left meanwhile.
    this.watchable(channelId);
    const held = this.heldWatch(channelId);
    const video: WatchVideo = { id: link.id, by: this.account.userId };
    if (details.title) video.title = details.title;
    if (details.author) video.author = details.author;
    if (details.image) video.image = details.image;
    await this.changeWatch(channelId, {
      session: held?.video ? held.session : randomId(),
      rev: (held?.rev ?? 0) + 1,
      video,
      playing: true,
      position: link.start,
      at: this.serverNow(),
      rate: 1,
      user: this.account.userId,
      device: this.account.deviceId,
    });
  }

  /** A change this person made to what the room watches: play or pause, a seek, a speed. */
  async watchControl(channelId: string, change: { playing?: boolean; position?: number; rate?: number }): Promise<void> {
    this.watchable(channelId);
    const held = this.heldWatch(channelId);
    if (!held?.video) throw new Error("Nothing is playing.");
    if (change.rate !== undefined && !(WATCH_RATES as readonly number[]).includes(change.rate)) throw new Error("YouTube can't play at that speed.");
    if (change.position !== undefined && (!Number.isFinite(change.position) || change.position < 0)) throw new Error("That isn't a valid position in the video.");
    const now = this.serverNow();
    await this.changeWatch(channelId, {
      ...held,
      rev: held.rev + 1,
      playing: change.playing ?? held.playing,
      position: Math.round(change.position ?? watchPosition(held, now)),
      at: now,
      rate: change.rate ?? held.rate,
      user: this.account.userId,
      device: this.account.deviceId,
    });
  }

  /** Stops the video for everyone in the room. */
  async watchStop(channelId: string): Promise<void> {
    this.watchable(channelId);
    const held = this.heldWatch(channelId);
    if (!held?.video) return;
    await this.changeWatch(channelId, { ...held, rev: held.rev + 1, video: null, playing: false, position: 0, at: this.serverNow(), user: this.account.userId, device: this.account.deviceId });
  }

  /** Takes on a change of this device's at once, tells the room, and takes it back if the room wasn't told. */
  protected async changeWatch(channelId: string, state: WatchState): Promise<void> {
    const before = this.heldWatch(channelId);
    const videoChanged = state.video?.id !== before?.video?.id || state.session !== before?.session;
    this.setWatch(channelId, state);
    try {
      await this.sendWatchState(channelId, state, videoChanged);
    } catch (error) {
      if (this.watch?.state === state) {
        if (before) this.setWatch(channelId, before);
        else this.forgetWatch();
      }
      throw error;
    }
  }

  protected setWatch(channelId: string, state: WatchState): void {
    const before = this.watch?.channelId === channelId ? this.watch.state : null;
    this.watch = { channelId, state };
    // Where a video is depends on the clock, so it's measured as one comes on.
    if (state.video && !before?.video) this.socket.measureClock();
    this.emit({ type: "watch", serverId: this.serverId, channelId, watch: this.watchView(state) });
  }

  /** Forgets what the room watched, as on leaving it. */
  protected forgetWatch(): void {
    for (const timer of this.watchAnswers.values()) clearTimeout(timer);
    this.watchAnswers.clear();
    this.watchCorrected.clear();
    const held = this.watch;
    this.watch = null;
    if (held?.state.video) this.emit({ type: "watch", serverId: this.serverId, channelId: held.channelId, watch: null });
  }

  /** A state, with the video's title and picture only when they're news to the others, or for one who asked. */
  protected sendWatchState(channelId: string, state: WatchState, full: boolean, to?: string): Promise<void> {
    const video = state.video && !full ? { id: state.video.id, by: state.video.by } : state.video;
    return this.sendWatch(channelId, { kind: "state", state: { ...state, video }, sent: this.serverNow(), nonce: randomId() }, to);
  }

  /** Seals a signal under the room's key for its current epoch, signed by this device, as a played sound is. */
  protected async sendWatch(channelId: string, signal: WatchSignal, to?: string): Promise<void> {
    const epoch = this.rememberCurrentEpochKey(channelId);
    const key = this.epochKey(channelId, epoch);
    if (!key) throw new Error("This device isn't ready to watch here yet.");
    const sealed = frameSigned(epoch, sealEnvelope(key, this.account.deviceSecret, "watch", channelId, this.account.userId, epoch, signal, this.signer));
    await (this.isCall(channelId) ? this.api.callWatch(channelId, sealed, to) : this.api.watch(channelId, sealed, to));
  }

  /** Asks the others in the room what's on, as this device comes in or its connection comes back. */
  protected askWatch(channelId: string): void {
    const held = this.heldWatch(channelId);
    const signal: WatchSignal = { kind: "ask", sent: this.serverNow(), nonce: randomId() };
    if (held) signal.have = { session: held.session, rev: held.rev };
    void this.sendWatch(channelId, signal).catch((error) => console.warn("[zuna] asking what's on", error));
  }

  /**
   * Someone else in the room changed what it watches, answered what this device asked, or asked.
   * It counts only if it opens under the room's key, was signed by the device the server says sent
   * it, which the log of keys names, and is new: the server handing it on again changes nothing.
   */
  protected onWatchFrame(data: { channel_id: string; user_id: string; device_id: string; data: string }, again = false): void {
    if (this.activeVoice?.channelId !== data.channel_id || data.device_id === this.account.deviceId) return;
    const channelId = data.channel_id;
    if (!this.isCall(channelId) && this.channels.get(channelId)?.api.watch === false) return;
    const signed = readSigned(decodeFrameData(data.data));
    if (!signed) return;
    const current = this.hasMlsGroup(channelId) ? this.mlsEpoch(channelId) : -1;
    const key = this.epochKey(channelId, signed.epoch) ?? (signed.epoch === current ? this.epochKey(channelId, this.rememberCurrentEpochKey(channelId)) : null);
    if (!key) {
      // Sealed under the key of a commit this device hasn't come to yet, such as the one that let in whoever sent it.
      if (!again && current >= 0 && signed.epoch > current) {
        void this.withLock(channelId, () => this.pullChanges(channelId))
          .then(() => this.onWatchFrame(data, true))
          .catch(() => undefined);
      }
      return;
    }
    const checked = checkEnvelope<unknown>(key, "watch", channelId, data.user_id, signed.epoch, signed.envelope, (signer) => this.deviceKey(signer));
    if (checked.state === "unknown" && !again) {
      void this.ensureUser(checked.signer.userId, true)
        .then(() => this.onWatchFrame(data, true))
        .catch(() => undefined);
      return;
    }
    if (checked.state !== "signed" || checked.signer.userId !== data.user_id || checked.signer.deviceId !== data.device_id) return;
    const signal = parseWatch(checked.value);
    if (!signal) return;
    const now = this.serverNow();
    for (const [nonce, seen] of this.watchSeen) {
      if (Date.now() - seen > WATCH_FRESH_MS) this.watchSeen.delete(nonce);
    }
    if (Math.abs(now - signal.sent) > WATCH_FRESH_MS || this.watchSeen.has(signal.nonce)) return;
    this.watchSeen.set(signal.nonce, Date.now());
    if (signal.kind === "ask") this.answerWatch(channelId, data.device_id, signal.have);
    else this.takeWatch(channelId, signal.state, data.device_id);
  }

  /** Takes on a state someone else sent, if it wins over the one held. */
  protected takeWatch(channelId: string, state: WatchState, from: string): void {
    const held = this.heldWatch(channelId);
    // The same video keeps what was found about it, which only came with it the first time.
    if (state.video && held?.video?.id === state.video.id && !state.video.title && !state.video.image) {
      state = { ...state, video: { ...held.video, by: state.video.by } };
    }
    if (held && sameWatch(state, held)) {
      if (state.video && held.video && !held.video.title && (state.video.title || state.video.image)) this.setWatch(channelId, state);
      return;
    }
    if (watchBeats(state, held)) {
      this.setWatch(channelId, state);
      return;
    }
    // Behind what this device holds, as one that missed something is: it's told what's on.
    const last = this.watchCorrected.get(from) ?? 0;
    if (!held || Date.now() - last < WATCH_CORRECT_EVERY_MS) return;
    this.watchCorrected.set(from, Date.now());
    void this.sendWatchState(channelId, held, true, from).catch(() => undefined);
  }

  /**
   * Someone came into the room and asked what's on. The devices that have been in it longest
   * answer, each after a wait set by how long, and only the one who asked hears it, under the
   * key it holds now. One that already holds what's on, as after a moment offline, isn't told again.
   */
  protected answerWatch(channelId: string, asker: string, have: { session: string; rev: number } | undefined): void {
    const held = this.heldWatch(channelId);
    if (!held || (have && have.rev >= held.rev)) return;
    const others = [...this.voiceStates.values()]
      .filter((state) => state.channel_id === channelId && state.device_id !== asker)
      .sort((a, b) => a.since - b.since || a.device_id.localeCompare(b.device_id));
    const rank = others.findIndex((state) => state.device_id === this.account.deviceId);
    if (rank < 0 || rank >= WATCH_ANSWERERS) return;
    clearTimeout(this.watchAnswers.get(asker));
    this.watchAnswers.set(
      asker,
      setTimeout(
        () => {
          this.watchAnswers.delete(asker);
          const now = this.heldWatch(channelId);
          if (now) void this.sendWatchState(channelId, now, true, asker).catch(() => undefined);
        },
        rank * WATCH_ANSWER_STEP_MS + Math.random() * 100,
      ),
    );
  }
}
