// "last seen 5 minutes ago", kept true as time passes, as Telegram's desktop app keeps it.

import { useEffect, useState } from "react";
import { formatLastSeen, lastSeenChangesIn } from "./format";

/**
 * When someone was last seen, worded again each time the words change (lastSeenChangesIn),
 * so "just now" turns into "1 minute ago" with nothing else happening. `full` words it as
 * their details do, with the time.
 */
export function LastSeen({ at, hidden, full = false }: { at: number | null; hidden: boolean; full?: boolean }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (hidden || at === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const wait = () => {
      timer = setTimeout(() => {
        redraw((count) => count + 1);
        wait();
      }, lastSeenChangesIn(at) + 50);
    };
    wait();
    return () => clearTimeout(timer);
  }, [at, hidden]);
  return <>{formatLastSeen(at, hidden, full)}</>;
}
