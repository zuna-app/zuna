import { ipcMain } from "electron";
import { toBase64, fromBase64 } from "./crypto/base64";
import {
  computeSharedSecret,
  decrypt,
  encrypt,
  generateEncryptionKeyPair,
} from "./crypto/x25519";
import { generateSigningKeyPair, signMessage } from "./crypto/ed25519";

export function registerIPC() {
  ipcMain.handle("base64:encode", (_, str) => {
    return toBase64(str);
  });

  ipcMain.handle("base64:decode", (_, base64) => {
    return fromBase64(base64);
  });

  ipcMain.handle("x25519:generateEncryptionKeyPair", () => {
    return generateEncryptionKeyPair();
  });

  ipcMain.handle(
    "x25519:computeSharedSecret",
    (_, privateKey: string, publicKey: string) => {
      return computeSharedSecret(privateKey, publicKey);
    },
  );

  ipcMain.handle(
    "x25519:encrypt",
    (_, sharedSecret: string, plaintext: string) => {
      return encrypt(sharedSecret, plaintext);
    },
  );

  ipcMain.handle(
    "x25519:decrypt",
    (_, sharedSecret: string, encryptedMessage) => {
      return decrypt(sharedSecret, encryptedMessage);
    },
  );

  ipcMain.handle("ed25519:generateSigningKeyPair", () => {
    return generateSigningKeyPair();
  });

  ipcMain.handle(
    "ed25519:signMessage",
    (_, privateKey: string, message: string) => {
      return signMessage(privateKey, message);
    },
  );
}
