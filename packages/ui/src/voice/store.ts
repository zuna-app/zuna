// The voice channel this device is in, wherever in the app the person is looking.
// There's one at a time, across all servers, as in Discord.

import { voiceSenderKey } from "@zuna/core/voice";
import { Track } from "livekit-client";
import { create } from "zustand";
import { platform } from "@/platform";
import { useApp } from "@/state/store";
import { voiceHooks } from "./events";
import type { MicReading } from "./mic";
import { DisconnectReason, VoiceRoom, type RoomQuality, type VideoTile } from "./room";
import { loadVoiceSettings, loadVolumes, saveVoiceSettings, saveVolumes, type VoiceSettings } from "./settings";
import { playVoiceSound, setSoundOutput, type VoiceSound } from "./sounds";
import { addNativeReading, NO_NATIVE_READINGS, type StatSection, type StatsShare, type StreamStats } from "./stats";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface ScreenChoice {
  /** What to share, from the platform's list, or nothing for the browser's own picker. */
  source?: string;
  /** Captured and encoded natively rather than by the browser. */
  native: boolean;
  fps: number;
  bitrateKbps: number;
  /** System audio goes too, where the system allows it. */
  audio: boolean;
  /** What it's called, to say what's being shared. */
  name?: string;
}

interface VoiceState {
  status: VoiceStatus;
  serverId: string | null;
  channelId: string | null;
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
  /** People muted for this device only. */
  localMutes: Record<string, true>;

  /** Comes into a voice channel. `returnTo` is what to open again on leaving, if it's said. */
  join(serverId: string, channelId: string, returnTo?: string | null): Promise<void>;
  leave(): void;
  toggleMute(): void;
  toggleDeafen(): void;
  toggleCamera(): Promise<void>;
  startScreen(choice: ScreenChoice): Promise<void>;
  stopScreen(): Promise<void>;
  setVolume(userId: string, volume: number): void;
  toggleLocalMute(userId: string): void;
  setFocus(key: string | null): void;
  updateSettings(changes: Partial<VoiceSettings>): void;
  setKeyHeld(down: boolean): void;
  /** What's going out and coming in right now, for the stream stats window. */
  readStats(reader: StreamStats, nameOf: (userId: string) => string): Promise<StatSection[]>;
}

const NOT_IN_VOICE = {
  status: "idle" as VoiceStatus,
  serverId: null,
  channelId: null,
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
};

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_WAIT_MS = 2000;

/** Why a native share didn't start, without what Electron and the app wrap around it. */
const nativeProblem = (error: unknown): string =>
  String((error as Error)?.message ?? error)
    .replace(/^Error invoking remote method '[^']*': (Error: )?/, "")
    .replace(/^Your screen share stopped: /, "");

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
let nativeReadings = NO_NATIVE_READINGS;
/** Each join counts, so one that takes a while can tell it's been replaced. */
let attempt = 0;
let reconnects = 0;
let stopNative: (() => void) | null = null;
/** What was open before coming into a voice channel. */
let openBefore: string | null = null;

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

  /** Tells everyone on the server what this device is doing. */
  const announce = () => {
    const { channelId, muted, deafened, camera, screen, noMic, serverMuted } = get();
    if (channelId) void session()?.setVoiceState(channelId, { muted: muted || noMic || serverMuted, deafened, camera, screen: !!screen });
  };

  const applyVolumes = () => {
    room?.setVolumes((userId, source) => {
      const { deafened, settings, volumes, localMutes } = get();
      if (deafened) return 0;
      // A share's sound has a level of its own: it isn't how loud the person talks.
      if (source === Track.Source.ScreenShareAudio) return settings.outputVolume;
      return localMutes[userId] ? 0 : settings.outputVolume * (volumes[userId] ?? 1);
    });
  };

  const syncVideos = () => {
    if (!room) return;
    const videos = room.videos();
    const { focus, screen, videos: before } = get();
    const stillThere = !focus || videos.some((video) => video.key === focus);
    // A screen someone starts sharing is what everyone's there to see, unless they're already looking at something.
    const arrived = videos.find((video) => video.source === "screen" && !video.local && !before.some((other) => other.key === video.key));
    set({ videos, focus: stillThere && focus ? focus : (arrived?.key ?? null), camera: room.cameraOn });
    if (screen && !screen.native && !room.sharingInBrowser) {
      set({ screen: null });
      sound("self-leave");
      announce();
    }
  };

  /** There's nothing to show for a voice channel once out of it, so whatever was open before comes back. */
  const closeStage = (serverId: string | null, channelId: string | null) => {
    const returnTo = openBefore;
    openBefore = null;
    if (!serverId || !channelId) return;
    useApp.setState((state) => {
      const server = state.servers[serverId];
      if (server?.activeKey !== `group:${channelId}`) return state;
      return { servers: { ...state.servers, [serverId]: { ...server, activeKey: returnTo } }, panel: null };
    });
  };

  const closeRoom = () => {
    stopNative?.();
    room?.close();
    room = null;
  };

  /** What to do when the room goes away without anyone asking: try coming back, as far as that's worth it. */
  const onClosed = (reason?: DisconnectReason) => {
    const { serverId, channelId } = get();
    closeRoom();
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

  const connect = async (serverId: string, channelId: string, mine: number) => {
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
        sendKey: (key, index) => {
          if (!get().screen?.native || !platform.nativeScreen) return;
          // The native process sends as a participant of its own, under a key of its own.
          const self = app.servers[serverId]?.self;
          if (!self) return;
          void voiceSenderKey(key, `${self.userId}.${self.deviceId}.screen`).then((sender) => platform.nativeScreen?.setKey(new Uint8Array(sender), index));
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
    useApp.getState().toast(message[reason] ?? "You left the voice channel.", "info");
    sound("self-leave");
  };
  voiceHooks.onServerGone = (serverId) => {
    if (get().serverId === serverId) get().leave();
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
    localMutes: {},

    async join(serverId, channelId, returnTo) {
      const { serverId: inServer, channelId: inChannel, status } = get();
      // Moving between voice channels keeps what was open before the first of them.
      const before = returnTo !== undefined ? returnTo : openBefore;
      openBefore = before;
      if (inServer === serverId && inChannel === channelId && status !== "idle") return;
      if (status !== "idle") get().leave();
      openBefore = before;
      const mine = ++attempt;
      reconnects = 0;
      set({ ...NOT_IN_VOICE, status: "connecting", serverId, channelId });
      await connect(serverId, channelId, mine);
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
      if (on && platform.camera && !(await platform.camera())) {
        useApp.getState().toast("Zuna can't use the camera. Allow it in your system's privacy settings.", "error");
        return;
      }
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
      const { channelId, serverId } = get();
      if (!current || !channelId || !serverId || get().screen) return;
      const asked = { name: choice.name ?? "Your screen", fps: choice.fps, bitrateKbps: choice.bitrateKbps };
      const browserShare = async (whyNotNative: string | null) => {
        if (choice.source) await platform.chooseDisplaySource?.(choice.source, choice.audio);
        await current.startBrowserScreen(choice.fps, choice.bitrateKbps, choice.audio);
        set({ screen: { ...asked, native: false, whyNotNative } });
      };
      try {
        if (choice.native && platform.nativeScreen && current.currentKey) {
          const access = await app.session(serverId).voiceScreenAccess(channelId);
          const { key, index } = current.currentKey;
          const senderKey = new Uint8Array(await voiceSenderKey(key, access.identity));
          try {
            const native = platform.nativeScreen;
            const info = await native.start({ url: access.url, token: access.token, key: senderKey, keyIndex: index, fps: choice.fps, bitrateKbps: choice.bitrateKbps, source: choice.source ?? "" });
            nativeReadings = NO_NATIVE_READINGS;
            const offStats = native.onStats((stats) => {
              nativeReadings = addNativeReading(nativeReadings, stats);
            });
            set({ screen: { ...asked, native: true, info } });
            if (choice.audio) {
              if (choice.source) await platform.chooseDisplaySource?.(choice.source, true);
              await current.startSystemAudio().catch((error) => {
                console.warn("[zuna] sharing the computer's sound", error);
                app.toast("Your screen is being shared without its sound.", "info");
              });
            }
            const off = native.onEnded((problem) => {
              off();
              offStats();
              stopNative = null;
              if (get().screen?.native) {
                void current.stopSystemAudio();
                set({ screen: null });
                announce();
                if (problem) app.toast(problem, "error");
              }
            });
            stopNative = () => {
              off();
              offStats();
              stopNative = null;
              native.stop();
            };
          } catch (error) {
            // Chromium can always do it, if not as well: sharing beats not sharing.
            console.warn("[zuna] the native screen share didn't start", error);
            await browserShare(nativeProblem(error));
            app.toast("Your graphics card couldn't take this share, so it's going through the browser. Stream stats says why.", "info");
          }
        } else {
          const screen = choice.source?.startsWith("screen:");
          await browserShare(platform.nativeScreen ? (screen ? "This build came without native capture." : "Only whole screens are captured natively.") : null);
        }
        announce();
        sound("self-join");
      } catch (error) {
        // Choosing not to share after all is not a failure.
        if ((error as Error).name !== "NotAllowedError") app.toast("Couldn't share your screen.", "error");
      }
    },

    async stopScreen() {
      const { screen } = get();
      if (!screen) return;
      if (screen.native) {
        stopNative?.();
        await room?.stopSystemAudio();
      } else {
        await room?.stopBrowserScreen();
      }
      set({ screen: null });
      announce();
      sound("self-leave");
    },

    setVolume(userId, volume) {
      const volumes = { ...get().volumes, [userId]: volume };
      saveVolumes(volumes);
      set({ volumes });
      applyVolumes();
    },

    toggleLocalMute(userId) {
      const localMutes = { ...get().localMutes };
      if (localMutes[userId]) delete localMutes[userId];
      else localMutes[userId] = true;
      set({ localMutes });
      applyVolumes();
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
      return reader.read({ room: room.statsRoom(get().status), share: get().screen, native: nativeReadings, micFilters: micFilters(get().settings), nameOf });
    },
  };
});

/** Whether this person is being heard from this device, for how they're drawn. */
export const selfIsSpeaking = (state: Pick<VoiceState, "open" | "muted" | "deafened" | "serverMuted" | "noMic">): boolean =>
  state.open && !state.muted && !state.deafened && !state.serverMuted && !state.noMic;
