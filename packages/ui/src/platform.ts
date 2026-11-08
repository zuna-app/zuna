// What the web app gives the interface: everything outside the page itself goes through here.

import type { CoreEvent } from "@zuna/core";
import type { CoreConnection } from "@zuna/core/rpc";

export interface BootResult {
  core: CoreConnection;
}

/** Which chat a notification is about. */
export interface NotificationRoute {
  serverId: string;
  key: string;
}

export interface NotifyPayload {
  title: string;
  body: string;
  route: NotificationRoute;
  messageId: string;
}

export interface NotificationsToClear {
  serverId?: string;
  /** Chats that were read. */
  keys?: string[];
  messageId?: string;
}

export interface Platform {
  /** Starts the core in its worker. */
  bootCore(onEvent: (event: CoreEvent) => void): Promise<BootResult>;
  openExternal(url: string): void;
  /** Unread messages in chats that aren't muted, on every server. */
  setUnreadCount(count: number): void;
  /** The browser's notifications. */
  notify(payload: NotifyPayload): void;
  clearNotifications(which: NotificationsToClear): void;
  /** Whether the browser lets Zuna notify, which it asks the person first. */
  notificationPermission(): "granted" | "denied" | "unknown";
  /** Asks to be let notify. A browser only asks right after a click or a key press. */
  askToNotify(): Promise<void>;
  /** An invite link the app was opened with, once. */
  takeDeepLink(): string | null;
  onDeepLink(listener: (link: string) => void): () => void;
  /** A click on a notification. */
  onOpenConversation(listener: (route: NotificationRoute) => void): () => void;
  /** Shown in Security, since a browser can't lock the device key to the person's login. */
  keyWarning: string;
  /** A server address to start the sign-in form with. */
  defaultServer?: string;
  /** A newer version of the app is ready, and reloading picks it up. */
  onUpdate(listener: () => void): () => void;
}

/** Set once by the host, before the interface renders. */
export let platform: Platform;

export function setPlatform(value: Platform): void {
  platform = value;
}
