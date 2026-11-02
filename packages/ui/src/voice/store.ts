// The voice channel this device is in, wherever in the app the person is looking.
// There's one at a time, across all servers, as in Discord.

import { screenTerms, voiceSenderKey } from "@zuna/core/voice";
import { Track } from "livekit-client";
import { create } from "zustand";
import { platform } from "@/platform";
import { useApp } from "@/state/store";
import { voiceHooks } from "./events";
import type { MicReading } from "./mic";
import { DisconnectReason, VoiceRoom, type RoomQuality, type VideoTile } from "./room";
import { bitrateName, heightName, loadVoiceSettings, loadVolumes, rateName, saveVoiceSettings, saveVolumes, type VoiceSettings } from "./settings";
import { playVoiceSound, setSoundOutput, type VoiceSound } from "./sounds";
import { addNativeReading, NO_NATIVE_READINGS, type StatSection, type StatsShare, type StreamStats } from "./stats";

export type VoiceStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface ScreenChoice {
  /** What to share, from the platform's list, or nothing for the browser's own picker. */
  source?: string;
  /** It can be captured and encoded natively rather than by the browser. */
  native: boolean;
  /** System audio goes too, where the system allows it. */
  audio: boolean;
  /** Whose sound, where the platform captures it: one app's by its id, or everything but Zuna. */
  soundApp?: string | null;
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

/** The server said no to a share, in words meant for the person. */
class ShareRefused extends Error {}

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
let stopSound: (() => void) | null = null;
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
      if (source === Track.Source.ScreenShareAudio) return settings.outputVolume * settings.screenVolume;
      return localMutes[userId] ? 0 : settings.outputVolume * (volumes[userId] ?? 1);
    });
  };

  const syncVideos = () => {
    if (!room) return;
    const videos = room.videos();
    const { focus, screen, videos: before, settings } = get();
    const stillThere = !focus || videos.some((video) => video.key === focus);
    // A screen someone starts sharing is what everyone's there to see, unless they're already looking at something.
    const arrived = settings.screenFocus ? videos.find((video) => video.source === "screen" && !video.local && !before.some((other) => other.key === video.key)) : undefined;
    set({ videos, focus: stillThere && focus ? focus : (arrived?.key ?? null), camera: room.cameraOn });
    if (screen && !screen.native && !room.sharingInBrowser) void endShare(true);
  };

  /** Stops what this device is sharing, if anything. A server that stopped it has already given up its place. */
  const endShare = async (giveUpPlace: boolean) => {
    const { screen, channelId } = get();
    if (!screen) return;
    set({ screen: null });
    if (screen.native) stopNative?.();
    else await room?.stopBrowserScreen();
    stopSound?.();
    await room?.stopSystemAudio();
    if (giveUpPlace && channelId) await session()?.voiceScreenStop(channelId).catch((error) => console.warn("[zuna] giving up a place to share", error));
    announce();
    sound("self-leave");
  };

  /** Whether a share's sound comes from the platform rather than the browser: one app's, or everything where the browser can't. */
  const soundIsNative = (app: string | null) => !!platform.shareSound && (!!app || platform.shareSound.everything);

  /**
   * Sends the computer's sound beside a share that has none of its own: from the platform,
   * which can take one app's, or else from the browser. A share without its sound is still
   * worth having, so this only says so.
   */
  const startShareSound = async (current: VoiceRoom, kbps: number, app: string | null) => {
    const native = platform.shareSound;
    try {
      if (!native || !soundIsNative(app)) {
        await current.startSystemAudio(kbps);
        return;
      }
      const samples = await native.start(app);
      if (!get().screen) {
        native.stop();
        return;
      }
      const off = native.onEnded((problem) => {
        off();
        stopSound = null;
        void current.stopSystemAudio();
        if (problem) useApp.getState().toast(`Your screen's sound stopped: ${problem}`, "error");
      });
      stopSound = () => {
        off();
        stopSound = null;
        native.stop();
      };
      await current.startSystemAudio(kbps, samples);
      // The share may have stopped meanwhile.
      if (!get().screen) {
        stopSound?.();
        await current.stopSystemAudio();
      }
    } catch (error) {
      console.warn("[zuna] sharing the computer's sound", error);
      stopSound?.();
      useApp.getState().toast("Your screen is being shared without its sound.", "info");
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
    stopSound?.();
    room?.close();
    room = null;
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
  voiceHooks.onScreenEnded = (serverId, channelId, reason) => {
    if (get().serverId !== serverId || get().channelId !== channelId || !get().screen) return;
    void endShare(false);
    useApp.getState().toast(reason === "stopped" ? "An admin stopped your screen share." : "This server's rules changed, so your screen share stopped.", "info");
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
      const { channelId, serverId, settings } = get();
      if (!current || !channelId || !serverId || get().screen) return;
      const server = app.servers[serverId];
      const session = app.session(serverId);
      const terms = screenTerms({ height: settings.screenHeight, fps: settings.screenFps, kbps: settings.screenBitrate, soundKbps: settings.screenSoundKbps }, server?.info?.screen_share, server?.self?.role);
      const wantsSound = choice.audio && terms.sound;
      const held = terms.held.map((name) => ({ height: heightName(terms.height), fps: rateName(terms.fps), kbps: bitrateName(terms.kbps), soundKbps: `${bitrateName(terms.soundKbps)} of sound` })[name]);
      const asked = { name: choice.name ?? "Your screen", fps: terms.fps, bitrateKbps: terms.kbps, height: terms.height, held };
      const askServer = (browser: boolean) =>
        session.voiceScreenAccess(channelId, { browser, sound: wantsSound }).catch((error) => {
          throw new ShareRefused((error as Error).message);
        });
      const browserShare = async (whyNotNative: string | null) => {
        const access = await askServer(true);
        // Sound the platform captures goes beside the browser's picture, not in it.
        const browserSound = access.sound && !soundIsNative(choice.soundApp ?? null);
        await current.whenAllowedToShare(true, access.sound);
        if (choice.source) await platform.chooseDisplaySource?.(choice.source, browserSound);
        await current.startBrowserScreen({
          fps: terms.fps,
          bitrateKbps: terms.kbps,
          height: terms.height,
          sound: browserSound,
          soundKbps: terms.soundKbps,
          content: settings.screenContent,
          priority: settings.screenPriority,
          codec: settings.screenCodec,
          layers: settings.screenLayers,
        });
        set({ screen: { ...asked, native: false, whyNotNative } });
        if (access.sound && !browserSound) await startShareSound(current, terms.soundKbps, choice.soundApp ?? null);
      };
      try {
        if (choice.native && settings.screenNative && platform.nativeScreen && current.currentKey) {
          const access = await askServer(false);
          const { key, index } = current.currentKey;
          const senderKey = new Uint8Array(await voiceSenderKey(key, access.native!.identity));
          try {
            const native = platform.nativeScreen;
            const info = await native.start({
              url: access.native!.url,
              token: access.native!.token,
              key: senderKey,
              keyIndex: index,
              fps: terms.fps,
              bitrateKbps: terms.kbps,
              height: terms.height,
              cursor: settings.screenCursor,
              encoder: settings.screenEncoder,
              effort: settings.screenEffort,
              keyframeSeconds: settings.screenKeyframes,
              source: choice.source ?? "",
            });
            nativeReadings = NO_NATIVE_READINGS;
            const offStats = native.onStats((stats) => {
              nativeReadings = addNativeReading(nativeReadings, stats);
            });
            set({ screen: { ...asked, native: true, info } });
            if (access.sound) {
              await current.whenAllowedToShare(false, true);
              if (choice.source && !soundIsNative(choice.soundApp ?? null)) await platform.chooseDisplaySource?.(choice.source, true);
              await startShareSound(current, terms.soundKbps, choice.soundApp ?? null);
            }
            const off = native.onEnded((problem) => {
              off();
              offStats();
              stopNative = null;
              if (get().screen?.native) {
                void endShare(true);
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
          const whyNot = !platform.nativeScreen ? null : !screen ? "Only whole screens are captured natively." : !settings.screenNative ? "Capturing on the graphics card is turned off in Screen sharing's settings." : "This build came without native capture.";
          await browserShare(whyNot);
        }
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
