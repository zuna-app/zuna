// Muting a chat for a while or until it's unmuted, as in Telegram.

import type { MenuEntry } from "@/components/ui";
import { formatUpcoming } from "./format";
import { mark, t } from "@/lib/i18n";

const HOUR = 3_600_000;

export const MUTE_FOR = [
  { label: mark("conversations.mute.hour"), ms: HOUR },
  { label: mark("conversations.mute.eightHours"), ms: 8 * HOUR },
  { label: mark("conversations.mute.day"), ms: 24 * HOUR },
];

/** The choices of how long to mute, each calling `mute` with when it ends, or nothing for until it's unmuted. */
export function muteEntries(mute: (until?: number) => void): MenuEntry[] {
  return [
    ...MUTE_FOR.map((option) => ({ label: t(option.label), onSelect: () => mute(Date.now() + option.ms) })),
    { label: t("conversations.mute.untilUnmuted"), onSelect: () => mute() },
  ];
}

export const mutedUntilText = (until: number) => t("conversations.mute.mutedUntil", { time: formatUpcoming(until) });
