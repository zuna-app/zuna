// Muting a chat for a while or until it's unmuted, as in Telegram.

import type { MenuEntry } from "@/components/ui";
import { formatUpcoming } from "./format";

const HOUR = 3_600_000;

export const MUTE_FOR = [
  { label: "For 1 hour", ms: HOUR },
  { label: "For 8 hours", ms: 8 * HOUR },
  { label: "For 1 day", ms: 24 * HOUR },
];

/** The choices of how long to mute, each calling `mute` with when it ends, or nothing for until it's unmuted. */
export function muteEntries(mute: (until?: number) => void): MenuEntry[] {
  return [
    ...MUTE_FOR.map((option) => ({ label: option.label, onSelect: () => mute(Date.now() + option.ms) })),
    { label: "Until I turn it back on", onSelect: () => mute() },
  ];
}

export const mutedUntilText = (until: number) => `Muted until ${formatUpcoming(until)}`;
