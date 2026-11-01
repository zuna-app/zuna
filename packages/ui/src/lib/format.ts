import { platform } from "@/platform";

// Times follow the system's clock, 12 or 24 hours, rather than the interface's language.
// The host says which when the app starts, so the two formats that care are made on first use.
let clockFormats: { time: Intl.DateTimeFormat; full: Intl.DateTimeFormat } | undefined;
const clock = () =>
  (clockFormats ??= {
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: platform?.hour12 }),
    full: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", hour12: platform?.hour12 }),
  });

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullDayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const fullDayYearFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

export const formatTime = (at: number) => clock().time.format(at);
export const formatFull = (at: number) => clock().full.format(at);

const startOfDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** The compact time shown in the conversation list. */
export function formatListTime(at: number): string {
  if (!at) return "";
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return formatTime(at);
  if (days < 7) return weekdayFormat.format(at);
  return dayFormat.format(at);
}

export function formatDaySeparator(at: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (new Date(at).getFullYear() === new Date().getFullYear()) return fullDayFormat.format(at);
  return fullDayYearFormat.format(at);
}

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

/** A moment still to come, with its date unless it's today. */
export function formatUpcoming(at: number): string {
  return sameDay(at, Date.now()) ? formatTime(at) : `${dayFormat.format(at)}, ${formatTime(at)}`;
}

export function formatLastSeen(at: number | null, hidden: boolean): string {
  if (hidden || at === null) return "last seen recently";
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "last seen just now";
  if (minutes < 60) return `last seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  if (days === 1) return `last seen yesterday at ${formatTime(at)}`;
  return `last seen ${dayFormat.format(at)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = [...parts[0]!][0] ?? "";
  const second = parts.length > 1 ? ([...parts[parts.length - 1]!][0] ?? "") : "";
  return (first + second).toUpperCase();
}

// Muted, flat tones. Enough to tell people apart without coloring the interface.
const AVATAR_COLORS = ["#5b6b7a", "#6e625c", "#5f7065", "#7a6c58", "#6b6470", "#557072", "#7a6060", "#5f6775"];
const NAME_COLORS = ["#a9b7c4", "#c4b4ac", "#a8bdac", "#c9b89a", "#b8b0b9", "#a2bcbe", "#c9abab", "#aab2c4"];

function colorIndex(seed: string, count: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % count;
}

export const avatarColor = (seed: string): string => AVATAR_COLORS[colorIndex(seed, AVATAR_COLORS.length)]!;

/** A stable color for someone's name in group chats. */
export const nameColor = (seed: string): string => NAME_COLORS[colorIndex(seed, NAME_COLORS.length)]!;

/** The shortest password allowed when signing up or changing it. */
export const MIN_PASSWORD = 8;

/** Rates a password from 0 to 4 by estimating how hard it is to guess. */
export function passwordStrength(password: string): { score: number; label: string } {
  if (!password) return { score: 0, label: "" };
  let alphabet = 0;
  if (/[a-z]/.test(password)) alphabet += 26;
  if (/[A-Z]/.test(password)) alphabet += 26;
  if (/[0-9]/.test(password)) alphabet += 10;
  if (/[^a-zA-Z0-9]/.test(password)) alphabet += 20;
  let bits = password.length * Math.log2(Math.max(alphabet, 2));
  if (/^(.)\1+$/.test(password)) bits = 4;
  if (/(password|qwerty|123456|letmein|admin|welcome|zuna)/i.test(password)) bits -= 24;
  if (/^[a-z]+\d{0,4}$/i.test(password)) bits *= 0.65;
  if (bits < 28) return { score: 1, label: "Too easy to guess" };
  if (bits < 42) return { score: 2, label: "Could be stronger" };
  if (bits < 60) return { score: 3, label: "Good" };
  return { score: 4, label: "Strong" };
}
