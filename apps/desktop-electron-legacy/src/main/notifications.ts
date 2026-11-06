// Notifications on Windows, drawn by the app as Telegram draws its own. They all live in
// one window in the corner of the screen, above everything and never taking focus, which
// stays out of sight while there are none. Its page (renderer/src/notifications) decides
// what shows and for how long. This only does what a page can't do for itself.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { BrowserWindow, ipcMain, powerMonitor, screen, type Display, type IpcMainInvokeEvent } from "electron";
import { nativeScreenPath } from "./native-screen";

const CARD_WIDTH = 320;
/** A card and the gap it leaves at the edge of the screen. */
const WIDTH = CARD_WIDTH + 6;
/** Three cards with a reply open under each, and "Hide all". The rest lets clicks through. */
const HEIGHT = 540;
const MAX_REPLY_LENGTH = 100_000;
/** Twice as often as it would take someone to reach a card and click it. */
const MOUSE_WATCH_MS = 30;

export interface Notifications {
  show(payload: unknown): void;
  clear(which: unknown): void;
  close(): void;
}

export function startNotifications(options: {
  /** The page's address. It isn't one of the app's own pages, so it can't ask for what they can. */
  url: string;
  /** The screen to show them on. */
  display(): Display;
  open(route: unknown): void;
  reply(reply: unknown): void;
}): Notifications {
  let window: BrowserWindow | null = null;
  let loaded = false;
  let waiting: Array<[string, unknown]> = [];
  let stackHeight = 0;
  let overCards = false;
  let mouseWatch: ReturnType<typeof setInterval> | undefined;

  const place = () => {
    if (!window) return;
    const area = options.display().workArea;
    const height = Math.min(HEIGHT, area.height);
    const bounds = { x: area.x + area.width - WIDTH, y: area.y + area.height - height, width: WIDTH, height };
    // Going to a screen of another scale, the first move still goes by the scale of the one it's leaving.
    window.setBounds(bounds);
    window.setBounds(bounds);
  };

  const create = (): BrowserWindow => {
    const created = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      thickFrame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      type: "toolbar",
      webPreferences: {
        preload: join(__dirname, "../preload/notifications.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // Its timers decide when cards go, whatever is covering it.
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    created.setAlwaysOnTop(true, "screen-saver");
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.once("did-finish-load", () => {
      loaded = true;
      for (const [channel, value] of waiting) created.webContents.send(channel, value);
      waiting = [];
    });
    // A page that crashed takes its cards with it. The next notification starts another.
    created.webContents.on("render-process-gone", () => created.destroy());
    created.on("closed", () => {
      clearInterval(mouseWatch);
      if (window === created) window = null;
      loaded = false;
    });
    void created.loadURL(options.url);
    return created;
  };

  const send = (channel: string, value: unknown) => {
    window ??= create();
    if (loaded) window.webContents.send(channel, value);
    else waiting.push([channel, value]);
  };

  // Each answers only this window's page, whatever the page says about itself.
  const handle = (channel: string, listener: (target: BrowserWindow, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args) => {
      if (!window || event.sender !== window.webContents) throw new Error("Blocked a request from an unknown page.");
      return listener(window, ...args);
    });

  /**
   * The window is taller than its cards, and the rest of it lets clicks through. Which of those the mouse
   * is over goes by where it is. Electron's way, hearing about the mouse from the page while ignoring it,
   * watches every move on the computer, misses some, and flips back and forth as the window changes over.
   */
  const watchMouse = (target: BrowserWindow) => {
    const { x, y } = screen.getCursorScreenPoint();
    const bounds = target.getBounds();
    const over = x >= bounds.x && x < bounds.x + CARD_WIDTH && y < bounds.y + bounds.height && y >= bounds.y + bounds.height - stackHeight;
    if (over === overCards) return;
    overCards = over;
    target.setIgnoreMouseEvents(!over);
    // The page hears at once, even with the mouse standing still.
    target.webContents.sendInputEvent({ type: over ? "mouseMove" : "mouseLeave", x: x - bounds.x, y: y - bounds.y });
  };

  // The page says when, since it knows what it's showing and asks in order.
  handle("zuna-notifications:display", (target, visible: boolean) => {
    if (visible) {
      if (!target.isVisible()) {
        place();
        overCards = false;
        target.setIgnoreMouseEvents(true);
        mouseWatch = setInterval(() => watchMouse(target), MOUSE_WATCH_MS);
      }
      target.showInactive();
      target.setAlwaysOnTop(true, "screen-saver");
    } else {
      clearInterval(mouseWatch);
      target.hide();
    }
  });
  // How high the cards reach from the bottom of the window.
  handle("zuna-notifications:stack", (target, height: number) => {
    stackHeight = height;
    if (target.isVisible()) watchMouse(target);
  });
  // Typing a reply is the only thing that may take focus.
  handle("zuna-notifications:typing", (target, on: boolean) => {
    target.setFocusable(on);
    target.setSkipTaskbar(true);
    if (on) target.focus();
  });
  handle("zuna-notifications:open", (_target, route: unknown) => options.open(route));
  handle("zuna-notifications:reply", (_target, reply: { route: unknown; messageId: unknown; text: unknown }) => {
    if (typeof reply?.text === "string" && reply.text.length <= MAX_REPLY_LENGTH) options.reply(reply);
  });
  // How long since the person last touched the computer, to the second.
  handle("zuna-notifications:idle", () => powerMonitor.getSystemIdleTime());

  for (const change of ["display-metrics-changed", "display-added", "display-removed"] as const) {
    screen.on(change as "display-added", () => {
      if (window?.isVisible()) place();
    });
  }

  return {
    show: (payload) => send("zuna-notifications:show", payload),
    clear(which) {
      if (window) send("zuna-notifications:clear", which);
    },
    close() {
      window?.destroy();
    },
  };
}

const ASK_EVERY_MS = 1000;
const ASK_TIMEOUT_MS = 1000;

// Windows's QUERY_USER_NOTIFICATION_STATE.
const NOT_PRESENT = 1;
const BUSY = 2;
const FULL_SCREEN_D3D = 3;
const PRESENTATION = 4;

let asked: { at: number; answer: Promise<NotificationStateAnswer> } | null = null;

interface NotificationStateAnswer {
  show: boolean;
  sound: boolean;
  waitForInput: boolean;
}

/** Asks the native program, which isn't in every build. Without an answer, notifications show. */
function askWindows(): Promise<NotificationStateAnswer> {
  const locked = powerMonitor.getSystemIdleState(1) === "locked";
  const anything = { show: true, sound: !locked, waitForInput: true };
  return new Promise((resolve) => {
    const program = nativeScreenPath();
    if (!program) return resolve(anything);
    execFile(program, ["--notification-state"], { timeout: ASK_TIMEOUT_MS, windowsHide: true }, (error, output) => {
      if (error) return resolve(anything);
      try {
        const { state, focusAssist } = JSON.parse(output) as { state: number; focusAssist: boolean };
        resolve({
          // The same rules as Telegram's.
          show: state !== PRESENTATION && state !== FULL_SCREEN_D3D && !focusAssist,
          sound: state !== NOT_PRESENT && state !== PRESENTATION && !focusAssist && !locked,
          waitForInput: state !== BUSY,
        });
      } catch {
        resolve(anything);
      }
    });
  });
}

/** What Windows wants right now. A burst of messages only asks once. */
export function notificationState(): Promise<NotificationStateAnswer> {
  const now = Date.now();
  if (!asked || now - asked.at > ASK_EVERY_MS) asked = { at: now, answer: askWindows() };
  return asked.answer;
}
