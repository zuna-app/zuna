// How this device does voice. These stay on this device, since which microphone
// and how loud are about the room it's in.

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
  screenFps: 30 | 60;
  /** Most a screen share may send, in kbit/s. */
  screenBitrate: number;
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
  screenFps: 60,
  screenBitrate: 20_000,
};

export function loadVoiceSettings(): VoiceSettings {
  try {
    return { ...VOICE_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
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
