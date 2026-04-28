import { BrowserWindow, ipcMain } from "electron";
import { sendNotification } from "./notification";
import {
  getNotificationWindowHost,
  resizeNotificationWindowHost,
} from "./host";

export const registerNotificationIPC = () => {
  ipcMain.handle("notification:resize", (_, height: number) => {
    const notifWin = getNotificationWindowHost();
    const mainWin = BrowserWindow.getAllWindows().find(
      (w) => w !== notifWin && !w.isDestroyed(),
    );
    resizeNotificationWindowHost(height, mainWin);
  });
  ipcMain.handle("notification:restore", () => {
    const notifWin = getNotificationWindowHost();
    const win = BrowserWindow.getAllWindows().find(
      (w) => w !== notifWin && !w.isDestroyed(),
    );
    if (win) {
      if (win.isMinimized()) win.restore();
      win.setAlwaysOnTop(true);
      win.show();
      win.focus();
      win.setAlwaysOnTop(false);
    }
  });
};
