// Push to talk, while another window is in front. Electron's own shortcuts only say
// when a key goes down, so this uses a system-wide key hook, and only reports the one
// key asked about. Where there's no such thing, as on Wayland, it only works inside the window.

import { createRequire } from "node:module";

type HookEvent = { keycode: number; button?: number };
interface Hook {
  on(event: "keydown" | "keyup" | "mousedown" | "mouseup", listener: (event: HookEvent) => void): void;
  removeAllListeners(): void;
  start(): void;
  stop(): void;
}

/** `KeyboardEvent.code` as the hook's key codes, which are the same as the system's scan codes. */
function keycodeOf(code: string, keys: Record<string, number>): number | null {
  const names: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/^Key([A-Z])$/, (match) => match[1]!],
    [/^Digit(\d)$/, (match) => match[1]!],
    [/^F(\d+)$/, (match) => `F${match[1]}`],
    [/^Numpad(\d)$/, (match) => `Numpad${match[1]}`],
  ];
  for (const [pattern, name] of names) {
    const match = code.match(pattern);
    if (match) return keys[name(match)] ?? null;
  }
  const others: Record<string, string> = {
    ControlLeft: "Ctrl",
    ControlRight: "CtrlRight",
    ShiftLeft: "Shift",
    ShiftRight: "ShiftRight",
    AltLeft: "Alt",
    AltRight: "AltRight",
    MetaLeft: "Meta",
    MetaRight: "MetaRight",
    Space: "Space",
    Tab: "Tab",
    CapsLock: "CapsLock",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    Insert: "Insert",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Pause: "Pause",
    ScrollLock: "ScrollLock",
  };
  return others[code] ? (keys[others[code]] ?? null) : null;
}

/** Reports one key or mouse button going down and up anywhere, or nothing if that can't be done here. */
export function startKeyWatch(code: string, listener: (down: boolean) => void): (() => void) | null {
  let hook: Hook;
  let keys: Record<string, number>;
  try {
    // Only loaded for someone using this. It reads every key, and passes on none but this one.
    const loaded = createRequire(import.meta.url)("uiohook-napi") as { uIOhook: Hook; UiohookKey: Record<string, number> };
    hook = loaded.uIOhook;
    keys = loaded.UiohookKey;
  } catch (error) {
    console.warn("[zuna] push to talk only works in this window:", error);
    return null;
  }
  const mouse = code.match(/^Mouse(\d+)$/);
  // Browsers count mouse buttons from 0, and the hook from 1.
  const button = mouse ? Number(mouse[1]) + 1 : null;
  const keycode = mouse ? null : keycodeOf(code, keys);
  if (button === null && keycode === null) return null;
  hook.on("keydown", (event) => {
    if (event.keycode === keycode) listener(true);
  });
  hook.on("keyup", (event) => {
    if (event.keycode === keycode) listener(false);
  });
  hook.on("mousedown", (event) => {
    if (event.button === button) listener(true);
  });
  hook.on("mouseup", (event) => {
    if (event.button === button) listener(false);
  });
  try {
    hook.start();
  } catch (error) {
    console.warn("[zuna] push to talk only works in this window:", error);
    hook.removeAllListeners();
    return null;
  }
  return () => {
    hook.removeAllListeners();
    hook.stop();
  };
}
