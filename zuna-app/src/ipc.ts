import { BrowserWindow, ipcMain } from "electron";
import { toBase64, fromBase64 } from "./crypto/base64";
import { registerOgIPC } from "./og-ipc";
import { registerShellIPC } from "./shell-ipc";
import {
  computeSharedSecret,
  decrypt,
  encrypt,
  generateEncryptionKeyPair,
} from "./crypto/x25519";
import { generateSigningKeyPair, signMessage } from "./crypto/ed25519";
import { decryptWithPassword, encryptWithPassword } from "./crypto/scrypt";
import {
  importVault,
  isFirstTimeSetup,
  loadAndUnlockVault,
  lockVault,
  vaultDelete,
  vaultGet,
  vaultSet,
} from "./storage/safeVault";
import { decryptFile, encryptFile } from "./crypto/file";

export function registerIPC() {
  registerOgIPC();
  registerShellIPC();

  ipcMain.handle(
    "file:encryptFile",
    (_, data: Buffer, receiverPublicKey: string) => {
      return encryptFile(data, receiverPublicKey);
    },
  );

  ipcMain.handle(
    "file:decryptFile",
    (_, data: Buffer, senderPublicKey: string) => {
      return decryptFile(data, senderPublicKey);
    },
  );

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

  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (win) {
      win.minimize();
    }
  });

  ipcMain.handle("window:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (win) {
      win.close();
    }
  });

  ipcMain.handle("vault:unlock", (_, password: string) => {
    loadAndUnlockVault(password);
    return true;
  });

  ipcMain.handle("vault:lock", () => {
    lockVault();
    return true;
  });

  ipcMain.handle("vault:set", (_, key: string, value: any) => {
    vaultSet(key, value);
    return true;
  });

  ipcMain.handle("vault:get", (_, key: string) => {
    const val = vaultGet(key);
    if (Buffer.isBuffer(val)) {
      return val.toString("base64");
    }
    return val;
  });

  ipcMain.handle("vault:delete", (_, key: string) => {
    vaultDelete(key);
    return true;
  });

  ipcMain.handle("vault:isFirstTimeSetup", () => {
    return isFirstTimeSetup();
  });

  ipcMain.handle("vault:import", (_, base64Data: string) => {
    importVault(Buffer.from(base64Data, "base64"));
    return true;
  });
}
