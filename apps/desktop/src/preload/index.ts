// The only bridge between the sandboxed renderer and the operating system.

import { contextBridge, ipcRenderer } from "electron";

const on = (channel: string, listener: (value: any) => void) => {
  const wrapped = (_event: unknown, value: unknown) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("zunaDesktop", {
  hour12: process.argv.includes("--zuna-clock=12"),
  deviceKey: () => ipcRenderer.invoke("zuna:device-key"),
  platform: () => ipcRenderer.invoke("zuna:platform"),
  microphone: () => ipcRenderer.invoke("zuna:microphone"),
  notify: (payload: unknown) => ipcRenderer.invoke("zuna:notify", payload),
  setBadge: (count: number) => ipcRenderer.invoke("zuna:badge", count),
  setCloseToTray: (enabled: boolean) => ipcRenderer.invoke("zuna:close-to-tray", enabled),
  takeDeepLink: () => ipcRenderer.invoke("zuna:take-deep-link"),
  openExternal: (url: string) => ipcRenderer.invoke("zuna:open-external", url),
  onDeepLink: (listener: (link: string) => void) => on("zuna:deep-link", listener),
  onOpenConversation: (listener: (route: unknown) => void) => on("zuna:open-conversation", listener),
  onFocus: (listener: (focused: boolean) => void) => on("zuna:focus", listener),
  idleState: (seconds: number) => ipcRenderer.invoke("zuna:idle-state", seconds),
  onPresence: (listener: (state: string) => void) => on("zuna:presence", listener),
});
