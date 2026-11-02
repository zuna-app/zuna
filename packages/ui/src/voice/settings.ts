// How this device does voice. These stay on this device, since which microphone
// and how loud are about the room it's in.

import type { Role, ScreenRules } from "@zuna/core";

export type NoiseSuppression = "zuna" | "standard" | "off";
/** What a share is mostly of, which encoders tune themselves for. */
export type ScreenContent = "detail" | "text" | "motion";
/** What gives first when the network can't keep up. */
export type ScreenPriority = "sharp" | "smooth" | "balanced";
// LiveKit has no end-to-end encryption for AV1, so a share in it would show nothing.
export type ScreenCodec = "auto" | "h264" | "vp8" | "vp9";
export type ScreenEncoder = "auto" | "h264_nvenc" | "h264_amf" | "h264_vaapi";
/** How much work a native share's encoder puts into each frame. */
export type ScreenEffort = "speed" | "balanced" | "best";

export interface VoiceSettings {
  inputDevice: string;
  outputDevice: string;
  cameraDevice: string;
  /** How loud the microphone is, from 0 to 2. */
  inputVolume: number;
  /** How loud everyone is, from 0 to 2. */
  outputVolume: number;
  /** "voice" sends whenever someone speaks, "ptt" while a key is held. */
  inputMode: "voice" | "ptt";
  /** Works out for itself what's speech, or goes by the level below. */
  autoSensitivity: boolean;
  /** Sounds louder than this go through, in dB. */
  sensitivity: number;
  /** What's held for push to talk, as `KeyboardEvent.code`. */
  pttKey: string;
  /** How long sound keeps going after it's let go, in ms. */
  pttRelease: number;
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  autoGain: boolean;
  /** Sounds for people coming and going, and for muting. */
  sounds: boolean;
  /** Whether to come in muted. */
  startMuted: boolean;
  /** A share's frame rate, or null for what the server suggests. */
  screenFps: number | null;
  /** Most a share may send, in kbit/s, or null for what the server suggests. */
  screenBitrate: number | null;
  /** The tallest a share's picture may be, 0 for the screen's own size, or null for what the server suggests. */
  screenHeight: number | null;
  screenContent: ScreenContent;
  screenPriority: ScreenPriority;
  /** The pointer shows in a native share. A browser always shows it. */
  screenCursor: boolean;
  /** Sharing starts with the computer's sound on. */
  screenSound: boolean;
  /** The one app whose sound was shared last, or null for everything but Zuna, where the platform can tell them apart. */
  screenSoundApp: { id: string; name: string } | null;
  /** Most a share's sound may send, in kbit/s. */
  screenSoundKbps: number;
  /** A whole screen is captured and encoded natively, where this build can. */
  screenNative: boolean;
  screenEncoder: ScreenEncoder;
  screenEffort: ScreenEffort;
  /** Seconds between a native share's regular keyframes. */
  screenKeyframes: number;
  /** What a share through the browser is encoded with. */
  screenCodec: ScreenCodec;
  /** A share through the browser also sends a smaller copy, for those on a slow connection. */
  screenLayers: boolean;
  /** How loud others' shares are, from 0 to 2. */
  screenVolume: number;
  /** A screen someone starts sharing fills the stage. */
  screenFocus: boolean;
}

const KEY = "zuna-voice-settings";
const VOLUMES_KEY = "zuna-voice-volumes";

export const VOICE_DEFAULTS: VoiceSettings = {
  inputDevice: "default",
  outputDevice: "default",
  cameraDevice: "default",
  inputVolume: 1,
  outputVolume: 1,
  inputMode: "voice",
  autoSensitivity: true,
  sensitivity: -50,
  pttKey: "",
  pttRelease: 20,
  noiseSuppression: "zuna",
  echoCancellation: true,
  autoGain: true,
  sounds: true,
  startMuted: false,
  screenFps: null,
  screenBitrate: null,
  screenHeight: null,
  screenContent: "detail",
  screenPriority: "sharp",
  screenCursor: true,
  screenSound: false,
  screenSoundApp: null,
  screenSoundKbps: 128,
  screenNative: true,
  screenEncoder: "auto",
  screenEffort: "balanced",
  screenKeyframes: 10,
  screenCodec: "auto",
  screenLayers: false,
  screenVolume: 1,
  screenFocus: true,
};

export const SCREEN_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
export const SCREEN_RATES = [5, 10, 15, 24, 30, 45, 60, 75, 90, 120, 144, 165, 240];
export const SCREEN_BITRATES = [1_000, 2_000, 3_000, 4_500, 6_000, 8_000, 10_000, 12_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000, 60_000, 80_000, 100_000];
export const SCREEN_SOUND_BITRATES = [64, 96, 128, 160, 192, 256, 320];

export const heightName = (height: number): string => (height === 0 ? "The screen's own" : height === 2160 ? "4K (2160p)" : `${height}p`);
export const rateName = (fps: number): string => `${fps} fps`;
export const bitrateName = (kbps: number): string => (kbps >= 1000 ? `${kbps / 1000} Mbit/s` : `${kbps} kbit/s`);

/** What a server holds someone's shares to, in words, or null if it doesn't. */
export function screenLimitsText(rules: ScreenRules | undefined, role: Role | undefined): string | null {
  if (!rules || (rules.admins_exempt && (role === "owner" || role === "admin"))) return null;
  const limits = [
    rules.max_height > 0 && heightName(rules.max_height),
    rules.max_fps > 0 && rateName(rules.max_fps),
    rules.max_kbps > 0 && bitrateName(rules.max_kbps),
    rules.max_sound_kbps > 0 && `${bitrateName(rules.max_sound_kbps)} of sound`,
  ].filter(Boolean);
  return limits.length ? `This server holds shares to ${limits.join(", ")}.` : null;
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    // Before a server could suggest these, they were saved whether anyone had chosen them or not.
    if (!("screenHeight" in saved)) {
      delete saved.screenFps;
      delete saved.screenBitrate;
    }
    return { ...VOICE_DEFAULTS, ...saved };
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // They just won't persist.
  }
}

/** How loud each person is for this device, from 0 to 2, by user. */
export function loadVolumes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOLUMES_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveVolumes(volumes: Record<string, number>): void {
  try {
    localStorage.setItem(VOLUMES_KEY, JSON.stringify(volumes));
  } catch {
    // They just won't persist.
  }
}

/** What a key is called, from its `KeyboardEvent.code`. */
export function keyName(code: string): string {
  if (!code) return "Not set";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Numpad ${code.slice(6)}`;
  if (code.startsWith("Mouse")) return `Mouse ${code.slice(5)}`;
  const names: Record<string, string> = {
    ControlLeft: "Left Ctrl",
    ControlRight: "Right Ctrl",
    ShiftLeft: "Left Shift",
    ShiftRight: "Right Shift",
    AltLeft: "Left Alt",
    AltRight: "Right Alt",
    MetaLeft: "Left Meta",
    MetaRight: "Right Meta",
    Backquote: "`",
    CapsLock: "Caps Lock",
    Space: "Space",
  };
  return names[code] ?? code;
}
