// Per-device appearance and notification settings.

export interface AppSettings {
  accent: "neutral" | "blue" | "green" | "red" | "amber";
  messageSize: "small" | "medium" | "large";
  notifications: boolean;
  notificationSound: boolean;
  notificationPreview: "full" | "sender" | "none";
  closeToTray: boolean;
  reduceMotion: boolean;
  enterToSend: boolean;
}

const KEY = "zuna-settings";

const DEFAULTS: AppSettings = {
  accent: "neutral",
  messageSize: "medium",
  notifications: true,
  notificationSound: true,
  notificationPreview: "full",
  closeToTray: true,
  reduceMotion: false,
  enterToSend: true,
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
