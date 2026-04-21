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

const isLinux = process.platform === "linux";

if (started) {
  app.quit();
}

registerIPC();

let tray: Tray | null = null;
let forceQuit = false;

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    icon: path.join(__dirname, "assets/zuna.png"),
    width: 1450,
    height: 1000,
    frame: false,
    titleBarStyle: "hiddenInset",
    titleBarOverlay: false,
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

  mainWindow.webContents.openDevTools();

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "assets/zuna.png")
    : path.join(app.getAppPath(), "src/assets/zuna.png");
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

app.on("ready", createWindow);

app.on("before-quit", () => {
  lockVault();
});

app.on("window-all-closed", () => {});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
