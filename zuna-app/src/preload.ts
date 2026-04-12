import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("security", {
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
});
