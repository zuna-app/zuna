/// <reference types="vite/client" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const NOTIFICATION_HOST_WINDOW_VITE_DEV_SERVER_URL: string;
declare const NOTIFICATION_HOST_WINDOW_VITE_NAME: string;

interface Window {
  notification: {
    resize: (height: number) => Promise<void>;
    restore: () => Promise<void>;
    onShow: (
      callback: (payload: {
        senderName: string;
        content: string;
        avatarUrl?: string;
      }) => void,
    ) => () => void;
  };
  env: {
    platform: string;
  };
  system: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
  vault: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
    lock: () => Promise<void>;
    unlock: (password: string) => Promise<void>;
    isFirstTimeSetup: () => Promise<boolean>;
    import: (base64Data: string) => Promise<void>;
    startExportServer: (pin: string) => Promise<{ url: string } | null>;
    stopExportServer: () => Promise<void>;
    saveExportFile: (pin: string) => Promise<{ ok: boolean; reason?: string }>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  cache: {
    get: (name: string, key: string) => Promise<unknown>;
    set: (name: string, key: string, value: unknown) => Promise<void>;
  };
}
