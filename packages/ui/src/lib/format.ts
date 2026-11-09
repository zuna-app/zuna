// Times follow the browser's language, 12 or 24 hours, as it can't see the system's clock.
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullDayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const fullDayYearFormat = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" });

export const formatTime = (at: number) => timeFormat.format(at);
export const formatFull = (at: number) => fullFormat.format(at);

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

const shortDateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });

/** A day in full, as between days in a channel. */
export const formatDate = (at: number) => fullDayYearFormat.format(at);

/** When a message was sent, as beside a name in a channel: "Today at 14:32", or the date. */
export function formatStamp(at: number): string {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `Today at ${formatTime(at)}`;
  if (days === 1) return `Yesterday at ${formatTime(at)}`;
  return `${shortDateFormat.format(at)} ${formatTime(at)}`;
}

/** A moment still to come, with its date unless it's today. */
export function formatUpcoming(at: number): string {
  return sameDay(at, Date.now()) ? formatTime(at) : `${dayFormat.format(at)}, ${formatTime(at)}`;
}

const shortDayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

/**
 * When someone was last seen, worded as Telegram's desktop app words it: in a chat's header
 * (Data::OnlineText) the minutes, or the hours under 12, and in their details (`full`,
 * Data::OnlineTextFull) the time. Someone hiding it was seen "recently", and someone never
 * seen "a long time ago".
 */
export function formatLastSeen(at: number | null, hidden: boolean, full = false, now = Date.now()): string {
  if (hidden) return "last seen recently";
  if (at === null) return "last seen a long time ago";
  if (!full) {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    if (minutes === 0) return "last seen just now";
    if (minutes < 60) return `last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 12) return `last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return `last seen today at ${formatTime(at)}`;
  if (days === 1) return `last seen yesterday at ${formatTime(at)}`;
  return full ? `last seen ${shortDayFormat.format(at)} at ${formatTime(at)}` : `last seen ${shortDayFormat.format(at)}`;
}

/**
 * How long until formatLastSeen's words next change, as Telegram works it out
 * (OnlinePhraseChangeInSeconds): at the turn of a minute under an hour, of an hour
 * under 12, and at midnight after.
 */
export function lastSeenChangesIn(at: number, now = Date.now()): number {
  const since = Math.max(0, now - at);
  if (since < 3_600_000) return 60_000 - (since % 60_000);
  if (since < 12 * 3_600_000) return 3_600_000 - (since % 3_600_000);
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1_000, midnight.getTime() - now);
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

