import * as FileSystem from 'expo-file-system/legacy';
import { decryptVaultBlob, encryptVaultBlob } from './crypto/vault-crypto';
import { getSessionPin, setSessionPin, clearSession } from './keychain';

const VAULT_PATH = `${FileSystem.documentDirectory}vault.bin`;

export type VaultMap = Record<string, unknown>;

export async function isVaultImported(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(VAULT_PATH);
  return info.exists;
}

export async function importVault(binary: Uint8Array): Promise<void> {
  // Write as base64 since expo-file-system works with strings
  const b64 = uint8ArrayToBase64(binary);
  await FileSystem.writeAsStringAsync(VAULT_PATH, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

export async function importVaultFromBase64(b64: string): Promise<void> {
  await FileSystem.writeAsStringAsync(VAULT_PATH, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

export async function unlockVault(pin: string): Promise<VaultMap> {
  const b64 = await FileSystem.readAsStringAsync(VAULT_PATH, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = base64ToUint8Array(b64);
  const vaultMap = decryptVaultBlob(binary, pin);
  // Persist PIN to secure store for session auto-unlock
  await setSessionPin(pin);
  return vaultMap;
}

export async function unlockVaultWithSession(): Promise<VaultMap | null> {
  const pin = await getSessionPin();
  if (!pin) return null;
  try {
    return await unlockVault(pin);
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
  const b64 = uint8ArrayToBase64(binary);
  await FileSystem.writeAsStringAsync(VAULT_PATH, b64, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
