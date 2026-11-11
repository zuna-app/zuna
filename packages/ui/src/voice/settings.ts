// How this device does voice. These stay on this device, since which microphone
// and how loud are about the room it's in.

import type { Role, ScreenRules } from "@zuna/core";
import { SCREEN_DEFAULT_FPS } from "@zuna/core/voice";
import { keepKnown, readSaved } from "@/lib/saved";

export type NoiseSuppression = "zuna" | "standard" | "off";

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
  /** A share's frame rate. */
  screenFps: number;
  /** Most a share may send, in kbit/s, or null to leave it to the app. */
  screenBitrate: number | null;
  /** The tallest a share's picture may be, or 0 for the screen's own size. */
  screenHeight: number;
  /** A share starts with the sound the browser offers with it. */
  screenSoundByDefault: boolean;
  /** How loud others' shares are, from 0 to 2. */
  screenVolume: number;
  /** A screen someone starts sharing fills the stage. */
  screenFocus: boolean;
  /** How loud sounds from the soundboard are, from 0 to 1. At 0 none of them plays. */
  soundboardVolume: number;
  /** How loud a video watched together is, from 0 to 1, as YouTube's player remembers nothing. */
  watchVolume: number;
  watchMuted: boolean;
}

const KEY = "zuna-voice-settings";
const VOLUMES_KEY = "zuna-voice-volumes";
const STREAM_VOLUMES_KEY = "zuna-voice-stream-volumes";

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
  screenFps: SCREEN_DEFAULT_FPS,
  screenBitrate: null,
  screenHeight: 0,
  screenSoundByDefault: true,
  screenVolume: 1,
  screenFocus: true,
  soundboardVolume: 0.6,
  watchVolume: 0.8,
  watchMuted: false,
};

export const SCREEN_HEIGHTS = [2160, 1440, 1080, 720, 480];
export const SCREEN_RATES = [15, 30, 60, 90, 120, 144, 165, 240];
export const SCREEN_BITRATES = [2_000, 4_000, 6_000, 8_000, 12_000, 20_000, 30_000, 50_000];
/** What a server may hold shares to, which goes higher than anyone needs to choose. */
export const SCREEN_LIMIT_BITRATES = [...SCREEN_BITRATES, 100_000];

export const heightName = (height: number): string => (height === 0 ? "Native" : height === 2160 ? "4K" : `${height}p`);
export const rateName = (fps: number): string => `${fps} fps`;
export const bitrateName = (kbps: number): string => (kbps >= 1000 ? `${kbps / 1000} Mbps` : `${kbps} kbps`);

/** What a server holds someone's shares to, in words, or null if it doesn't. */
export function screenLimitsText(rules: ScreenRules | undefined, role: Role | undefined): string | null {
  if (!rules || (rules.admins_exempt && (role === "owner" || role === "admin"))) return null;
  const limits = [rules.max_height > 0 && heightName(rules.max_height), rules.max_fps > 0 && rateName(rules.max_fps), rules.max_kbps > 0 && bitrateName(rules.max_kbps)].filter(Boolean);
  return limits.length ? `This server limits screen shares to ${limits.join(", ")}.` : null;
}

export function loadVoiceSettings(): VoiceSettings {
  return keepKnown(VOICE_DEFAULTS, readSaved(KEY), {
    inputMode: ["voice", "ptt"],
    noiseSuppression: ["zuna", "standard", "off"],
  });
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // They just won't persist.
  }
}

/** How loud each person is for this device, from 0 to 2, by user: their voice, or their shared screen's sound. */
export function loadVolumes(kind: "voice" | "stream" = "voice"): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(kind === "voice" ? VOLUMES_KEY : STREAM_VOLUMES_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveVolumes(volumes: Record<string, number>, kind: "voice" | "stream" = "voice"): void {
  try {
    localStorage.setItem(kind === "voice" ? VOLUMES_KEY : STREAM_VOLUMES_KEY, JSON.stringify(volumes));
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
