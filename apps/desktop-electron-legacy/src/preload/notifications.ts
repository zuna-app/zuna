// The page of notifications shows what it's given and says what's done with it. It can
// reach nothing else in the app, however it came to be running something it shouldn't.

import { contextBridge, ipcRenderer } from "electron";

const on = (channel: string, listener: (value: any) => void) => {
  ipcRenderer.on(channel, (_event, value) => listener(value));
};

contextBridge.exposeInMainWorld("zunaNotifications", {
  onShow: (listener: (payload: unknown) => void) => on("zuna-notifications:show", listener),
  onClear: (listener: (which: unknown) => void) => on("zuna-notifications:clear", listener),
  display: (visible: boolean) => ipcRenderer.invoke("zuna-notifications:display", visible),
  stack: (height: number) => ipcRenderer.invoke("zuna-notifications:stack", height),
  typing: (on: boolean) => ipcRenderer.invoke("zuna-notifications:typing", on),
  open: (route: unknown) => ipcRenderer.invoke("zuna-notifications:open", route),
  reply: (reply: unknown) => ipcRenderer.invoke("zuna-notifications:reply", reply),
  idleSeconds: () => ipcRenderer.invoke("zuna-notifications:idle"),
});
