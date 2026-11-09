// "last seen 5 min ago", kept true as the minutes pass.

import { useEffect, useState } from "react";
import { formatLastSeen } from "./format";

/** How long until formatLastSeen's words can next change: at the turn of a minute since `at`, so never more than one. */
const lastSeenChangesIn =(at: number, now = Date.now()): number => 60_000 - (Math.max(0, now - at) % 60_000) + 50;

/** When someone was last seen, worded again each time the words change, so "just now" turns into "1 min ago" with nothing else happening. */
export function LastSeen({ at, hidden }: { at: number | null; hidden: boolean }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (hidden || at === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => {
      timer = setTimeout(() => {
        redraw((count) => count + 1);
        wait();
      }, lastSeenChangesIn(at));
    };
    wait();
    return () => clearTimeout(timer);
  }, [at, hidden]);
  return <>{formatLastSeen(at, hidden)}</>;
}
