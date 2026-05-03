import { BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "fs/promises";
import https from "https";
import os from "os";
import crypto from "crypto";
import forge from "node-forge";
import { registerOgIPC } from "./og-ipc";
import { registerShellIPC } from "./shell-ipc";
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
import { getCacheByName } from "./storage/appCache";

let exportServer: https.Server | null = null;

function isIPv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function generateEphemeralTlsCert(pcIp: string): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString("hex");

  const now = Date.now();
  cert.validity.notBefore = new Date(now - 60_000);
  cert.validity.notAfter = new Date(now + 24 * 60 * 60 * 1000);

  const subject = [
    { name: "commonName", value: "zuna-local-export" },
    { name: "organizationName", value: "Zuna" },
  ];

  cert.setSubject(subject);
  cert.setIssuer(subject);

  const altNames: Array<{ type: number; value?: string; ip?: string }> = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ];

  if (
    pcIp &&
    isIPv4(pcIp) &&
    !altNames.some((name) => name.type === 7 && name.ip === pcIp)
  ) {
    altNames.push({ type: 7, ip: pcIp });
  }

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

function getLocalIp(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
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
    const tlsCredentials = generateEphemeralTlsCert(localIp);

    return new Promise<{ url: string } | null>((resolve) => {
      const server = https.createServer(tlsCredentials, (req, res) => {
        if (!(req.socket as import("tls").TLSSocket).encrypted) {
          res.writeHead(400);
          res.end("TLS required");
          return;
        }

        const url = new URL(req.url ?? "/", "https://localhost");
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
        const url = `https://${localIp}:${addr.port}/download?token=${token}`;
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

  ipcMain.handle("vault:saveExportFile", async (event, pin: string) => {
    if (!verifyPin(pin)) {
      return { ok: false as const, reason: "invalid_pin" as const };
    }

    const vaultBytes = getVaultBytes();
    if (!vaultBytes) {
      return { ok: false as const, reason: "no_vault" as const };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      title: "Save Vault Export",
      defaultPath: "vault.bin",
      filters: [
        { name: "Vault file", extensions: ["bin"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

    if (canceled || !filePath) {
      return { ok: false as const, reason: "cancelled" as const };
    }

    await writeFile(filePath, vaultBytes);
    return { ok: true as const, path: filePath };
  });
}
