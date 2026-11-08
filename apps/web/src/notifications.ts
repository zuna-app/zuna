// Notifications through the browser, as Telegram Web's: one per chat, the
// newest taking the place of the one before, with the app's own sound rather
// than the browser's. A click opens the chat, and reading it takes it back.

import type { NotificationRoute, NotificationsToClear, NotifyPayload } from "@zuna/ui";

interface Shown {
  route: NotificationRoute;
  messageId: string;
  notification: Notification;
}

const supported = typeof Notification !== "undefined";
/** By server and chat. */
const shown = new Map<string, Shown>();
const openers = new Set<(route: NotificationRoute) => void>();

export function notify(payload: NotifyPayload): void {
  if (!supported || Notification.permission !== "granted") return;
  const id = `${payload.route.serverId}|${payload.route.key}`;
  shown.get(id)?.notification.close();
  let notification: Notification;
  try {
    notification = new Notification(payload.title, { body: payload.body, tag: id, icon: "/icon-192.png", silent: true });
  } catch {
    // Chrome on Android, tablets too, only notifies through a service worker, and throws here.
    return;
  }
  const entry: Shown = { route: payload.route, messageId: payload.messageId, notification };
  shown.set(id, entry);
  notification.onclick = () => {
    window.focus();
    for (const open of openers) open(payload.route);
    notification.close();
  };
  notification.onclose = () => {
    if (shown.get(id) === entry) shown.delete(id);
  };
}

export function clearNotifications(which: NotificationsToClear): void {
  for (const [id, entry] of shown) {
    if (which.serverId && entry.route.serverId !== which.serverId) continue;
    if (which.keys && !which.keys.includes(entry.route.key)) continue;
    if (which.messageId && entry.messageId !== which.messageId) continue;
    entry.notification.close();
    shown.delete(id);
  }
}

export function onOpenConversation(listener: (route: NotificationRoute) => void): () => void {
  openers.add(listener);
  return () => openers.delete(listener);
}

export function notificationPermission(): "granted" | "denied" | "unknown" {
  if (!supported) return "denied";
  return Notification.permission === "default" ? "unknown" : Notification.permission;
}

/** Follows the browser's permission as the person changes it in its settings, where the browser says. */
export function onNotificationPermission(listener: (permission: "granted" | "denied" | "unknown") => void): () => void {
  let stopped = false;
  let status: PermissionStatus | null = null;
  const changed = () => listener(notificationPermission());
  void navigator.permissions
    ?.query({ name: "notifications" })
    .then((found) => {
      if (stopped) return;
      status = found;
      status.addEventListener("change", changed);
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    status?.removeEventListener("change", changed);
  };
}

/** The browser only asks right after a click or a key press. */
export async function askToNotify(): Promise<void> {
  if (supported && Notification.permission === "default") await Notification.requestPermission();
}
