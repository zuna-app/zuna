import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("security", {
  encryptFile: (
    data: Uint8Array,
    receiverPublicKey: string,
  ): Promise<Uint8Array> =>
    ipcRenderer.invoke("file:encryptFile", data, receiverPublicKey),
  decryptFile: (
    data: Uint8Array,
    senderPublicKey: string,
  ): Promise<Uint8Array> =>
    ipcRenderer.invoke("file:decryptFile", data, senderPublicKey),
  encode: (str: string): Promise<string> =>
    ipcRenderer.invoke("base64:encode", str),
  decode: (base64: string): Promise<string> =>
    ipcRenderer.invoke("base64:decode", base64),
  generateEncryptionKeyPair: (): Promise<{
    publicKey: string;
    privateKey: string;
  }> => ipcRenderer.invoke("x25519:generateEncryptionKeyPair"),
  computeSharedSecret: (
    privateKey: string,
    publicKey: string,
  ): Promise<string> =>
    ipcRenderer.invoke("x25519:computeSharedSecret", privateKey, publicKey),
  encrypt: (sharedSecret: string, plaintext: string): Promise<string> =>
    ipcRenderer.invoke("x25519:encrypt", sharedSecret, plaintext),
  decrypt: (sharedSecret: string, encryptedMessage: string): Promise<string> =>
    ipcRenderer.invoke("x25519:decrypt", sharedSecret, encryptedMessage),
  generateSigningKeyPair: (): Promise<{
    publicKey: string;
    privateKey: string;
  }> => ipcRenderer.invoke("ed25519:generateSigningKeyPair"),
  signMessage: (privateKey: string, message: string): Promise<string> =>
    ipcRenderer.invoke("ed25519:signMessage", privateKey, message),
  verifySignature: (
    publicKey: string,
    serverId: string,
    signature: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke(
      "ed25519:verifySignature",
      publicKey,
      serverId,
      signature,
    ),
});

contextBridge.exposeInMainWorld("env", {
  platform: process.platform,
});

contextBridge.exposeInMainWorld("system", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
});

contextBridge.exposeInMainWorld("og", {
  fetch: (url: string) => ipcRenderer.invoke("og:fetch", url),
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
