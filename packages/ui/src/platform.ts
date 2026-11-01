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
}

/** Set once by the host, before the interface renders. */
export let platform: Platform;

export function setPlatform(value: Platform): void {
  platform = value;
}
