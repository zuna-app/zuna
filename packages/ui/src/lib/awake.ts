// Keeping the screen on while there's something to watch on it, as a video player does.

import { useEffect } from "react";

/**
 * Keeps the screen from dimming or locking while `held`, where the browser lets a page ask.
 * A browser lets go of it as the tab is hidden, so it's asked for again as the tab comes back.
 */
export function useScreenAwake(held: boolean): void {
  useEffect(() => {
    if (!held || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let asking = false;
    let done = false;
    const take = () => {
      if (done || asking || document.visibilityState !== "visible" || (lock && !lock.released)) return;
      asking = true;
      navigator.wakeLock.request("screen").then(
        (taken) => {
          asking = false;
          if (done) void taken.release().catch(() => undefined);
          else lock = taken;
        },
        // Refused, as where the page isn't in front or the browser doesn't let it.
        () => (asking = false),
      );
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => undefined);
    };
  }, [held]);
}
