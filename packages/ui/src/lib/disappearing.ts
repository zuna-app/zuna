// How long a chat's messages last before they disappear, as in Telegram: off,
// or an hour to a month.

import { DISAPPEARING_TIMES } from "@zuna/core";
import type { MenuEntry } from "@/components/ui";

const UNITS: [seconds: number, name: string][] = [
  [30 * 86400, "month"],
  [7 * 86400, "week"],
  [86400, "day"],
  [3600, "hour"],
  [60, "minute"],
  [1, "second"],
];

/** "1 day", "2 weeks", or "Off" for 0. */
export function timerText(seconds: number): string {
  if (seconds <= 0) return "Off";
  const [size, name] = UNITS.find(([size]) => seconds % size === 0)!;
  const count = seconds / size;
  return `${count} ${name}${count === 1 ? "" : "s"}`;
}

/** What a chat's line says when someone changes how long its messages last. */
export function timerChangeText(who: string, seconds: number): string {
  return seconds > 0 ? `${who} set messages to disappear after ${timerText(seconds)}` : `${who} turned off disappearing messages`;
}

/** The choices of how long messages last, the current one marked. */
export function timerEntries(current: number, set: (seconds: number) => void): MenuEntry[] {
  return [0, ...DISAPPEARING_TIMES].map((seconds) => ({
    label: `${seconds === current ? "✓ " : ""}${seconds === 0 ? "Off" : timerText(seconds)}`,
    onSelect: () => set(seconds),
  }));
}
