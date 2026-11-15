// How long a chat's messages last before they disappear, as in Telegram: off,
// or an hour to a month.

import { DISAPPEARING_TIMES } from "@zuna/core";
import type { MenuEntry } from "@/components/ui";
import { mark, t, type MessageKey } from "@/lib/i18n";

const UNITS: [seconds: number, name: MessageKey][] = [
  [30 * 86400, mark("date.duration.months")],
  [7 * 86400, mark("date.duration.weeks")],
  [86400, mark("date.duration.days")],
  [3600, mark("date.duration.hours")],
  [60, mark("date.duration.minutes")],
  [1, mark("date.duration.seconds")],
];

/** "1 day", "2 weeks", or "Off" for 0. */
export function timerText(seconds: number): string {
  if (seconds <= 0) return t("common.off");
  const [size, name] = UNITS.find(([size]) => seconds % size === 0)!;
  const count = seconds / size;
  return t(name, { count });
}

/** What a chat's line says when someone changes how long its messages last, or `self` did. */
export function timerChangeText(who: string, seconds: number, self = false): string {
  if (self) return seconds > 0 ? t("message.system.youSetTimer", { time: timerText(seconds) }) : t("message.system.youTurnedOffTimer");
  return seconds > 0 ? t("message.system.timerSet", { name: who, time: timerText(seconds) }) : t("message.system.timerOff", { name: who });
}

/** The choices of how long messages last, the current one marked. */
export function timerEntries(current: number, set: (seconds: number) => void): MenuEntry[] {
  return [0, ...DISAPPEARING_TIMES].map((seconds) => ({
    label: `${seconds === current ? "✓ " : ""}${timerText(seconds)}`,
    onSelect: () => set(seconds),
  }));
}
