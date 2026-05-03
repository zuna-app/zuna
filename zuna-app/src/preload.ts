import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("env", {
  platform: process.platform,
});

contextBridge.exposeInMainWorld("system", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
});

contextBridge.exposeInMainWorld("shell", {
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
});

contextBridge.exposeInMainWorld("vault", {
  get: (key: string) => ipcRenderer.invoke("vault:get", key),
  set: (key: string, value: any) => ipcRenderer.invoke("vault:set", key, value),
  delete: (key: string) => ipcRenderer.invoke("vault:delete", key),
  lock: () => ipcRenderer.invoke("vault:lock"),
  unlock: (password: string) => ipcRenderer.invoke("vault:unlock", password),
  isFirstTimeSetup: () => ipcRenderer.invoke("vault:isFirstTimeSetup"),
  import: (base64Data: string) =>
    ipcRenderer.invoke("vault:import", base64Data),
  startExportServer: (pin: string) =>
    ipcRenderer.invoke("vault:startExportServer", pin),
  stopExportServer: () => ipcRenderer.invoke("vault:stopExportServer"),
  saveExportFile: (pin: string) =>
    ipcRenderer.invoke("vault:saveExportFile", pin),
});

contextBridge.exposeInMainWorld("cache", {
  get: (name: string, key: string) =>
    ipcRenderer.invoke("cache:get", name, key),
  set: (name: string, key: string, value: unknown) =>
    ipcRenderer.invoke("cache:set", name, key, value),
});

contextBridge.exposeInMainWorld("notification", {
  resize: (height: number) => ipcRenderer.invoke("notification:resize", height),
  restore: () => ipcRenderer.invoke("notification:restore"),
  onShow: (
    callback: (payload: {
      senderName: string;
      content: string;
      avatarUrl?: string;
    }) => void,
  ) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown) =>
      callback(
        payload as { senderName: string; content: string; avatarUrl?: string },
      );
    ipcRenderer.on("notification:show", handler);
    return () => ipcRenderer.off("notification:show", handler);
  },
});
