/**
 * Electron platform adapter.
 * Delegates to the window.* IPC APIs exposed by preload.ts.
 * The security/crypto IPC is now UNUSED — all crypto runs in shared JS.
 */
import type {
  IPlatform,
  IVaultAdapter,
  ICacheAdapter,
  IWindowAdapter,
  IShellAdapter,
  INotificationAdapter,
} from "@zuna/shared";

const vaultAdapter: IVaultAdapter = {
  isFirstTimeSetup: () => window.vault.isFirstTimeSetup(),
  unlock: (password) => window.vault.unlock(password),
  lock: () => window.vault.lock(),
  get: (key) => window.vault.get(key),
  set: (key, value) => window.vault.set(key, value),
  delete: (key) => window.vault.delete(key),
  importVault: (base64) => window.vault.import(base64),
  export: {
    startServer: (pin) => window.vault.startExportServer(pin),
    stopServer: () => window.vault.stopExportServer(),
    saveFile: (pin) => window.vault.saveExportFile(pin),
  },
};

const cacheAdapter: ICacheAdapter = {
  get: <T>(cacheName: string, key: string) =>
    window.cache.get(cacheName, key) as Promise<T | null>,
  set: <T>(cacheName: string, key: string, value: T) =>
    window.cache.set(cacheName, key, value),
};

const windowAdapter: IWindowAdapter = {
  isNative: true,
  minimize: () => {
    window.system.minimize();
  },
  maximize: () => {
    window.system.maximize();
  },
  close: () => {
    window.system.close();
  },
};

const shellAdapter: IShellAdapter = {
  openExternal: (url) => {
    window.shell.openExternal(url);
  },
};

const notificationAdapter: INotificationAdapter = {
  show: (title, body, _avatarUrl) => {
    // Delegate to native via IPC notification popup
    // The actual notification window is managed by the main process.
    // We trigger it by dispatching a custom event the main process listens for.
    // For simplicity, use the Web Notification API as fallback here.
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  },
  setBadge: (_count) => {
    // Badge is managed by the main process via separate IPC
  },
};

export const ElectronPlatform: IPlatform = {
  vault: vaultAdapter,
  cache: cacheAdapter,
  window: windowAdapter,
  shell: shellAdapter,
  notification: notificationAdapter,
};
