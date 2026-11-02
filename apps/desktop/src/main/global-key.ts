// Push to talk, while another window is in front. Electron's own shortcuts only say
// when a key goes down, so this uses a system-wide key hook, and only reports the one
// key asked about. Under Wayland nothing but the compositor sees a key held in another
// window, so there the native program binds it through the global shortcuts portal,
// where the compositor has one. Without it, it only works inside the window.

import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { nativeScreenPath, waylandSession } from "./native-screen";

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

/** `KeyboardEvent.code` as the XDG shortcuts specification names a key, which is XKB's name for it. */
function triggerOf(code: string): string | null {
  const names: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/^Key([A-Z])$/, (match) => match[1]!.toLowerCase()],
    [/^Digit(\d)$/, (match) => match[1]!],
    [/^F(\d+)$/, (match) => `F${match[1]}`],
    [/^Numpad(\d)$/, (match) => `KP_${match[1]}`],
  ];
  for (const [pattern, name] of names) {
    const match = code.match(pattern);
    if (match) return name(match);
  }
  const others: Record<string, string> = {
    Space: "space",
    Tab: "Tab",
    CapsLock: "Caps_Lock",
    Backquote: "grave",
    Minus: "minus",
    Equal: "equal",
    BracketLeft: "bracketleft",
    BracketRight: "bracketright",
    Backslash: "backslash",
    Semicolon: "semicolon",
    Quote: "apostrophe",
    Comma: "comma",
    Period: "period",
    Slash: "slash",
    Insert: "Insert",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "Prior",
    PageDown: "Next",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Pause: "Pause",
    ScrollLock: "Scroll_Lock",
  };
  // A modifier alone isn't a shortcut, so the compositor's dialog asks for a key instead.
  return others[code] ?? null;
}

/**
 * Whether a key held in another window can be heard, and a mouse button too. Where it
 * can't, why: the compositor has no global shortcuts, or it only gives them to an app
 * installed with a .desktop file, which an AppImage or a development build isn't.
 */
export interface KeyWatchSupport {
  anywhere: boolean;
  mouse: boolean;
  why?: "compositor" | "uninstalled";
}

let shortcuts: Promise<KeyWatchSupport> | null = null;

/** Under Wayland, what the compositor's global shortcuts allow, asked of the native program. */
function compositorShortcuts(): Promise<KeyWatchSupport> {
  const path = nativeScreenPath();
  // The portal's shortcuts are keys alone.
  if (!path) return Promise.resolve({ anywhere: false, mouse: false, why: "compositor" });
  shortcuts ??= new Promise<KeyWatchSupport>((resolve) => {
    execFile(path, ["--global-shortcuts"], { timeout: 5000 }, (error, stdout) => {
      let said: { version?: unknown; allowed?: unknown } = {};
      try {
        said = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
      } catch {
        // Nothing said is no portal.
      }
      if (error || !(Number(said.version) >= 1)) resolve({ anywhere: false, mouse: false, why: "compositor" });
      else resolve(said.allowed === true ? { anywhere: true, mouse: false } : { anywhere: false, mouse: false, why: "uninstalled" });
    });
  }).then((found) => {
    // A portal that wasn't up yet gets asked again next time.
    if (!found.anywhere) shortcuts = null;
    return found;
  });
  return shortcuts;
}

export async function keyWatchSupport(): Promise<KeyWatchSupport> {
  if (process.platform !== "linux" || !waylandSession()) return { anywhere: true, mouse: true };
  return compositorShortcuts();
}

/** Binds the key through the global shortcuts portal, which may ask the person to confirm it, or to choose another. */
function startShortcutWatch(code: string, listener: (down: boolean) => void, onBound: (trigger: string) => void): (() => void) | null {
  const path = nativeScreenPath();
  if (!path || code.startsWith("Mouse")) return null;
  const child = spawn(path, ["--push-to-talk", triggerOf(code) ?? ""], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: { type?: string; trigger?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "bound") onBound(typeof message.trigger === "string" ? message.trigger : "");
    // KDE says each of these twice, which changes nothing.
    else if (message.type === "down" || message.type === "up") listener(message.type === "down");
  });
  createInterface({ input: child.stderr! }).on("line", (line) => console.warn("[zuna] push to talk:", line));
  child.on("error", (error) => console.warn("[zuna] push to talk only works in this window:", error));
  // A key nothing listens for any more can't be held.
  child.on("exit", () => listener(false));
  return () => {
    child.stdin?.end();
    setTimeout(() => child.kill(), 2000).unref();
  };
}

/**
 * Reports one key or mouse button going down and up anywhere, or nothing if that can't
 * be done here. Where the system binds the key itself, it says what it bound.
 */
export function startKeyWatch(code: string, listener: (down: boolean) => void, onBound: (trigger: string) => void): (() => void) | null {
  if (process.platform === "linux" && waylandSession()) return startShortcutWatch(code, listener, onBound);
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
