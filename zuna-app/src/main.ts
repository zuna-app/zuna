import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import started from "electron-squirrel-startup";
import { registerIPC } from "./ipc";
import { lockVault } from "./storage/safeVault";
import { windowStateCache } from "./storage/appCache";
import { setUnreadMessagesBadge } from "./gateway/gatewayListener";
import { showNotificationWindowHost } from "./notification/host";
import { registerNotificationIPC } from "./notification/ipc";
import { getZunaWindow } from "./utils/basicUtils";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

if (!isLinux) {
  const { updateElectronApp } = require("update-electron-app");
  updateElectronApp();
}

const resolveIconPath = (...pathSegments: string[]) => {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, ...pathSegments),
        path.join(process.resourcesPath, "public", ...pathSegments),
      ]
    : [
        path.join(app.getAppPath(), ...pathSegments),
        path.join(app.getAppPath(), "public", ...pathSegments),
      ];

  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  );
};

if (started) {
  app.quit();
}

import { isDev } from "./utils/env";

const gotTheLock = isDev || app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

if (gotTheLock) {
  registerIPC();

  app.setAppUserModelId("chat.zuna.app.v1");
  app.setName("Zuna");
  app.dock?.setIcon(resolveIconPath("zuna.png"));

  let tray: Tray | null = null;
  let forceQuit = false;

  const saveWindowState = (win: BrowserWindow) => {
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    const { width, height } = win.getBounds();
    windowStateCache.set("width", width);
    windowStateCache.set("height", height);
  };

  const createWindow = () => {
    const { width, height } = windowStateCache.getAll();
    const appIconPath = resolveIconPath(isWindows ? "icon.ico" : "zuna.png");
    const mainWindow = new BrowserWindow({
      icon: appIconPath,
      width,
      height,
      frame: false,
      ...(!isMac
        ? { titleBarStyle: "hiddenInset", titleBarOverlay: false }
        : {}),
      transparent: isLinux,
      hasShadow: !isLinux,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    mainWindow.setIcon(appIconPath);

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
      mainWindow.loadFile(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      );
    }

    mainWindow.on("focus", () => mainWindow.flashFrame(false));

    // Vite's dep-optimizer can invalidate the cache mid-load in dev; reload automatically.
    mainWindow.webContents.on("did-fail-load", (_, errorCode) => {
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL && errorCode === -3) {
        // ERR_ABORTED (-3) is the code for 504 Outdated Optimize Dep redirects
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      }
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    mainWindow.webContents.on("did-finish-load", () => {
      if (isLinux) {
        mainWindow.webContents.insertCSS(`
        body { background: transparent !important; }
      `);
      }
    });

    mainWindow.on("resize", () => saveWindowState(mainWindow));

    mainWindow.on("close", (e) => {
      saveWindowState(mainWindow);
      if (!forceQuit) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    const trayIcon = nativeImage
      .createFromPath(appIconPath)
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

    if (isWindows) {
      registerNotificationIPC();
      showNotificationWindowHost({ mainWindow });
    }
  };

  app.on(
    "certificate-error",
    (event, webContents, url, error, certificate, callback) => {
      event.preventDefault();
      callback(true);
    },
  );

  app.on("second-instance", () => {
    const mainWindow = getZunaWindow();

    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }

    mainWindow.focus();
  });

  app.on("ready", () => {
    session.defaultSession.webRequest.onBeforeRequest(
      {
        urls: ["wss://socket.streamable.com/*", "ws://socket.streamable.com/*"],
      },
      (_details, callback) => callback({ cancel: true }),
    );

    // YouTube's embed player rejects requests with a null/missing Referer
    // (which happens when the app is loaded via file:// in production).
    // Injecting a YouTube referer fixes error 153.
    session.defaultSession.webRequest.onBeforeSendHeaders(
      {
        urls: [
          "*://*.youtube.com/*",
          "*://*.ytimg.com/*",
          "*://*.googlevideo.com/*",
        ],
      },
      (details, callback) => {
        const headers = { ...details.requestHeaders };
        if (!headers["Referer"] && !headers["referer"]) {
          headers["Referer"] = "https://www.youtube.com/";
        }
        callback({ requestHeaders: headers });
      },
    );

    createWindow();
  });

  app.on("before-quit", () => {
    if (isLinux) {
      setUnreadMessagesBadge(0);
    }

    forceQuit = true;
    lockVault();
  });

  app.on("window-all-closed", () => {});

  app.on("activate", () => {
    const mainWindow = getZunaWindow();

    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      return;
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
