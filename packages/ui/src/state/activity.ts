// Whether the person is using this computer, much as Telegram Desktop counts it:
// Zuna's window has focus and there was input in the last 5 s. Leaving the
// window counts 5 s later. While they're here,
// and for a while after, their other devices hold notifications back, and
// don't show them if they read the chat here (notificationDelay in the core).
// So a chat on screen is read only while they're here (personHere), and once
// they're back: one read in a window left in front with nobody at it would
// take back the notification their phone is waiting to show.

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
  let blurTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (active: boolean) => {
    const { core } = useApp.getState();
    if (!core || active === current) return;
    current = active;
    useApp.setState({ personHere: active });
    void core.client.setActive(active);
  };

  const check = () => report(inFront && Date.now() - lastInput < IDLE_AFTER_MS);

  const onInput = () => {
    lastInput = Date.now();
    if (current !== true) check();
  };
  const timer = setInterval(() => check(), CHECK_EVERY_MS);
  const unsubscribe = useApp.subscribe((state, previous) => {
    // A new core hasn't been told anything yet.
    if (state.core !== previous.core) {
      current = null;
      check();
    }
    if (state.windowFocused === previous.windowFocused) return;
    clearTimeout(blurTimer);
    if (state.windowFocused) {
      inFront = true;
      lastInput = Date.now();
      check();
    } else {
      blurTimer = setTimeout(() => {
        inFront = false;
        check();
      }, BLUR_AFTER_MS);
    }
  });
  const inputs = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
  for (const event of inputs) window.addEventListener(event, onInput, { passive: true });
  check();

  return () => {
    clearInterval(timer);
    clearTimeout(blurTimer);
    unsubscribe();
    for (const event of inputs) window.removeEventListener(event, onInput);
  };
}
