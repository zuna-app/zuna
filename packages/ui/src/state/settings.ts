// Per-device appearance and notification settings.

import { keepKnown, readSaved } from "@/lib/saved";

export interface AppSettings {
  accent: "neutral" | "blue" | "green" | "red" | "amber";
  messageSize: "small" | "medium" | "large";
  notifications: boolean;
  notificationSound: boolean;
  notificationPreview: "full" | "sender" | "none";
  reduceMotion: boolean;
  enterToSend: boolean;
  /** This device fetches a page to preview the first link in a message being written. */
  linkPreviews: boolean;
  /** Before a file is sent, this device takes out where, when and on what it was made. */
  removeMetadata: boolean;
  /** How fast voice messages play, the same for all of them, as in Telegram. */
  voiceSpeed: VoiceSpeed;
}

export const VOICE_SPEEDS = [1, 1.5, 2] as const;
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number];

const KEY = "zuna-settings";

const DEFAULTS: AppSettings = {
  accent: "neutral",
  messageSize: "medium",
  notifications: true,
  notificationSound: true,
  notificationPreview: "full",
  reduceMotion: false,
  enterToSend: true,
  linkPreviews: true,
  removeMetadata: true,
  voiceSpeed: 1,
};

export function loadSettings(): AppSettings {
  return keepKnown(DEFAULTS, readSaved(KEY), {
    accent: ["neutral", "blue", "green", "red", "amber"],
    messageSize: ["small", "medium", "large"],
    notificationPreview: ["full", "sender", "none"],
    voiceSpeed: VOICE_SPEEDS,
  });
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Settings just won't persist.
  }
}

export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;
  root.dataset.accent = settings.accent;
  root.dataset.size = settings.messageSize;
  root.dataset.motion = settings.reduceMotion ? "reduced" : "full";
}
