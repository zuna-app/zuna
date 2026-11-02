// The desktop's side of the interface: everything the Electron shell provides,
// through the bridge the preload script exposes.

import {
  connectWorker,
  type DeviceInfo,
  type DisplaySource,
  type NativeScreenInfo,
  type NativeScreenOptions,
  type NativeScreenStats,
  type NotificationReply,
  type NotificationRoute,
  type NotificationsToClear,
  type NotificationState,
  type NotifyPayload,
  type Platform,
} from "@zuna/ui";
import { drawCounters } from "./counter";

const isWindows = navigator.userAgent.includes("Windows");

export interface DesktopBridge {
  /** Whether the system shows times with AM and PM. */
  hour12: boolean;
  deviceKey(): Promise<DeviceInfo>;
  platform(): Promise<string>;
  /** Whether the operating system lets Zuna record, asking the person the first time. */
  microphone(): Promise<boolean>;
  camera(): Promise<boolean>;
  displaySources(): Promise<DisplaySource[]>;
  chooseDisplaySource(id: string, audio: boolean): Promise<void>;
  nativeScreenStart(options: NativeScreenOptions): Promise<NativeScreenInfo>;
  nativeScreenKey(key: Uint8Array, keyIndex: number): Promise<void>;
  nativeScreenStop(): Promise<void>;
  onNativeScreenEnded(listener: (problem: string | null) => void): () => void;
  onNativeScreenStats(listener: (stats: NativeScreenStats) => void): () => void;
  watchKey(code: string | null): Promise<boolean>;
  onKey(listener: (down: boolean) => void): () => void;
  notify(payload: NotifyPayload): Promise<void>;
  notificationState(): Promise<NotificationState>;
  clearNotifications(which: NotificationsToClear): Promise<void>;
  onNotificationReply(listener: (reply: NotificationReply) => void): () => void;
  /** The pictures are for Windows, where the app has to draw the count itself. */
  setBadge(count: number, pictures?: { overlay: string; tray: string }): Promise<void>;
  setCloseToTray(enabled: boolean): Promise<void>;
  takeDeepLink(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  onDeepLink(listener: (link: string) => void): () => void;
  onOpenConversation(listener: (route: NotificationRoute) => void): () => void;
  onFocus(listener: (focused: boolean) => void): () => void;
  /** "active", "idle" after this many seconds without input anywhere, or "locked". */
  idleState(seconds: number): Promise<"active" | "idle" | "locked" | "unknown">;
  /** The screen locking or the computer sleeping ("away"), and coming back ("back"). */
  onPresence(listener: (state: "away" | "back") => void): () => void;
}

declare global {
  interface Window {
    zunaDesktop?: DesktopBridge;
  }
}

export function desktopPlatform(): Platform {
  // The preload script always provides it. In a browser, use apps/web instead.
  const desktop = window.zunaDesktop!;
  let unread = 0;
  const showUnread = () => void desktop.setBadge(unread, isWindows && unread > 0 ? drawCounters(unread) : undefined);
  // The window moved to a screen of another scale, so the count is drawn for that.
  const watchScale = () =>
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        showUnread();
        watchScale();
      },
      { once: true },
    );
  if (isWindows) watchScale();
  return {
    hour12: desktop.hour12,
    titleBar: true,
    os: () => desktop.platform(),
    bootCore: async (onEvent) => connectWorker(startWorker(), await desktop.deviceKey(), onEvent),
    openExternal: (url) => void desktop.openExternal(url),
    setUnreadCount(count) {
      unread = count;
      showUnread();
    },
    notify: (payload) => void desktop.notify(payload),
    drawsNotifications: isWindows,
    notificationState: () => desktop.notificationState(),
    clearNotifications: (which) => void desktop.clearNotifications(which),
    onNotificationReply: (listener) => desktop.onNotificationReply(listener),
    microphone: () => desktop.microphone(),
    camera: () => desktop.camera(),
    displaySources: () => desktop.displaySources(),
    chooseDisplaySource: (id, audio) => desktop.chooseDisplaySource(id, audio),
    systemAudio: isWindows,
    nativeScreen: {
      encoders: isWindows
        ? [
            { id: "h264_nvenc", name: "NVIDIA (NVENC)" },
            { id: "h264_amf", name: "AMD (AMF)" },
          ]
        : [
            { id: "h264_nvenc", name: "NVIDIA (NVENC)" },
            { id: "h264_vaapi", name: "AMD or Intel (VA-API)" },
          ],
      start: (options) => desktop.nativeScreenStart(options),
      setKey: (key, keyIndex) => void desktop.nativeScreenKey(key, keyIndex),
      stop: () => void desktop.nativeScreenStop(),
      onEnded: (listener) => desktop.onNativeScreenEnded(listener),
      onStats: (listener) => desktop.onNativeScreenStats(listener),
    },
    watchKey(code, listener) {
      const off = desktop.onKey(listener);
      void desktop.watchKey(code);
      return () => {
        off();
        void desktop.watchKey(null);
      };
    },
    idleState: (seconds) => desktop.idleState(seconds),
    onPresence: (listener) => desktop.onPresence(listener),
    onFocus: (listener) => desktop.onFocus(listener),
    takeDeepLink: () => desktop.takeDeepLink(),
    onDeepLink: (listener) => desktop.onDeepLink(listener),
    onOpenConversation: (listener) => desktop.onOpenConversation(listener),
    setCloseToTray: (enabled) => void desktop.setCloseToTray(enabled),
    keyWarning: "Your system has no keychain available, so Zuna can't lock its local data to your login. Installing a secret service such as GNOME Keyring fixes this.",
  };
}

function startWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "zuna-core" });
}
