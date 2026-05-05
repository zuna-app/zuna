import * as FileSystem from 'expo-file-system/legacy';
import { base64ToBytes, bytesToBase64 } from './crypto/base64';
import { decryptVaultBlob, decryptVaultBlobWithKey, encryptVaultBlob } from './crypto/vault-crypto';
import { deriveKey } from './crypto/scrypt';
import {
  getSessionPin,
  setSessionPin,
  clearSession,
  getSessionDerivedKey,
  setSessionDerivedKey,
} from './keychain';

const VAULT_PATH = `${FileSystem.documentDirectory}vault.bin`;

export type VaultMap = Record<string, unknown>;

export async function isVaultImported(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(VAULT_PATH);
  return info.exists;
}

export async function importVault(binary: Uint8Array): Promise<void> {
  // Write as base64 since expo-file-system works with strings
  const b64 = bytesToBase64(binary);
  await FileSystem.writeAsStringAsync(VAULT_PATH, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

export async function importVaultFromBase64(b64: string): Promise<void> {
  await FileSystem.writeAsStringAsync(VAULT_PATH, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

type UnlockVaultOptions = {
  persistSessionPin?: boolean;
};

async function readVaultBinary(): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(VAULT_PATH, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return base64ToBytes(b64);
}

async function cacheSessionDerivedKey(pin: string, vaultBinary: Uint8Array): Promise<void> {
  const salt = vaultBinary.slice(0, 16);
  const derivedKey = deriveKey(pin, salt);
  await setSessionDerivedKey(bytesToBase64(derivedKey));
}

export async function unlockVault(pin: string, options?: UnlockVaultOptions): Promise<VaultMap> {
  const binary = await readVaultBinary();
  const vaultMap = decryptVaultBlob(binary, pin);

  if (options?.persistSessionPin !== false) {
    // Persist PIN and derived key to secure storage for faster session auto-unlock.
    await Promise.all([setSessionPin(pin), cacheSessionDerivedKey(pin, binary)]);
  }

  return vaultMap;
}

export async function unlockVaultWithSession(): Promise<VaultMap | null> {
  const [pin, cachedDerivedKeyB64] = await Promise.all([getSessionPin(), getSessionDerivedKey()]);
  if (!pin) return null;

  try {
    const binary = await readVaultBinary();

    if (cachedDerivedKeyB64) {
      try {
        const cachedDerivedKey = base64ToBytes(cachedDerivedKeyB64);
        return decryptVaultBlobWithKey(binary, cachedDerivedKey);
      } catch {
        // Fall through to PIN-based decrypt, then refresh derived-key cache.
      }
    }

    const vault = decryptVaultBlob(binary, pin);
    await cacheSessionDerivedKey(pin, binary);
    return vault;
  } catch {
    await clearSession();
    return null;
  }
}

export async function lockVault(): Promise<void> {
  await clearSession();
}

export async function saveVaultChange(vaultMap: VaultMap, pin: string): Promise<void> {
  const binary = encryptVaultBlob(vaultMap, pin);
  const b64 = bytesToBase64(binary);
  await FileSystem.writeAsStringAsync(VAULT_PATH, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Rotation changes salt, so refresh cached session derived key.
  await cacheSessionDerivedKey(pin, binary);
}
