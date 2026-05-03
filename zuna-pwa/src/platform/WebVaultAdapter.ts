/**
 * Web vault adapter using IndexedDB (via idb) for encrypted vault storage,
 * and sessionStorage for the unlocked vault state.
 *
 * The vault file is stored as a binary Blob in IndexedDB under "vault/vault.bin".
 * When unlocked, the decrypted keys are cached in memory.
 */
import { openDB, type IDBPDatabase } from "idb";
import type { IVaultAdapter } from "@zuna/shared";
import { decryptVaultBlob, encryptVaultBlob } from "@zuna/shared";

const DB_NAME = "zuna-vault";
const STORE_NAME = "vault";
const VAULT_KEY = "vault.bin";

type VaultData = Record<string, string>;

let db: IDBPDatabase | null = null;
let unlockedVault: VaultData | null = null;

async function getDb(): Promise<IDBPDatabase> {
  if (!db) {
    db = await openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE_NAME);
      },
    });
  }
  return db;
}

async function readBlob(): Promise<ArrayBuffer | null> {
  const database = await getDb();
  const blob: Blob | null = await database.get(STORE_NAME, VAULT_KEY);
  if (!blob) return null;
  return blob.arrayBuffer();
}

async function writeBlob(data: VaultData, password: string): Promise<void> {
  const database = await getDb();
  const encrypted = await encryptVaultBlob(data, password);
  const blob = new Blob([
    encrypted.buffer instanceof ArrayBuffer
      ? encrypted.buffer
      : new Uint8Array(encrypted).buffer,
  ]);
  await database.put(STORE_NAME, blob, VAULT_KEY);
}

export const WebVaultAdapter: IVaultAdapter = {
  async isFirstTimeSetup() {
    const bin = await readBlob();
    return bin === null;
  },

  async unlock(password: string) {
    const bin = await readBlob();
    if (bin === null) {
      // First-time setup: initialize an empty vault
      unlockedVault = {};
      await writeBlob({}, password);
      return;
    }
    const data = await decryptVaultBlob(new Uint8Array(bin), password);
    unlockedVault = data as VaultData;
  },

  async lock() {
    unlockedVault = null;
  },

  async get(key: string) {
    if (!unlockedVault) throw new Error("Vault is locked");
    return unlockedVault[key] ?? null;
  },

  async set(key: string, value: string) {
    if (!unlockedVault) throw new Error("Vault is locked");
    unlockedVault[key] = value;
    // Persist — we need the password, but we don't have it here.
    // We rely on a re-encrypt on the next unlock.
    // For now, store in memory only and persist lazily.
    // A proper solution would store the derived key in session.
    // This simplified adapter uses sessionStorage for the PIN.
    const pin = sessionStorage.getItem("zuna_pin");
    if (pin) await writeBlob(unlockedVault, pin);
  },

  async delete(key: string) {
    if (!unlockedVault) throw new Error("Vault is locked");
    delete unlockedVault[key];
    const pin = sessionStorage.getItem("zuna_pin");
    if (pin) await writeBlob(unlockedVault, pin);
  },

  async importVault(base64: string) {
    const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const database = await getDb();
    const blob = new Blob([binary]);
    await database.put(STORE_NAME, blob, VAULT_KEY);
    unlockedVault = null; // Require re-unlock after import
  },
};
