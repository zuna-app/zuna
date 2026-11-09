// One connection to a voice channel's room on the media server, which only ever sees
// encrypted media. Keys come from the channel's MLS group through the core.

import type { RemoteSession } from "@zuna/core/rpc";
import { parseVoiceIdentity, voiceKeyIndex, voiceSenderKey, VOICE_KEY_RING } from "@zuna/core/voice";
import {
  BaseKeyProvider,
  ConnectionQuality,
  ConnectionState,
  createKeyMaterialFromBuffer,
  DisconnectReason,
  type LocalAudioTrack,
  type LocalTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  type ScreenShareCaptureOptions,
  ScreenSharePresets,
  setLogLevel,
  Track,
  VideoPresets,
} from "livekit-client";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import { captureKey, MicError, Microphone, type MicReading } from "./mic";
import type { ScreenCodec, ScreenContent, ScreenPriority, VoiceSettings } from "./settings";
import type { StatsRoom, StatsStream } from "./stats";

/**
 * How long after hearing of a new key this device starts sending under it, so that
 * everyone else has heard too. It keeps listening under both meanwhile. Someone just
 * removed could go on hearing what's sent in this time.
 */
const NEW_KEY_SEND_DELAY_MS = 1500;
const STATS_EVERY_MS = 3000;
/** The microphone and a share, in how LiveKit's protocol numbers what can be published. */
const MICROPHONE_SOURCE = 2;
const SCREEN_SOURCE = 3;
const SCREEN_SOUND_SOURCE = 4;
/** How long the media server gets to say a share may go out, after the chat server has told it. */
const SHARE_PERMISSION_WAIT_MS = 5000;
const DEFAULT_AUDIO_KBPS = 64;
/** The computer's sound, without this call in it, and without what's only good for voice. */
const SYSTEM_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true } as MediaTrackConstraints;

// What LiveKit says about each step of connecting isn't for anyone to read in a released app.
setLogLevel("warn");

class MemberKeys extends BaseKeyProvider {
  constructor() {
    // A key that doesn't open a frame is no reason to give up on it: the sender may just be ahead.
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: VOICE_KEY_RING });
  }

  async install(roomKey: Uint8Array, identity: string, index: number): Promise<void> {
    const material = await createKeyMaterialFromBuffer(await voiceSenderKey(roomKey, identity));
    this.onSetEncryptionKey(material, identity, index);
  }
}

export type VideoSource = "camera" | "screen";

const DEGRADATION: Record<ScreenPriority, RTCDegradationPreference> = { sharp: "maintain-resolution", smooth: "maintain-framerate", balanced: "balanced" };

/** How to share through the browser's own capture. */
export interface BrowserShare {
  fps: number;
  bitrateKbps: number;
  /** The tallest the picture may be, or 0 for the screen's own size. */
  height: number;
  sound: boolean;
  soundKbps: number;
  content: ScreenContent;
  priority: ScreenPriority;
  codec: ScreenCodec;
  layers: boolean;
}

/** One video someone is sending. */
export interface VideoTile {
  key: string;
  userId: string;
  identity: string;
  source: VideoSource;
  track: Track;
  local: boolean;
  /** A share someone else is sending with its sound, which can be made quieter here. */
  sound?: boolean;
}

export type RoomStatus = "connecting" | "connected" | "reconnecting" | "closed";

/** Why a room can close that nothing should try to come back from. */
const ENDED_FOR_GOOD = new Set([DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.ROOM_DELETED, DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.CLIENT_INITIATED]);
export type RoomQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

export interface RoomEvents {
  /** Closed for good, it was ended on purpose, by this device, the server or another of its person's, and isn't to be come back to. */
  status(status: RoomStatus, forGood?: boolean): void;
  /** Who's sending what changed. */
  media(): void;
  speaking(users: Set<string>): void;
  reading(reading: MicReading): void;
  quality(quality: RoomQuality, rttMs: number | null): void;
  /** The microphone's device went away, and the default one is being used instead. */
  micLost(): void;
  /** Someone new came in or left the room. */
  participants(joined: string | null, left: string | null): void;
}

const QUALITY: Record<ConnectionQuality, RoomQuality> = {
  [ConnectionQuality.Excellent]: "excellent",
  [ConnectionQuality.Good]: "good",
  [ConnectionQuality.Poor]: "poor",
  [ConnectionQuality.Lost]: "lost",
  [ConnectionQuality.Unknown]: "unknown",
};

const userOf = (identity: string): string | null => parseVoiceIdentity(identity)?.userId ?? null;

export class VoiceRoom {
  private readonly room: Room;
  private readonly keys = new MemberKeys();
  private readonly audio: AudioContext;
  private mic: Microphone | null = null;
  private micPublication: LocalTrackPublication | undefined;
  /** The keys in use, newest first: what's being sent under may be one behind for a moment. */
  private roomKeys: { index: number; key: Uint8Array; epoch: number }[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private identity = "";
  private mediaUrl = "";
  private capturing = "";
  private closed = false;
  private readonly audioHolder = document.createElement("div");
  private volumes: (userId: string, shareSound: boolean) => number = () => 1;

  private constructor(
    private readonly session: RemoteSession,
    private readonly channelId: string,
    private settings: VoiceSettings,
    private readonly bitrate: number,
    private readonly on: RoomEvents,
  ) {
    this.audio = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    this.audioHolder.hidden = true;
    document.body.append(this.audioHolder);
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      webAudioMix: { audioContext: this.audio },
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      publishDefaults: { dtx: true, red: true, simulcast: true, videoCodec: "vp8" },
      encryption: { keyProvider: this.keys, worker: new E2EEWorker() },
    });
    this.watchRoom();
  }

  /** Comes into a channel. It throws if that can't be done, with something to tell the person. */
  static async join(session: RemoteSession, channelId: string, settings: VoiceSettings, bitrate: number, on: RoomEvents): Promise<VoiceRoom> {
    const room = new VoiceRoom(session, channelId, settings, bitrate, on);
    try {
      await room.connect();
      return room;
    } catch (error) {
      room.close();
      throw error;
    }
  }

  /** The microphone, or null with why not. Nothing about voice needs one: someone without one can still listen. */
  private async openMic(): Promise<string | null> {
    try {
      this.mic = await Microphone.open(this.audio, this.settings);
      this.capturing = captureKey(this.settings);
      this.mic.onReading = (reading) => this.on.reading(reading);
      this.mic.onDeviceLost = () => void this.recoverMic();
      return null;
    } catch (error) {
      return error instanceof MicError ? error.message : "The microphone couldn't be used.";
    }
  }

  micProblem: string | null = null;

  private async connect(): Promise<void> {
    await this.audio.resume().catch(() => undefined);
    this.micProblem = await this.openMic();
    const access = await this.session.voiceAccess(this.channelId);
    this.mediaUrl = access.url;
    this.identity = access.identity;
    this.serverMuted = access.serverMuted;
    await this.updateKeys(true);
    await this.room.setE2EEEnabled(true);
    await this.room.connect(access.url, access.token, { autoSubscribe: true });
    // Those already here, and everything they send.
    for (const participant of this.room.remoteParticipants.values()) await this.installFor(participant.identity);
    await this.publishMic();
    this.statsTimer = setInterval(() => void this.readStats(), STATS_EVERY_MS);
    if (this.settings.outputDevice !== "default") await this.room.switchActiveDevice("audiooutput", this.settings.outputDevice).catch(() => undefined);
  }

  /** An admin has muted this person, so the media server wouldn't take a microphone anyway. */
  serverMuted = false;

  private async publishMic(): Promise<void> {
    if (!this.mic || this.serverMuted || this.micPublication) return;
    // Muting a publication disables its track, which stays disabled once it's taken down. An
    // admin's mute can do that before the media server takes the microphone away, and a new
    // publication would then send silence while saying it isn't muted.
    this.mic.track.enabled = true;
    this.micPublication = await this.room.localParticipant.publishTrack(this.mic.track, {
      source: Track.Source.Microphone,
      name: "microphone",
      dtx: true,
      red: true,
      audioPreset: { maxBitrate: (this.bitrate || DEFAULT_AUDIO_KBPS) * 1000 },
    });
    if (this.muted) await this.micPublication.mute();
  }

  private watchRoom(): void {
    const room = this.room;
    room
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        if (this.closed) return;
        if (state === ConnectionState.Connected) this.on.status("connected");
        else if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) this.on.status("reconnecting");
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (!this.closed) this.on.status("closed", reason !== undefined && ENDED_FOR_GOOD.has(reason));
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        void this.installFor(participant.identity);
        const user = userOf(participant.identity);
        if (user) this.on.participants(user, null);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        const user = userOf(participant.identity);
        if (user) this.on.participants(null, user);
        this.on.media();
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.onSubscribed(track, publication, participant))
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const element of track.detach()) element.remove();
        this.on.media();
      })
      .on(RoomEvent.TrackMuted, () => this.on.media())
      .on(RoomEvent.TrackUnmuted, () => this.on.media())
      .on(RoomEvent.TrackPublished, () => this.on.media())
      .on(RoomEvent.TrackUnpublished, () => this.on.media())
      .on(RoomEvent.LocalTrackPublished, () => this.on.media())
      .on(RoomEvent.LocalTrackUnpublished, () => this.on.media())
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        const users = new Set<string>();
        for (const speaker of speakers) {
          const user = userOf(speaker.identity);
          if (user && speaker.identity !== this.identity) users.add(user);
        }
        this.on.speaking(users);
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant.isLocal) {
          this.quality = QUALITY[quality];
          this.on.quality(this.quality, this.rtt);
        }
      })
      .on(RoomEvent.ParticipantPermissionsChanged, () => void this.onPermissions())
      // Someone new can't open what others send under the old key for a moment, which is expected.
      .on(RoomEvent.EncryptionError, (error) => {
        if (!String(error).includes("MissingKey")) console.warn("[zuna] voice encryption", error);
      });
  }

  private quality: RoomQuality = "unknown";
  private rtt: number | null = null;

  private async readStats(): Promise<void> {
    const track = this.micPublication?.track as LocalAudioTrack | undefined;
    const stats = await track?.getSenderStats().catch(() => undefined);
    if (stats?.roundTripTime !== undefined) this.rtt = Math.round(stats.roundTripTime * 1000);
    this.on.quality(this.quality, this.rtt);
  }

  /** An admin muted or unmuted this person, which takes the microphone away or lets it back. */
  private async onPermissions(): Promise<void> {
    const allowed = this.room.localParticipant.permissions?.canPublishSources ?? [];
    this.serverMuted = allowed.length > 0 && !allowed.includes(MICROPHONE_SOURCE);
    if (this.serverMuted && this.micPublication?.track) {
      await this.room.localParticipant.unpublishTrack(this.micPublication.track, false).catch(() => undefined);
      this.micPublication = undefined;
    } else if (!this.serverMuted) {
      await this.publishMic().catch((error) => console.warn("[zuna] voice microphone", error));
    }
  }

  private onSubscribed(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (track.kind === Track.Kind.Audio) {
      const audio = track as RemoteAudioTrack;
      this.audioHolder.append(audio.attach());
      const user = userOf(participant.identity);
      if (user) audio.setVolume(this.volumes(user, publication.source === Track.Source.ScreenShareAudio));
    }
    this.on.media();
  }

  // --- Keys ---

  /** Installs everyone's keys for this channel's epoch, or for a new epoch once it's come. */
  async updateKeys(first = false): Promise<void> {
    const { epoch, key } = await this.session.voiceKey(this.channelId);
    if (this.closed || this.roomKeys[0]?.epoch === epoch) return;
    const index = voiceKeyIndex(epoch);
    this.roomKeys = [{ index, key, epoch }, ...this.roomKeys.slice(0, 1)];
    for (const participant of this.room.remoteParticipants.values()) await this.keys.install(key, participant.identity, index);
    clearTimeout(this.sendTimer);
    if (first) {
      await this.keys.install(key, this.identity, index);
      return;
    }
    this.sendTimer = setTimeout(() => void this.keys.install(key, this.identity, index), NEW_KEY_SEND_DELAY_MS);
  }

  /** The keys a participant may be sending under: the older first, so the newer ends up current. */
  private async installFor(identity: string): Promise<void> {
    if (identity === this.identity) return;
    for (const { key, index } of [...this.roomKeys].reverse()) await this.keys.install(key, identity, index);
  }

  // --- Microphone ---

  private muted = false;

  /** Whether sound goes out from here. */
  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    this.mic?.setMuted(muted);
    if (this.micPublication) {
      if (muted) await this.micPublication.mute();
      else await this.micPublication.unmute();
    }
  }

  setKeyHeld(down: boolean): void {
    this.mic?.setKey(down);
  }

  get hasMic(): boolean {
    return !!this.mic;
  }

  /** Takes on changed settings, opening the microphone again only if that's what they need. */
  async applySettings(settings: VoiceSettings): Promise<void> {
    const outputChanged = settings.outputDevice !== this.settings.outputDevice;
    this.settings = settings;
    if (this.mic) {
      if (captureKey(settings) !== this.capturing) {
        this.capturing = captureKey(settings);
        await this.mic.reopen(settings).catch((error) => console.warn("[zuna] voice microphone", error));
      } else {
        this.mic.apply(settings);
      }
    }
    if (outputChanged) await this.room.switchActiveDevice("audiooutput", settings.outputDevice).catch(() => undefined);
    this.applyVolumes();
  }

  private async recoverMic(): Promise<void> {
    if (this.closed || !this.mic) return;
    this.on.micLost();
    await this.mic.reopen({ ...this.settings, inputDevice: "default" }).catch((error) => console.warn("[zuna] voice microphone", error));
  }

  // --- Listening ---

  /** Says how loud everyone is, which also covers being deafened. */
  /** How loud each person is, and their share's sound, which has a level of its own. */
  setVolumes(volumes: (userId: string, shareSound: boolean) => number): void {
    this.volumes = volumes;
    this.applyVolumes();
  }

  applyVolumes(): void {
    for (const participant of this.room.remoteParticipants.values()) {
      const user = userOf(participant.identity);
      if (!user) continue;
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === Track.Kind.Audio && publication.track) (publication.track as RemoteAudioTrack).setVolume(this.volumes(user, publication.source === Track.Source.ScreenShareAudio));
      }
    }
  }

  // --- Soundboard ---

  /** Reads a sound's file into what can be played. */
  decodeSound(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.audio.decodeAudioData(data);
  }

  /**
   * Plays a sound from the soundboard on this device, through the same context as everyone's voices,
   * so it goes where they go and the microphone's echo cancelling treats it as it does them.
   */
  playSound(sound: AudioBuffer, volume: number): void {
    if (this.closed) return;
    const source = this.audio.createBufferSource();
    const gain = this.audio.createGain();
    source.buffer = sound;
    gain.gain.value = volume;
    source.connect(gain).connect(this.audio.destination);
    source.onended = () => gain.disconnect();
    source.start();
  }

  // --- Video ---

  /** Everything being sent that can be watched, and from here. */
  videos(): VideoTile[] {
    const tiles: VideoTile[] = [];
    // A share from someone's native app goes out from a connection of its own, and its sound from theirs.
    const sound = new Set<string>();
    for (const participant of this.room.remoteParticipants.values()) {
      const user = userOf(participant.identity);
      if (user && [...participant.trackPublications.values()].some((publication) => publication.source === Track.Source.ScreenShareAudio)) sound.add(user);
    }
    const add = (participant: Participant, local: boolean) => {
      const parsed = parseVoiceIdentity(participant.identity);
      if (!parsed) return;
      for (const publication of participant.trackPublications.values()) {
        const { track } = publication;
        if (publication.kind !== Track.Kind.Video || !track || publication.isMuted) continue;
        const source: VideoSource = publication.source === Track.Source.ScreenShare ? "screen" : "camera";
        tiles.push({ key: `${participant.identity}/${publication.trackSid}`, userId: parsed.userId, identity: participant.identity, source, track, local, sound: source === "screen" && !local && sound.has(parsed.userId) });
      }
    };
    add(this.room.localParticipant, true);
    for (const participant of this.room.remoteParticipants.values()) add(participant, false);
    return tiles;
  }

  async setCamera(on: boolean, deviceId: string): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(on, on && deviceId !== "default" ? { deviceId, resolution: VideoPresets.h720.resolution } : { resolution: VideoPresets.h720.resolution });
    this.on.media();
  }

  private mayPublish(source: number): boolean {
    const allowed = this.room.localParticipant.permissions?.canPublishSources ?? [];
    return allowed.length === 0 || allowed.includes(source);
  }

  /**
   * Waits to hear from the media server that a share may go out, since it only allows one once
   * the chat server has told it to. Should that not come, publishing says what's wrong.
   */
  async whenAllowedToShare(screen: boolean, sound: boolean): Promise<void> {
    const ready = () => (!screen || this.mayPublish(SCREEN_SOURCE)) && (!sound || this.mayPublish(SCREEN_SOUND_SOURCE));
    if (ready()) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.room.off(RoomEvent.ParticipantPermissionsChanged, check);
        resolve();
      };
      const check = () => {
        if (ready()) finish();
      };
      const timer = setTimeout(finish, SHARE_PERMISSION_WAIT_MS);
      this.room.on(RoomEvent.ParticipantPermissionsChanged, check);
    });
  }

  /** Shares through the browser's own capture. */
  async startBrowserScreen(share: BrowserShare): Promise<void> {
    const canSend = (name: string) => RTCRtpSender.getCapabilities("video")?.codecs.some((codec) => codec.mimeType.toLowerCase() === `video/${name}`);
    // Hardware encoders are mostly for H.264, which is what keeps a share from taking up the CPU.
    const videoCodec = share.codec !== "auto" && canSend(share.codec) ? share.codec : canSend("h264") ? "h264" : "vp8";
    await this.room.localParticipant.setScreenShareEnabled(
      true,
      {
        audio: share.sound ? SYSTEM_AUDIO : false,
        contentHint: share.content,
        // The screen's own size, which LiveKit takes as no constraints at all and so leaves out
        // the frame rate with it. Browsers then capture at their default of about 30.
        resolution: ScreenSharePresets.original.resolution,
        video: { frameRate: { ideal: share.fps, max: share.fps }, ...(share.height > 0 ? { height: { max: share.height } } : {}) } as ScreenShareCaptureOptions["video"],
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: share.sound ? "include" : "exclude",
      },
      {
        videoCodec,
        simulcast: share.layers,
        screenShareEncoding: { maxBitrate: share.bitrateKbps * 1000, maxFramerate: share.fps },
        degradationPreference: DEGRADATION[share.priority],
        audioPreset: { maxBitrate: share.soundKbps * 1000 },
        dtx: false,
        red: false,
      },
    );
    this.on.media();
  }

  async stopBrowserScreen(): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
    this.on.media();
  }

  /** Whether a share through the browser is going, and for how long it's been stopped from outside. */
  get sharingInBrowser(): boolean {
    return this.room.localParticipant.isScreenShareEnabled;
  }

  /** Called when the person stops a browser share from the browser's own bar. */
  onBrowserShareEnded(listener: () => void): void {
    this.room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) listener();
    });
  }

  get cameraOn(): boolean {
    return this.room.localParticipant.isCameraEnabled;
  }

  // --- Stats ---

  /** Where this connection is, and everything going through it that can be read. */
  statsRoom(status: string): StatsRoom {
    const streams: StatsStream[] = [];
    const add = (participant: Participant, local: boolean) => {
      const parsed = parseVoiceIdentity(participant.identity);
      if (!parsed) return;
      for (const publication of participant.trackPublications.values()) {
        const track = publication.track as LocalTrack | RemoteTrack | undefined;
        if (track) streams.push({ key: `${participant.identity}/${publication.trackSid}`, userId: parsed.userId, local, source: publication.source, native: publication.source === Track.Source.ScreenShare && publication.trackName === "screen", track, publication });
      }
    };
    add(this.room.localParticipant, true);
    for (const participant of this.room.remoteParticipants.values()) add(participant, false);
    const key = this.roomKeys[0];
    return {
      status,
      url: this.mediaUrl,
      serverVersion: this.room.serverInfo?.version,
      serverRegion: this.room.serverInfo?.region,
      serverNode: this.room.serverInfo?.nodeId,
      people: this.room.remoteParticipants.size + 1,
      encrypted: this.room.isE2EEEnabled,
      keyIndex: key?.index,
      keyEpoch: key?.epoch,
      streams,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.sendTimer);
    clearInterval(this.statsTimer);
    this.mic?.stop();
    void this.room.disconnect();
    this.audioHolder.remove();
    void this.audio.close().catch(() => undefined);
  }
}

