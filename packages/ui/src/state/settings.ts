// Per-device appearance and notification settings.

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
}

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
};

const ACCENTS: AppSettings["accent"][] = ["neutral", "blue", "green", "red", "amber"];

export function loadSettings(): AppSettings {
  try {
    const stored = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    return ACCENTS.includes(stored.accent) ? stored : { ...stored, accent: DEFAULTS.accent };
  } catch {
    return DEFAULTS;
  }
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
