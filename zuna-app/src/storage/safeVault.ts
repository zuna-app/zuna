import { app } from "electron";
import fs from "fs";
import path from "path";
import { decryptWithPassword, encryptWithPassword } from "@/crypto/scrypt";
import {
  startGatewayListeners,
  stopGatewayListeners,
} from "@/gateway/gatewayListener";

let vault: Map<string, any> | null = null;
let currentPassword: string | null = null;

const vaultPath = path.join(app.getPath("userData"), "vault.bin");

let dirty = false;
let saveTimer: NodeJS.Timeout | null = null;
const SAVE_DEBOUNCE_MS = 800;

function scheduleSave() {
  if (!vault || !currentPassword) return;

  dirty = true;

  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    flushSave();
  }, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  if (!vault || !currentPassword || !dirty) return;

  const obj: Record<string, string> = {};

  for (const [k, v] of vault) {
    if (Buffer.isBuffer(v)) {
      obj[k] = JSON.stringify({ __type: "Buffer", data: v.toString("base64") });
    } else {
      obj[k] = JSON.stringify({ __type: "json", data: v });
    }
  }

  const encrypted = encryptWithPassword(JSON.stringify(obj), currentPassword);

  const tmpPath = vaultPath + ".tmp";
  fs.writeFileSync(tmpPath, encrypted, { mode: 0o600 });
  fs.renameSync(tmpPath, vaultPath);

  dirty = false;
}

export function loadAndUnlockVault(password: string) {
  currentPassword = password;

  if (!fs.existsSync(vaultPath)) {
    vault = new Map();
    return;
  }

  const encryptedBlob = fs.readFileSync(vaultPath);
  const decrypted = decryptWithPassword(encryptedBlob, password);
  const parsed = JSON.parse(decrypted);

  console.log(parsed);

  vault = new Map(
    Object.entries(parsed).map(([k, v]) => {
      const entry = JSON.parse(v as string);
      if (entry.__type === "Buffer") {
        return [k, Buffer.from(entry.data as string, "base64")];
      }
      return [k, entry.data];
    }),
  );

  startGatewayListeners();
}

export function lockVault() {
  flushSave();

  if (!vault) return;

  for (const [, value] of vault) {
    if (Buffer.isBuffer(value)) value.fill(0);
  }

  vault.clear();
  vault = null;
  currentPassword = null;

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  stopGatewayListeners();
}

export function vaultGet(key: string): any {
  if (!vault) throw new Error("Vault locked");

  const val = vault.get(key);
  if (val === undefined) return null;

  if (Buffer.isBuffer(val)) return Buffer.from(val);
  return val;
}

export function vaultSet(key: string, value: any) {
  if (!vault) throw new Error("Vault locked");

  vault.set(key, Buffer.isBuffer(value) ? Buffer.from(value) : value);
  scheduleSave();
}

export function vaultDelete(key: string) {
  if (!vault) throw new Error("Vault locked");

  const val = vault.get(key);
  if (val) val.fill(0);

  vault.delete(key);
  scheduleSave();
}

export function importVault(data: Buffer): void {
  const tmpPath = vaultPath + ".tmp";
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  fs.renameSync(tmpPath, vaultPath);
}

export function isFirstTimeSetup(): boolean {
  return !fs.existsSync(vaultPath);
}
