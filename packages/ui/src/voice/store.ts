// The voice channel or call this device is in, wherever in the app the person is looking.
// There's one at a time, across all servers, as in Discord. A call is a direct message's or a
// group's, in a room of its own under the conversation's group, and everything a voice channel
// has works the same in it.

import { screenTerms } from "@zuna/core/voice";
import { Track } from "livekit-client";
import { create } from "zustand";
import { conversationOfGroup, useApp } from "@/state/store";
import { voiceHooks } from "./events";
import type { MicReading } from "./mic";
import { DisconnectReason, VoiceRoom, type RoomQuality, type VideoTile } from "./room";
import { bitrateName, heightName, loadVoiceSettings, loadVolumes, rateName, saveVoiceSettings, saveVolumes, type VoiceSettings } from "./settings";
import { playVoiceSound, setSoundOutput, type VoiceSound } from "./sounds";
import type { StatSection, StatsShare, StreamStats } from "./stats";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface ScreenChoice {
  /** The sound the browser offers with it goes too. */
  audio: boolean;
}

interface VoiceState {
  status: VoiceStatus;
  serverId: string | null;
  /** The voice channel, or the group of the conversation whose call it is. */
  channelId: string | null;
  /** It's a conversation's call rather than a voice channel. */
  call: boolean;
  /** Muted by the person. */
  muted: boolean;
  deafened: boolean;
  /** Muted by an admin, which only an admin can undo. */
  serverMuted: boolean;
  /** No microphone could be used, so this device can only listen. */
  noMic: boolean;
  /** Sound is going out from this device right now. */
  open: boolean;
  /** The push to talk key is down. */
  keyHeld: boolean;
  speaking: Record<string, true>;
  videos: VideoTile[];
  quality: RoomQuality;
  rtt: number | null;
  camera: boolean;
  /** What this device is sharing. */
  screen: StatsShare | null;
  /** The video filling the stage, by its key. */
  focus: string | null;
  settings: VoiceSettings;
  /** How loud each person is for this device, by user. */
  volumes: Record<string, number>;
  /** How loud each person's shared screen is for this device, by user. */
  streamVolumes: Record<string, number>;
  /** People muted for this device only. */
  localMutes: Record<string, true>;
  /** Who's playing a sound from the soundboard right now, by user, with what to show for it. */
  sounding: Record<string, string>;

  /** Comes into a voice channel or a call. `returnTo` is what to open again on leaving a voice channel, if it's said. */
  join(serverId: string, channelId: string, returnTo?: string | null, how?: JoinHow): Promise<void>;
  /** Calls the people in a conversation, starting a direct message if nobody's written in it yet. */
  startCall(serverId: string, conversationKey: string, camera: boolean): Promise<void>;
  /** Stops a call ringing on all this person's devices. */
  decline(serverId: string, groupId: string): void;
  /** Rings everyone in the call's conversation who isn't in it. */
  ringAgain(userIds?: string[]): Promise<void>;
  leave(): void;
  toggleMute(): void;
  toggleDeafen(): void;
  toggleCamera(): Promise<void>;
  startScreen(choice: ScreenChoice): Promise<void>;
  stopScreen(): Promise<void>;
  setVolume(userId: string, volume: number): void;
  setStreamVolume(userId: string, volume: number): void;
  toggleLocalMute(userId: string): void;
  /** Plays a sound from the soundboard to everyone in the voice channel or call, here too. */
  playSound(soundId: string): Promise<void>;
  setFocus(key: string | null): void;
  updateSettings(changes: Partial<VoiceSettings>): void;
  setKeyHeld(down: boolean): void;
  /** What's going out and coming in right now, for the stream stats window. */
  readStats(reader: StreamStats, nameOf: (userId: string) => string): Promise<StatSection[]>;
}

/** How to come into a room. */
export interface JoinHow {
  /** It starts a call, ringing everyone else in the conversation. */
  ring?: boolean;
  /** The camera goes on once in. */
  camera?: boolean;
}

const NOT_IN_VOICE = {
  status: "idle" as VoiceStatus,
  serverId: null,
  channelId: null,
  call: false,
  serverMuted: false,
  noMic: false,
  open: false,
  keyHeld: false,
  speaking: {},
  videos: [],
  quality: "unknown" as RoomQuality,
  rtt: null,
  camera: false,
  screen: null,
  focus: null,
  sounding: {},
};

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_WAIT_MS = 2000;

/** The server said no to a share, in words meant for the person. */
class ShareRefused extends Error {}

const micFilters = (settings: VoiceSettings): string =>
  [
    { zuna: "RNNoise", standard: "the browser's noise suppression", off: null }[settings.noiseSuppression],
    settings.inputMode === "ptt" ? "push to talk" : settings.autoSensitivity ? "a gate on speech" : `a gate at ${settings.sensitivity} dB`,
    settings.echoCancellation && "echo cancelling",
    settings.autoGain && "automatic gain",
  ]
    .filter(Boolean)
    .join(", ");

let room: VoiceRoom | null = null;
/** Each join counts, so one that takes a while can tell it's been replaced. */
let attempt = 0;
let reconnects = 0;
/** What was open before coming into a voice channel. */
let openBefore: string | null = null;
/** This device still has to say it's starting the call it's in, which rings everyone else. */
let ringOnAnnounce = false;
/** The call this device is in has rung someone, so that nobody being rung any more means something. */
let callRang = false;
let hangUpTimer: ReturnType<typeof setTimeout> | undefined;
/** How long a direct message's call waits, once the other person seems to have gone, in case it's another of their devices taking over. */
const PEER_GONE_MS = 2000;

/** Sounds from the soundboard, read and ready to play, by server and sound. */
const soundBuffers = new Map<string, Promise<AudioBuffer>>();
/** How long someone shows as playing a sound past its end, so a short one is seen. */
const SOUNDING_HOLD_MS = 600;
const soundingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const readings = new Set<(reading: MicReading) => void>();

/** How loud this device's microphone is, many times a second. Apart from the store, so that doesn't redraw everything. */
export function watchMic(listener: (reading: MicReading) => void): () => void {
  readings.add(listener);
  return () => readings.delete(listener);
}

export const useVoice = create<VoiceState>((set, get) => {
  const sound = (name: VoiceSound) => {
    const { settings } = get();
    if (settings.sounds) playVoiceSound(name, Math.min(1, settings.outputVolume));
  };

  const session = () => {
    const { serverId } = get();
    return serverId ? useApp.getState().session(serverId) : null;
  };

  /** Tells everyone on the server what this device is doing, or the conversation's members in a call. */
  const announce = () => {
    const { channelId, muted, deafened, camera, screen, noMic, serverMuted } = get();
    if (!channelId) return;
    const ring = ringOnAnnounce;
    ringOnAnnounce = false;
    void session()?.setVoiceState(channelId, { muted: muted || noMic || serverMuted, deafened, camera, screen: !!screen }, ring);
  };

  const applyVolumes = () => {
    room?.setVolumes((userId, source) => {
      const { deafened, settings, volumes, streamVolumes, localMutes } = get();
      if (deafened) return 0;
      // A share's sound has a level of its own: it isn't how loud the person talks.
      if (source === Track.Source.ScreenShareAudio) return settings.outputVolume * settings.screenVolume * (streamVolumes[userId] ?? 1);
      return localMutes[userId] ? 0 : settings.outputVolume * (volumes[userId] ?? 1);
    });
  };

  /**
   * When a share through the browser last went away by itself. A server that stops one takes away the
   * media server's permission too, which can end it before the server's word on why arrives.
   */
  let shareVanishedAt = 0;

  const syncVideos = () => {
    if (!room) return;
    const videos = room.videos();
    const { focus, screen, videos: before, settings } = get();
    const stillThere = !focus || videos.some((video) => video.key === focus);
    // A screen someone starts sharing is what everyone's there to see, unless they're already looking at something.
    const arrived = settings.screenFocus ? videos.find((video) => video.source === "screen" && !video.local && !before.some((other) => other.key === video.key)) : undefined;
    set({ videos, focus: stillThere && focus ? focus : (arrived?.key ?? null), camera: room.cameraOn });
    if (screen && !room.sharingInBrowser) {
      shareVanishedAt = Date.now();
      void endShare(true);
    }
  };

  /** Stops what this device is sharing, if anything. A server that stopped it has already given up its place. */
  const endShare = async (giveUpPlace: boolean) => {
    const { screen, channelId } = get();
    if (!screen) return;
    set({ screen: null });
    await room?.stopBrowserScreen();
    if (giveUpPlace && channelId) await session()?.voiceScreenStop(channelId).catch((error) => console.warn("[zuna] giving up a place to share", error));
    announce();
    sound("self-leave");
  };

  /** There's nothing to show for a voice channel once out of it, so whatever was open before comes back. A call's chat stays. */
  const closeStage = (serverId: string | null, channelId: string | null) => {
    const returnTo = openBefore;
    openBefore = null;
    if (!serverId || !channelId || !useApp.getState().servers[serverId]?.channels.some((channel) => channel.id === channelId)) return;
    useApp.setState((state) => {
      const server = state.servers[serverId];
      if (server?.activeKey !== `group:${channelId}`) return state;
      return { servers: { ...state.servers, [serverId]: { ...server, activeKey: returnTo } }, panel: null };
    });
  };

  const closeRoom = () => {
    room?.close();
    room = null;
    ringOnAnnounce = false;
    callRang = false;
    clearTimeout(hangUpTimer);
  };

  /** What to do when the room goes away without anyone asking: try coming back, as far as that's worth it. */
  const onClosed = (reason?: DisconnectReason) => {
    const { serverId, channelId } = get();
    closeRoom();
    // Coming back shares nothing until someone asks again, and the server knows that from the new connection.
    set({ screen: null });
    if (!serverId || !channelId) return;
    if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.DUPLICATE_IDENTITY || reason === DisconnectReason.CLIENT_INITIATED) {
      get().leave();
      return;
    }
    if (reconnects >= RECONNECT_ATTEMPTS) {
      useApp.getState().toast("Lost the connection to voice.", "error");
      get().leave();
      return;
    }
    reconnects++;
    set({ status: "reconnecting" });
    const mine = ++attempt;
    setTimeout(() => {
      if (mine === attempt) void connect(serverId, channelId, mine);
    }, RECONNECT_WAIT_MS);
  };

  const connect = async (serverId: string, channelId: string, mine: number, how: JoinHow = {}) => {
    const app = useApp.getState();
    const channels = app.servers[serverId]?.channels ?? [];
    const bitrate = channels.find((item) => item.id === channelId)?.bitrate ?? 0;
    // Not known until it's finished joining, and what happens before then has nobody to tell.
    let joined: VoiceRoom | undefined;
    const current = () => !!joined && room === joined;
    try {
      joined = await VoiceRoom.join(app.session(serverId), channelId, get().settings, bitrate, {
        status(status, reason) {
          if (!current()) return;
          if (status === "connected") {
            reconnects = 0;
            set({ status: "connected" });
          } else if (status === "reconnecting") {
            set({ status: "reconnecting" });
          } else if (status === "closed") {
            onClosed(reason);
          }
        },
        media: () => {
          if (current()) syncVideos();
        },
        speaking: (users) => {
          if (!current()) return;
          const next: Record<string, true> = {};
          for (const user of users) next[user] = true;
          set({ speaking: next });
        },
        reading: (reading) => {
          if (!current()) return;
          if (reading.open !== get().open) set({ open: reading.open });
          for (const listener of readings) listener(reading);
        },
        quality: (quality, rtt) => {
          if (current() && (quality !== get().quality || rtt !== get().rtt)) set({ quality, rtt });
        },
        micLost: () => app.toast("Your microphone went away, so Zuna switched to the default one.", "info"),
        participants: (came, left) => {
          if (came || left) sound(came ? "join" : "leave");
        },
      });
      if (mine !== attempt) {
        joined.close();
        return;
      }
      room = joined;
      applyVolumes();
      const { muted, deafened } = get();
      const noMic = !joined.hasMic;
      if (joined.micProblem) app.toast(`${joined.micProblem} You can still listen.`, "info");
      await joined.setMuted(muted || deafened || noMic);
      set({ status: "connected", noMic, serverMuted: joined.serverMuted });
      joined.onBrowserShareEnded(() => {
        if (current()) syncVideos();
      });
      announce();
      syncVideos();
      if (reconnects === 0) sound("self-join");
      if (how.camera && !get().camera) await get().toggleCamera();
    } catch (error) {
      console.warn("[zuna] joining a voice channel", error);
      if (mine !== attempt) return;
      app.toast((error as Error).message || "Couldn't connect to voice.", "error");
      // A server that hasn't set this up, or a channel that's full, won't change in a moment.
      set({ ...NOT_IN_VOICE });
      closeStage(serverId, channelId);
      void app.session(serverId).setVoiceState(null, null);
    }
  };

  voiceHooks.onKey = (serverId, channelId) => {
    if (get().serverId === serverId && get().channelId === channelId) {
      void room?.updateKeys().catch((error) => console.warn("[zuna] voice keys", error));
    }
  };
  voiceHooks.onEnded = (serverId, channelId, reason) => {
    if (get().serverId !== serverId || get().channelId !== channelId) return;
    attempt++;
    closeRoom();
    set({ ...NOT_IN_VOICE });
    closeStage(serverId, channelId);
    const message: Record<string, string> = {
      elsewhere: "You joined this voice channel on another device.",
      disconnected: "An admin took you out of the voice channel.",
      deleted: "That voice channel was deleted.",
      banned: "You were removed from this server.",
    };
    const call: Record<string, string> = {
      elsewhere: "You joined this call on another device.",
      removed: "You're no longer in this conversation, so you left its call.",
      deleted: "That conversation was deleted.",
      banned: "You were removed from this server.",
    };
    const wasCall = !useApp.getState().servers[serverId]?.channels.some((channel) => channel.id === channelId);
    useApp.getState().toast((wasCall ? call : message)[reason] ?? (wasCall ? "You left the call." : "You left the voice channel."), "info");
    sound("self-leave");
  };
  /** A direct message's call that nobody answers ends by itself, as a phone call does. */
  voiceHooks.onCall = (serverId, groupId, call) => {
    const { serverId: inServer, channelId, status } = get();
    if (inServer !== serverId || channelId !== groupId || status === "idle" || !call) return;
    if (call.ringing.length > 0) {
      callRang = true;
      return;
    }
    const server = useApp.getState().servers[serverId];
    const self = server?.self?.userId;
    const conversation = conversationOfGroup(server, groupId);
    if (!callRang || conversation?.kind !== "dm" || call.startedBy !== self) return;
    const others = Object.values(server!.voice).some((member) => member.channelId === groupId && member.userId !== self);
    if (others) return;
    const name = (conversation.peerId && server!.users[conversation.peerId]?.displayName) || conversation.title;
    get().leave();
    useApp.getState().toast(conversation.peerId && call.declined.includes(conversation.peerId) ? `${name} declined the call.` : `${name} didn't answer.`, "info");
  };
  /** And once the other person in one hangs up, it's over. */
  voiceHooks.onLeft = (serverId, channelId, userId) => {
    const { serverId: inServer, channelId: inChannel, status } = get();
    const server = useApp.getState().servers[serverId];
    if (inServer !== serverId || inChannel !== channelId || status === "idle" || userId === server?.self?.userId) return;
    if (conversationOfGroup(server, channelId)?.kind !== "dm") return;
    clearTimeout(hangUpTimer);
    hangUpTimer = setTimeout(() => {
      const now = useApp.getState().servers[serverId];
      if (get().serverId !== serverId || get().channelId !== channelId) return;
      const self = now?.self?.userId;
      if (!Object.values(now?.voice ?? {}).some((member) => member.channelId === channelId && member.userId !== self)) get().leave();
    }, PEER_GONE_MS);
  };
  voiceHooks.onScreenEnded = (serverId, channelId, reason) => {
    if (get().serverId !== serverId || get().channelId !== channelId) return;
    if (!get().screen && Date.now() - shareVanishedAt > 5000) return;
    shareVanishedAt = 0;
    void endShare(false);
    useApp.getState().toast(reason === "stopped" ? "An admin stopped your screen share." : "This server's rules changed, so your screen share stopped.", "info");
  };
  voiceHooks.onServerGone = (serverId) => {
    if (get().serverId === serverId) get().leave();
  };

  /**
   * Plays a sound from the soundboard here, as someone played it, unless this device hears nothing
   * of theirs: deafened, the person muted for this device, or the soundboard turned all the way down.
   */
  const playHere = async (serverId: string, soundId: string, userId: string) => {
    const playing = room;
    const { settings, deafened, localMutes } = get();
    if (!playing || get().serverId !== serverId || deafened || localMutes[userId] || settings.soundboardVolume <= 0) return;
    const key = `${serverId}/${soundId}`;
    let ready = soundBuffers.get(key);
    if (!ready) {
      ready = useApp
        .getState()
        .session(serverId)
        .soundFile(soundId)
        .then((file) => file.arrayBuffer())
        .then((data) => playing.decodeSound(data));
      ready.catch(() => soundBuffers.delete(key));
      soundBuffers.set(key, ready);
    }
    const buffer = await ready;
    if (room !== playing || get().deafened) return;
    playing.playSound(buffer, get().settings.outputVolume * get().settings.soundboardVolume);
    const emoji = useApp.getState().servers[serverId]?.sounds.find((sound) => sound.id === soundId)?.emoji || "🔊";
    set({ sounding: { ...get().sounding, [userId]: emoji } });
    clearTimeout(soundingTimers.get(userId));
    soundingTimers.set(
      userId,
      setTimeout(() => {
        soundingTimers.delete(userId);
        const sounding = { ...get().sounding };
        delete sounding[userId];
        set({ sounding });
      }, buffer.duration * 1000 + SOUNDING_HOLD_MS),
    );
  };
  voiceHooks.onSound = (serverId, channelId, userId, soundId) => {
    if (get().serverId !== serverId || get().channelId !== channelId) return;
    void playHere(serverId, soundId, userId).catch((error) => console.warn("[zuna] playing a sound", error));
  };
  /** Being muted by an admin, or no longer, comes with the rest of what's said about this device. */
  voiceHooks.onMember = (serverId, member) => {
    if (get().serverId !== serverId || get().channelId !== member.channelId) return;
    const self = useApp.getState().servers[serverId]?.self;
    if (member.deviceId !== self?.deviceId || member.serverMuted === get().serverMuted) return;
    set({ serverMuted: member.serverMuted });
    void room?.setMuted(member.serverMuted || get().muted || get().deafened || get().noMic);
    useApp.getState().toast(member.serverMuted ? "An admin muted you." : "An admin unmuted you.", "info");
    sound(member.serverMuted ? "mute" : "unmute");
  };

  const applyMute = () => {
    const { muted, deafened, serverMuted, noMic } = get();
    void room?.setMuted(muted || deafened || serverMuted || noMic);
    announce();
  };

  const initial = loadVoiceSettings();
  setSoundOutput(initial.outputDevice);

  return {
    ...NOT_IN_VOICE,
    muted: initial.startMuted,
    deafened: false,
    settings: initial,
    volumes: loadVolumes(),
    streamVolumes: loadVolumes("stream"),
    localMutes: {},

    async join(serverId, channelId, returnTo, how = {}) {
      const { serverId: inServer, channelId: inChannel, status } = get();
      // Moving between voice channels keeps what was open before the first of them.
      const before = returnTo !== undefined ? returnTo : openBefore;
      openBefore = before;
      if (inServer === serverId && inChannel === channelId && status !== "idle") return;
      if (status !== "idle") get().leave();
      openBefore = before;
      const mine = ++attempt;
      reconnects = 0;
      const call = !useApp.getState().servers[serverId]?.channels.some((channel) => channel.id === channelId);
      set({ ...NOT_IN_VOICE, status: "connecting", serverId, channelId, call });
      ringOnAnnounce = !!how.ring && call;
      await connect(serverId, channelId, mine, how);
    },

    async startCall(serverId, conversationKey, camera) {
      const app = useApp.getState();
      let groupId: string;
      try {
        groupId = await app.session(serverId).prepareCall(conversationKey);
      } catch (error) {
        app.toast((error as Error).message || "Couldn't start the call.", "error");
        return;
      }
      // Someone else may have called meanwhile, which this joins rather than ringing anyone.
      const going = Object.values(useApp.getState().servers[serverId]?.voice ?? {}).some((member) => member.channelId === groupId);
      await get().join(serverId, groupId, undefined, { ring: !going, camera });
    },

    decline(serverId, groupId) {
      void useApp
        .getState()
        .session(serverId)
        .declineCall(groupId)
        .catch((error) => useApp.getState().toast((error as Error).message, "error"));
    },

    async ringAgain(userIds) {
      const { serverId, channelId, call } = get();
      if (!serverId || !channelId || !call) return;
      await useApp
        .getState()
        .session(serverId)
        .ringCall(channelId, userIds)
        .catch((error) => useApp.getState().toast((error as Error).message, "error"));
    },

    leave() {
      const { status, serverId, channelId } = get();
      if (status === "idle") return;
      attempt++;
      closeRoom();
      if (serverId) void useApp.getState().session(serverId).setVoiceState(null, null);
      set({ ...NOT_IN_VOICE });
      closeStage(serverId, channelId);
      sound("self-leave");
    },

    toggleMute() {
      const { muted, deafened, noMic, serverMuted } = get();
      if (noMic || serverMuted) return;
      // Unmuting while deafened undoes both, as being deafened means hearing nothing and saying nothing.
      if (deafened) {
        set({ deafened: false, muted: false });
        applyVolumes();
        applyMute();
        sound("undeafen");
        return;
      }
      set({ muted: !muted });
      applyMute();
      sound(muted ? "unmute" : "mute");
    },

    toggleDeafen() {
      const { deafened } = get();
      set({ deafened: !deafened });
      applyVolumes();
      applyMute();
      sound(deafened ? "undeafen" : "deafen");
    },

    async toggleCamera() {
      if (!room) return;
      const on = !get().camera;
      try {
        await room.setCamera(on, get().settings.cameraDevice);
        set({ camera: on });
        announce();
      } catch {
        useApp.getState().toast("There's no camera Zuna can use.", "error");
      }
    },

    async startScreen(choice) {
      const current = room;
      const app = useApp.getState();
      const { channelId, serverId, settings } = get();
      if (!current || !channelId || !serverId || get().screen) return;
      const server = app.servers[serverId];
      const session = app.session(serverId);
      const terms = screenTerms({ height: settings.screenHeight, fps: settings.screenFps, kbps: settings.screenBitrate, soundKbps: settings.screenSoundKbps }, server?.info?.screen_share, server?.self?.role);
      const wantsSound = choice.audio && terms.sound;
      const held = terms.held.map((name) => ({ height: heightName(terms.height), fps: rateName(terms.fps), kbps: bitrateName(terms.kbps), soundKbps: `${bitrateName(terms.soundKbps)} of sound` })[name]);
      const asked = { name: "Your screen", fps: terms.fps, bitrateKbps: terms.kbps, height: terms.height, held };
      try {
        const access = await session.voiceScreenAccess(channelId, { browser: true, sound: wantsSound }).catch((error) => {
          throw new ShareRefused((error as Error).message);
        });
        await current.whenAllowedToShare(true, access.sound);
        await current.startBrowserScreen({
          fps: terms.fps,
          bitrateKbps: terms.kbps,
          height: terms.height,
          sound: access.sound,
          soundKbps: terms.soundKbps,
          content: settings.screenContent,
          priority: settings.screenPriority,
          codec: settings.screenCodec,
          layers: settings.screenLayers,
        });
        set({ screen: asked });
        announce();
        sound("self-join");
      } catch (error) {
        if (error instanceof ShareRefused) {
          app.toast(error.message, "error");
          return;
        }
        void session.voiceScreenStop(channelId).catch(() => undefined);
        // Choosing not to share after all is not a failure.
        if ((error as Error).name !== "NotAllowedError") app.toast("Couldn't share your screen.", "error");
      }
    },

    async stopScreen() {
      await endShare(true);
    },

    setVolume(userId, volume) {
      const volumes = { ...get().volumes, [userId]: volume };
      saveVolumes(volumes);
      set({ volumes });
      applyVolumes();
    },

    setStreamVolume(userId, volume) {
      const streamVolumes = { ...get().streamVolumes, [userId]: volume };
      saveVolumes(streamVolumes, "stream");
      set({ streamVolumes });
      applyVolumes();
    },

    toggleLocalMute(userId) {
      const localMutes = { ...get().localMutes };
      if (localMutes[userId]) delete localMutes[userId];
      else localMutes[userId] = true;
      set({ localMutes });
      applyVolumes();
    },

    async playSound(soundId) {
      const { serverId, channelId } = get();
      const app = useApp.getState();
      const self = serverId ? app.servers[serverId]?.self : null;
      if (!serverId || !channelId || !self) return;
      try {
        // The server says first whether it may be played, and only then does it play here.
        await app.session(serverId).playSound(channelId, soundId);
      } catch (error) {
        app.toast((error as Error).message, "error");
        return;
      }
      await playHere(serverId, soundId, self.userId).catch((error) => console.warn("[zuna] playing a sound", error));
    },

    setFocus(focus) {
      set({ focus });
    },

    updateSettings(changes) {
      const settings = { ...get().settings, ...changes };
      saveVoiceSettings(settings);
      set({ settings });
      if (changes.outputDevice !== undefined) setSoundOutput(settings.outputDevice);
      void room?.applySettings(settings);
      applyVolumes();
    },

    setKeyHeld(down) {
      if (get().keyHeld === down || get().settings.inputMode !== "ptt" || get().status === "idle") return;
      set({ keyHeld: down });
      room?.setKeyHeld(down);
      if (get().settings.sounds && !get().muted && !get().deafened) playVoiceSound(down ? "ptt-down" : "ptt-up", 0.4);
    },

    async readStats(reader, nameOf) {
      if (!room) return [];
      return reader.read({ room: room.statsRoom(get().status), share: get().screen, micFilters: micFilters(get().settings), nameOf });
    },
  };
});

/** Whether this person is being heard from this device, for how they're drawn. */
export const selfIsSpeaking = (state: Pick<VoiceState, "open" | "muted" | "deafened" | "serverMuted" | "noMic">): boolean =>
  state.open && !state.muted && !state.deafened && !state.serverMuted && !state.noMic;
