// ServerSession, in part (see base.ts): what everyone on the server shares: the soundboard, the emotes, and its administration.

import { decode, type ApiSound } from "../api";
import { inviteLink } from "../account";
import { frameSigned, openEnvelope, randomId, readSigned, sealEnvelope } from "../crypto";
import { toBase64, toBase64Url } from "../encoding";
import { decodeFrameData } from "../socket";
import { openSoundDetails, sealSoundDetails } from "../soundboard";
import { prepareSound, readWav } from "../sounds";
import { parseEmoteRef, parsePlay, parseSoundDetails } from "../validate";
import type { BanView, Emote, EmoteRef, EmoteSet, Invite, SoundView } from "../types";
import { PLAY_FRESH_MS, type CachedSound } from "./shared";
import { SessionChannels } from "./channels";

export abstract class SessionServer extends SessionChannels {
  // --- Soundboard ---

  /** Takes on what the server lists, believing only the details a device of someone here signed. */
  protected applySounds(list: ApiSound[], save = true): void {
    const versions = this.getKv<Record<string, number>>("sound_versions") ?? {};
    const next = new Map<string, CachedSound>();
    for (const api of list) {
      const previous = this.sounds.get(api.id);
      let details = previous?.details ?? null;
      let version = Math.max(previous?.version ?? 0, versions[api.id] ?? 0);
      const signed = openSoundDetails(this.account.core.communityKey, api.id, decode(api.details));
      if (signed && signed.version >= version) {
        const device = this.users.get(signed.signer.userId)?.devices.get(signed.signer.deviceId);
        const parsed = parseSoundDetails(signed.details);
        if (device && parsed && signed.signedBy(device.signatureKey)) {
          details = parsed;
          version = signed.version;
        } else if (!device) {
          // Not known yet. Looked up, and read again once that's done.
          void this.ensureUser(signed.signer.userId, true)
            .then((user) => {
              if (user?.devices.has(signed.signer.deviceId)) this.applySounds([...this.sounds.values()].map((sound) => sound.api));
            })
            .catch(() => undefined);
        }
      }
      next.set(api.id, { api, details, version });
      versions[api.id] = version;
    }
    this.sounds = next;
    if (!save) return;
    this.setKv("sounds", list);
    this.setKv("sound_versions", versions);
    this.emit({ type: "sounds", serverId: this.serverId });
  }

  protected async syncSounds(): Promise<void> {
    if (!this.channelsOn && !this.callsOn) return;
    this.applySounds(await this.api.sounds());
  }

  /** The soundboard, oldest first, without any whose details couldn't be read or checked. */
  getSounds(): SoundView[] {
    const sounds: SoundView[] = [];
    for (const { api, details } of [...this.sounds.values()].sort((a, b) => a.api.created_at - b.api.created_at || a.api.id.localeCompare(b.api.id))) {
      if (details) sounds.push({ id: api.id, name: details.name, emoji: details.emoji, durationMs: details.durationMs });
    }
    return sounds;
  }

  /**
   * Adds a sound, for a server admin, from WAV in one channel at 48 kHz, as each app makes from what's
   * picked. Its silence is cut, it's held to five seconds, and it's made about as loud as the rest.
   */
  async addSound(file: Blob, name: string, emoji = ""): Promise<string> {
    if (!parseSoundDetails({ name, emoji, durationMs: 1, file: { fileId: "0".repeat(32), key: "", prefix: "", chunks: 1 } })) {
      throw new Error("A sound needs a name, of up to 32 characters.");
    }
    const { wav, durationMs } = prepareSound(await this.files.read(file, 0, this.files.size(file)));
    const ref = await this.uploadBlob({ size: wav.length, read: async (start, end) => wav.subarray(start, end) });
    const details = parseSoundDetails({ name, emoji, durationMs, file: { fileId: ref.fileId, key: ref.key, prefix: ref.prefix, chunks: ref.chunks } });
    if (!details) throw new Error("That sound couldn't be added.");
    const id = randomId();
    const sealed = sealSoundDetails(this.account.core.communityKey, id, details, 1, { userId: this.account.userId, deviceId: this.account.deviceId }, this.account.deviceSecret);
    const { sound } = await this.api.createSound(id, sealed, ref.fileId);
    this.sounds.set(id, { api: sound, details, version: 1 });
    this.applySounds([...this.sounds.values()].map((item) => item.api));
    return id;
  }

  /** Renames a sound, or gives it another emoji, for a server admin. */
  async updateSound(id: string, changes: { name?: string; emoji?: string }): Promise<void> {
    const sound = this.sounds.get(id);
    if (!sound?.details) throw new Error("That sound isn't on the soundboard anymore.");
    const details = parseSoundDetails({ ...sound.details, ...changes });
    if (!details) throw new Error("A sound needs a name, of up to 32 characters.");
    const version = sound.version + 1;
    const sealed = sealSoundDetails(this.account.core.communityKey, id, details, version, { userId: this.account.userId, deviceId: this.account.deviceId }, this.account.deviceSecret);
    await this.api.updateSound(id, sealed);
    this.sounds.set(id, { api: { ...sound.api, details: toBase64(sealed) }, details, version });
    this.applySounds([...this.sounds.values()].map((item) => item.api));
  }

  /** Takes a sound off the soundboard, for a server admin. */
  async deleteSound(id: string): Promise<void> {
    await this.api.deleteSound(id);
    this.sounds.delete(id);
    this.applySounds([...this.sounds.values()].map((item) => item.api));
  }

  /** A sound's file, fetched once and checked to be the WAV every sound is, for playing. */
  soundFile(id: string): Promise<Blob> {
    const details = this.sounds.get(id)?.details;
    if (!details) return Promise.reject(new Error("That sound isn't on the soundboard anymore."));
    const { file } = details;
    let fetched = this.soundFiles.get(file.fileId);
    if (!fetched) {
      fetched = this.downloadFile({ ...file, mime: "audio/wav" }).then(async (blob) => {
        if (!readWav(await this.files.read(blob, 0, this.files.size(blob)))) throw new Error("That sound's file isn't what it should be.");
        return blob;
      });
      fetched.catch(() => this.soundFiles.delete(file.fileId));
      this.soundFiles.set(file.fileId, fetched);
    }
    return fetched;
  }

  /**
   * Plays a sound to everyone else in the voice channel or call this device is in, who each play its
   * file themselves. What's sent says which sound, under the room's key, and names who played it.
   */
  async playSound(channelId: string, soundId: string): Promise<void> {
    if (!this.sounds.get(soundId)?.details) throw new Error("That sound isn't on the soundboard anymore.");
    if (this.activeVoice?.channelId !== channelId || !this.hasMlsGroup(channelId)) throw new Error("Join the voice channel to play sounds.");
    const epoch = this.rememberCurrentEpochKey(channelId);
    const key = this.epochKey(channelId, epoch);
    if (!key) throw new Error("This device can't play sounds here yet.");
    const play = { sound: soundId, user: this.account.userId, at: Date.now(), nonce: randomId() };
    const sealed = frameSigned(this.account.deviceId, epoch, sealEnvelope(key, this.account.deviceSecret, "play", channelId, this.account.userId, epoch, play, this.signer));
    await (this.isCall(channelId) ? this.api.playCallSound(channelId, sealed) : this.api.playSound(channelId, sealed));
  }

  /**
   * Someone else in the room played a sound. It plays here only if it opens under the room's key, was
   * played by whom the server says, and is new: the server handing it on again plays nothing.
   */
  protected onSoundFrame(data: { channel_id: string; user_id: string; data: string }): void {
    if (this.activeVoice?.channelId !== data.channel_id || data.user_id === this.account.userId || this.isBlocked(data.user_id)) return;
    // Signed by the device that played it, so that nobody else in the room can say who did.
    const signed = readSigned(decodeFrameData(data.data));
    const key = signed && this.epochKey(data.channel_id, signed.epoch);
    const device = signed && this.users.get(data.user_id)?.devices.get(signed.deviceId);
    if (!signed || !key || !device) return;
    const opened = openEnvelope<{ nonce?: unknown }>(key, device.signatureKey, "play", data.channel_id, data.user_id, signed.epoch, signed.envelope, { userId: data.user_id, deviceId: signed.deviceId });
    const play = opened.ok ? parsePlay(opened.value) : null;
    if (!play || play.user !== data.user_id || !this.sounds.get(play.sound)?.details) return;
    const now = Date.now();
    for (const [nonce, seen] of this.playsSeen) {
      if (now - seen > PLAY_FRESH_MS) this.playsSeen.delete(nonce);
    }
    if (Math.abs(now - play.at) > PLAY_FRESH_MS || this.playsSeen.has(play.nonce)) return;
    this.playsSeen.set(play.nonce, now);
    this.emit({ type: "sound", serverId: this.serverId, channelId: data.channel_id, userId: data.user_id, soundId: play.sound });
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
    return inviteLink(this.account.serverUrl, code, this.account.core.communityKey, this.account.pin);
  }

  linkForInvite(code: string): string {
    return inviteLink(this.account.serverUrl, code, this.account.core.communityKey, this.account.pin);
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

  /** Who is banned, when and by whom, the latest first. For admins. */
  async getBans(): Promise<BanView[]> {
    const { bans } = await this.api.bans();
    return bans.map((ban) => ({ userId: ban.user_id, bannedAt: ban.banned_at, bannedBy: ban.banned_by }));
  }

  serverUrl(): string {
    return this.account.serverUrl;
  }
}
