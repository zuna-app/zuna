// What the web app gives the interface: everything outside the page itself goes through here.

import type { CoreEvent } from "@zuna/core";
import type { CoreConnection } from "@zuna/core/rpc";

export interface BootResult {
  core: CoreConnection;
  keyProtected: boolean;
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
  /** System notifications. Without them there are no notification settings either. */
  notify?(payload: NotifyPayload): void;
  clearNotifications?(which: NotificationsToClear): void;
  /** Whether the system lets Zuna notify, where it asks first, as a browser does. */
  notificationPermission?(): "granted" | "denied" | "unknown";
  /** Asks to be let notify. A browser only asks right after a click or a key press. */
  askToNotify?(): Promise<void>;
  /** An invite link the app was opened with, once. */
  takeDeepLink?(): Promise<string | null>;
  onDeepLink?(listener: (link: string) => void): () => void;
  /** A click on a notification. */
  onOpenConversation?(listener: (route: NotificationRoute) => void): () => void;
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
