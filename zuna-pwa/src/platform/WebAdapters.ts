import type {
  ICacheAdapter,
  IWindowAdapter,
  IShellAdapter,
  INotificationAdapter,
} from "@zuna/shared";

/** localStorage-backed cache adapter */
export const WebCacheAdapter: ICacheAdapter = {
  get<T>(cacheName: string, key: string): Promise<T | null> {
    try {
      const raw = localStorage.getItem(`zuna:${cacheName}:${key}`);
      if (raw === null) return Promise.resolve(null);
      return Promise.resolve(JSON.parse(raw) as T);
    } catch {
      return Promise.resolve(null);
    }
  },
  set<T>(cacheName: string, key: string, value: T): Promise<void> {
    try {
      localStorage.setItem(`zuna:${cacheName}:${key}`, JSON.stringify(value));
    } catch {
      // Storage full – silently ignore
    }
    return Promise.resolve();
  },
};

/** No-op window adapter — web tabs have no native window controls */
export const WebWindowAdapter: IWindowAdapter = {
  isNative: false,
  minimize: () => {},
  maximize: () => {},
  close: () => {
    window.close();
  },
};

/** Use window.open to open external URLs */
export const WebShellAdapter: IShellAdapter = {
  openExternal: (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};

/** Web Notification API + navigator.setAppBadge */
export const WebNotificationAdapter: INotificationAdapter = {
  async show(title: string, body: string, avatarUrl?: string) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
    }
    new Notification(title, { body, icon: avatarUrl });
  },

  setBadge(count: number) {
    if ("setAppBadge" in navigator) {
      if (count > 0) {
        (navigator as any).setAppBadge(count).catch(() => {});
      } else {
        (navigator as any).clearAppBadge().catch(() => {});
      }
    }
  },
};
