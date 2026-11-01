// What a host gives the interface: the desktop's Electron shell, or the web app.
// Everything outside the page itself goes through here, so both show the same app.

import type { CoreEvent } from "@zuna/core";
import type { CoreConnection } from "@zuna/core/rpc";

export interface BootResult {
  core: CoreConnection;
  keyProtected: boolean;
}

export interface NotifyPayload {
  title: string;
  body: string;
  route: unknown;
}

/** Something that can be shared: a whole screen, or one window. */
export interface DisplaySource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** What it looks like now, as a data URL. */
  thumbnail: string;
  /** It can be captured and encoded natively, which is much lighter on the computer. */
  native: boolean;
}

/** Sharing a screen from a native process, which captures and encodes on the GPU and only uses LiveKit to carry the result. */
export interface NativeScreenShare {
  /** Starts it, finishing once it's publishing. */
  start(options: { url: string; token: string; key: Uint8Array; keyIndex: number; fps: number; bitrateKbps: number; source: string }): Promise<void>;
  /** The key its frames go under from now on. */
  setKey(key: Uint8Array, keyIndex: number): void;
  stop(): void;
  /** It ended by itself, and why if that's a problem. */
  onEnded(listener: (problem: string | null) => void): () => void;
}

export interface Platform {
  /** Whether the system shows times with AM and PM, or undefined to follow the language. */
  hour12: boolean | undefined;
  /** The desktop draws its own title bar. */
  titleBar: boolean;
  /** The operating system, for how the title bar is laid out. */
  os?(): Promise<string>;
  /** Starts the core in its worker. */
  bootCore(onEvent: (event: CoreEvent) => void): Promise<BootResult>;
  openExternal(url: string): void;
  /** Unread messages in chats that aren't muted, on every server. */
  setUnreadCount(count: number): void;
  /** System notifications. Without them there are no notification settings either. */
  notify?(payload: NotifyPayload): void;
  /** Whether the operating system lets Zuna record, asking the person the first time. */
  microphone?(): Promise<boolean>;
  /** The same for the camera. */
  camera?(): Promise<boolean>;
  /** What can be shared, for a picker of Zuna's own. Without it, the browser asks. */
  displaySources?(): Promise<DisplaySource[]>;
  /** Says what the next request to capture the display gets. */
  chooseDisplaySource?(id: string, audio: boolean): Promise<void>;
  /** Sharing a screen can bring the computer's sound with it. */
  systemAudio?: boolean;
  nativeScreen?: NativeScreenShare;
  /** Says when a key goes down or up anywhere on the computer, not just in this window. */
  watchKey?(code: string, listener: (down: boolean) => void): () => void;
  /** "active", "idle" after this many seconds without input anywhere, or "locked". */
  idleState?(seconds: number): Promise<"active" | "idle" | "locked" | "unknown">;
  /** The screen locking or the computer sleeping ("away"), and coming back ("back"). */
  onPresence?(listener: (state: "away" | "back") => void): () => void;
  onFocus?(listener: (focused: boolean) => void): () => void;
  /** An invite link the app was opened with, once. */
  takeDeepLink?(): Promise<string | null>;
  onDeepLink?(listener: (link: string) => void): () => void;
  /** A click on a notification. */
  onOpenConversation?(listener: (route: unknown) => void): () => void;
  setCloseToTray?(enabled: boolean): void;
  /** Shown in Security when the device key isn't protected, or null to say nothing. */
  keyWarning: string | null;
  /** A server address to start the sign-in form with. */
  defaultServer?: string;
  /** A newer version of the app is ready, and reloading picks it up. */
  onUpdate?(listener: () => void): () => void;
  /** Closing the page stops whatever is still sending, so it asks first. */
  warnBeforeLeaving?: boolean;
}

/** Set once by the host, before the interface renders. */
export let platform: Platform;

export function setPlatform(value: Platform): void {
  platform = value;
}
