/**
 * Notification adapter — OS/browser notifications and badge counts.
 * Implementations: ElectronNotificationAdapter (IPC), WebNotificationAdapter (Notification API).
 */
export interface INotificationAdapter {
  show(title: string, body: string, avatarUrl?: string): void;
  setBadge(count: number): void;
}
