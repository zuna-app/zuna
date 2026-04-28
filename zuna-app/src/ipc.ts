import { BrowserWindow, ipcMain } from "electron";
import http from "http";
import os from "os";
import crypto from "crypto";
import { toBase64, fromBase64 } from "./crypto/base64";
import { registerOgIPC } from "./og-ipc";
import { registerShellIPC } from "./shell-ipc";
import {
  computeSharedSecret,
  decrypt,
  encrypt,
  generateEncryptionKeyPair,
} from "./crypto/x25519";
import {
  generateSigningKeyPair,
  signMessage,
  verifySignature,
} from "./crypto/ed25519";
import { decryptWithPassword, encryptWithPassword } from "./crypto/scrypt";
import {
  getVaultBytes,
  importVault,
  isFirstTimeSetup,
  loadAndUnlockVault,
  lockVault,
  vaultDelete,
  vaultGet,
  vaultSet,
  verifyPin,
} from "./storage/safeVault";
import { decryptFile, encryptFile } from "./crypto/file";
import { getCacheByName } from "./storage/appCache";
import {
  startGatewayListeners,
  stopGatewayListeners,
} from "./gateway/gatewayListener";

let exportServer: http.Server | null = null;

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of (nets[name] ?? [])) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

export function registerIPC() {
  registerOgIPC();
  registerShellIPC();

  ipcMain.handle(
    "file:encryptFile",
    (_, data: Uint8Array, receiverPublicKey: string) => {
      return new Uint8Array(encryptFile(Buffer.from(data), receiverPublicKey));
    },
  );

  ipcMain.handle(
    "file:decryptFile",
    (_, data: Uint8Array, senderPublicKey: string) => {
      return new Uint8Array(decryptFile(Buffer.from(data), senderPublicKey));
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

  ipcMain.handle(
    "ed25519:verifySignature",
    (_, publicKey: string, serverId: string, signature: string) => {
      return verifySignature(publicKey, serverId, signature);
    },
  );

  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    if (win) {
      if (process.platform === "linux") {
        win.hide();
      } else {
        win.minimize();
      }
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

  ipcMain.handle("cache:get", (_, name: string, key: string) => {
    const cache = getCacheByName(name);
    return cache ? cache.get(key) : null;
  });

  ipcMain.handle(
    "cache:set",
    (_, name: string, key: string, value: unknown) => {
      const cache = getCacheByName(name);
      if (cache) cache.set(key, value);
    },
  );

  ipcMain.handle("vault:startExportServer", (_, pin: string) => {
    if (!verifyPin(pin)) return null;

    const vaultBytes = getVaultBytes();
    if (!vaultBytes) return null;

    if (exportServer) {
      exportServer.close();
      exportServer = null;
    }

    const token = String(crypto.randomInt(100000, 999999));
    const localIp = getLocalIp();

    return new Promise<{ url: string } | null>((resolve) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        if (
          url.pathname === "/download" &&
          url.searchParams.get("token") === token
        ) {
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="vault.bin"',
          );
          res.end(vaultBytes);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      exportServer = server;

      server.listen(25512, "0.0.0.0", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          resolve(null);
          return;
        }
        const url = `http://${localIp}:${addr.port}/download?token=${token}`;
        resolve({ url });
      });

      server.on("error", () => resolve(null));
    });
  });

  ipcMain.handle("vault:stopExportServer", () => {
    if (exportServer) {
      exportServer.close();
      exportServer = null;
    }
    return true;
  });
}
