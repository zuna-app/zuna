import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
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

  mainWindow.webContents.openDevTools();
};

app.on("ready", createWindow);

app.on("before-quit", () => {
  lockVault();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
