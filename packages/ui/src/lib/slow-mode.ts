// A channel's slow mode, as Discord's: how long each person waits between messages,
// and how long until you may send again.

import type { ConversationView } from "@zuna/core";
import { useEffect, useState } from "react";

const secondsLeft = (until: number): number => Math.max(0, Math.ceil((until - Date.now()) / 1000));

/**
 * How many seconds until slow mode lets you send here again, counting down, or 0 once
 * it does. `sentUntil` is when a message sent from here a moment ago lets the next one
 * go, before the core has said so.
 */
export function useSlowWait(conversation: ConversationView, sentUntil = 0): number {
  const until = conversation.slowMode > 0 ? Math.max(conversation.slowUntil, sentUntil) : 0;
  const [seconds, setSeconds] = useState(() => secondsLeft(until));
  useEffect(() => {
    setSeconds(secondsLeft(until));
    if (until <= Date.now()) return;
    const timer = setInterval(() => {
      const left = secondsLeft(until);
      setSeconds(left);
      if (left === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [until]);
  return seconds;
}

/** A wait as a clock shows it: "0:24", "4:59" or "1:59:59". */
export function waitText(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
