// Whether the person is at this computer. As in Telegram, notifications go
// where the person is: while they're here, the server doesn't wake their phone
// and their other devices keep quiet. They're away after the chosen time
// without input anywhere on the computer, or as soon as the screen locks.

import { desktop } from "@/core/bridge";
import { useApp } from "./store";

const CHECK_EVERY_MS = 15_000;

/** Keeps the core told, until the returned function stops it. */
export function watchActivity(): () => void {
  let current: boolean | null = null;
  let lastInput = Date.now();

  const check = async () => {
    const { core, settings } = useApp.getState();
    if (!core) return;
    const seconds = settings.awayAfterMinutes * 60;
    const here = desktop
      ? (await desktop.idleState(seconds)) === "active"
      : document.hasFocus() && Date.now() - lastInput < seconds * 1000;
    // With notifications off here, the phone should still get them.
    const active = here && settings.notifications;
    if (active === current) return;
    current = active;
    void core.client.setActive(active);
  };

  const onInput = () => {
    lastInput = Date.now();
    if (current === false) void check();
  };
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  const removePresence = desktop?.onPresence((state) => {
    if (state === "away" && current !== false) {
      current = false;
      void useApp.getState().core?.client.setActive(false);
    } else {
      void check();
    }
  });
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (state.settings !== previous.settings) void check();
  });
  for (const event of ["keydown", "pointerdown", "focus"]) window.addEventListener(event, onInput);
  void check();

  return () => {
    clearInterval(timer);
    removePresence?.();
    unsubscribe();
    for (const event of ["keydown", "pointerdown", "focus"]) window.removeEventListener(event, onInput);
  };
}
