import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import started from "electron-squirrel-startup";
import { registerIPC } from "./ipc";
import { lockVault } from "./storage/safeVault";
import { createWindowsBadgeIcon } from "./utils/badgeIcon";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

if (started) {
  app.quit();
}

registerIPC();

app.setAppUserModelId("chat.zuna.app");
app.dock?.setIcon(path.join(__dirname, "public/zuna.png"));

let tray: Tray | null = null;
let forceQuit = false;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    icon: path.join(__dirname, "public/zuna.png"),
    width: 1450,
    height: 1000,
    frame: false,
    ...(!isMac ? { titleBarStyle: "hiddenInset", titleBarOverlay: false } : {}),
    transparent: isLinux,
    hasShadow: !isLinux,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.webContents.on("did-finish-load", () => {
    if (isLinux) {
      mainWindow.webContents.insertCSS(`
        body { background: transparent !important; }
      `);
    }
  });

  mainWindow.on("close", (e) => {
    if (!forceQuit) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.once("ready-to-show", async () => {
    const badgeIcon = await createWindowsBadgeIcon(5);
    mainWindow.setOverlayIcon(badgeIcon, "5 unread messages");
  });

  mainWindow.webContents.openDevTools();

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "/public/zuna.png")
    : path.join(app.getAppPath(), "/public/zuna.png");
  const trayIcon = nativeImage
    .createFromPath(iconPath)
    .resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip("Zuna");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
};

app.on(
  "certificate-error",
  (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
  },
);

app.on("ready", createWindow);

app.on("before-quit", () => {
  forceQuit = true;
  lockVault();
});

app.on("window-all-closed", () => {});

app.on("activate", () => {
  const mainWindow = BrowserWindow.getAllWindows()[0];

  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
