// Whether the person is using this computer, as Telegram Desktop counts it
// (MainWindow::markingAsRead and Updates::updateOnline): Zuna's window has focus
// and there was input in the last 30 s, the window coming in front counting as
// input. Leaving the window counts at once. While they're here they show as
// online, and as soon as they aren't, offline, last seen then; their other
// devices hold notifications back meanwhile, and don't show them if they read the
// chat here (notificationDelay in the core). So a chat on screen is read only
// while they're here (personHere), and once they're back: one read in a window
// left in front with nobody at it would take back the notification their phone
// is waiting to show.

import { useApp } from "./store";

/** Telegram's offline_idle_timeout_ms. */
const IDLE_AFTER_MS = 30_000;

/** Keeps the core told, until the returned function stops it. */
export function watchActivity(): () => void {
  let current: boolean | null = null;
  let lastInput = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Online only on the server shown, as Telegram is only in the account shown.
  let reportedServer: string | null = null;
  const report = (active: boolean) => {
    const { core, activeServerId } = useApp.getState();
    if (!core || (active === current && activeServerId === reportedServer)) return;
    current = active;
    reportedServer = activeServerId;
    useApp.setState({ personHere: active });
    void core.client.setActive(active, activeServerId);
  };

  // While they're here, it looks again as 30 s without input run out, the only way
  // being here ends by itself; input and focus say the rest as they happen.
  const check = () => {
    clearTimeout(idleTimer);
    const quiet = Date.now() - lastInput;
    const here = useApp.getState().windowFocused && quiet < IDLE_AFTER_MS;
    report(here);
    if (here) idleTimer = setTimeout(check, IDLE_AFTER_MS - quiet + 20);
  };

  const onInput = () => {
    lastInput = Date.now();
    if (current !== true) check();
  };
  // A browser sends a move when what's under a resting pointer moves, as new messages scroll
  // the chat under it: only one that went somewhere is the person.
  let pointerAt = "";
  const onPointerMove = (event: PointerEvent) => {
    const at = `${event.screenX},${event.screenY}`;
    if (at === pointerAt) return;
    pointerAt = at;
    onInput();
  };
  const unsubscribe = useApp.subscribe((state, previous) => {
    // A new core hasn't been told anything yet.
    if (state.core !== previous.core) {
      current = null;
      check();
    }
    if (state.activeServerId !== previous.activeServerId) check();
    if (state.windowFocused === previous.windowFocused) return;
    if (state.windowFocused) lastInput = Date.now();
    check();
  });
  const inputs = ["keydown", "pointerdown", "wheel"] as const;
  for (const event of inputs) window.addEventListener(event, onInput, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  check();

  return () => {
    clearTimeout(idleTimer);
    unsubscribe();
    for (const event of inputs) window.removeEventListener(event, onInput);
    window.removeEventListener("pointermove", onPointerMove);
  };
}
