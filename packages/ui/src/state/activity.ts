// Whether the person is using this computer, much as Telegram Desktop counts it:
// Zuna's window has focus and there was input in the last 5 s. Leaving the
// window counts 5 s later, and locking the screen at once. While they're here,
// and for a while after, their other devices hold notifications back, and
// don't show them if they read the chat here (notificationDelay in the core).

import { platform } from "@/platform";
import { useApp } from "./store";

/** Shorter than Telegram's offline_idle_timeout_ms, 30 s. */
const IDLE_AFTER_MS = 5_000;
/** Telegram's offline_blur_timeout_ms. */
const BLUR_AFTER_MS = 5_000;
const CHECK_EVERY_MS = 5_000;

/** Keeps the core told, until the returned function stops it. */
export function watchActivity(): () => void {
  let current: boolean | null = null;
  let lastInput = Date.now();
  let inFront = useApp.getState().windowFocused;
  let locked = false;
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;

  const report = (active: boolean) => {
    const { core } = useApp.getState();
    if (!core || active === current) return;
    current = active;
    void core.client.setActive(active);
  };

  const check = async () => {
    if (checking) return;
    if (!inFront || locked) return report(false);
    checking = true;
    try {
      // Input anywhere on the computer counts where the host can tell, as Telegram's does.
      const here = platform.idleState
        ? (await platform.idleState(IDLE_AFTER_MS / 1000)) === "active"
        : Date.now() - lastInput < IDLE_AFTER_MS;
      report(here && inFront && !locked);
    } finally {
      checking = false;
    }
  };

  const onInput = () => {
    lastInput = Date.now();
    if (current !== true) void check();
  };
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  const removePresence = platform.onPresence?.((state) => {
    locked = state === "away";
    void check();
  });
  const unsubscribe = useApp.subscribe((state, previous) => {
    // A new core hasn't been told anything yet.
    if (state.core !== previous.core) {
      current = null;
      void check();
    }
    if (state.windowFocused === previous.windowFocused) return;
    clearTimeout(blurTimer);
    if (state.windowFocused) {
      inFront = true;
      lastInput = Date.now();
      void check();
    } else {
      blurTimer = setTimeout(() => {
        inFront = false;
        void check();
      }, BLUR_AFTER_MS);
    }
  });
  const inputs = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
  for (const event of inputs) window.addEventListener(event, onInput, { passive: true });
  void check();

  return () => {
    clearInterval(timer);
    clearTimeout(blurTimer);
    removePresence?.();
    unsubscribe();
    for (const event of inputs) window.removeEventListener(event, onInput);
  };
}
