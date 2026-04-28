import {
  getNotificationWindowHost,
  isNotificationWindowHostVisible,
  showNotificationWindowHost,
} from "./host";

export type NotificationPayload = {
  senderName: string;
  content: string;
  avatarUrl?: string;
};

export const sendNotification = (payload: NotificationPayload) => {
  if (!isNotificationWindowHostVisible()) {
    showNotificationWindowHost({});
  }

  const host = getNotificationWindowHost();
  if (!host || host.isDestroyed()) return;

  host.webContents.send("notification:show", payload);
};
