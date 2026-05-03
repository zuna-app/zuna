import { gcm } from "@noble/ciphers/aes";
import { deriveKey } from "./scrypt";
import { bytesToText, textToBytes } from "./base64";

// Wire format (identical across all Zuna clients):
// [16 bytes salt][12 bytes IV][16 bytes auth tag][variable encrypted JSON]

function getRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function decryptVaultBlob(
  binary: Uint8Array,
  password: string,
): Record<string, unknown> {
  const salt = binary.slice(0, 16);
  const iv = binary.slice(16, 28);
  const tag = binary.slice(28, 44);
  const encrypted = binary.slice(44);

  const key = deriveKey(password, salt);

  // gcm expects ciphertext+tag concatenated
  const combined = new Uint8Array(encrypted.length + tag.length);
  combined.set(encrypted);
  combined.set(tag, encrypted.length);

  const cipher = gcm(key, iv);
  const jsonBytes = cipher.decrypt(combined);
  const jsonStr = bytesToText(jsonBytes);
  const raw: Record<string, string> = JSON.parse(jsonStr);

  // Deserialize vault entries — mirrors Electron serialization format
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      const parsed = JSON.parse(v) as { __type: string; data: unknown };
      if (parsed.__type === "Buffer" && typeof parsed.data === "string") {
        result[k] = parsed.data; // keep as base64 string
      } else if (parsed.__type === "json") {
        result[k] = parsed.data;
      } else {
        result[k] = v;
      }
    } catch {
      result[k] = v;
    }
  }
  return result;
}

export function encryptVaultBlob(
  data: Record<string, unknown>,
  password: string,
): Uint8Array {
  const salt = getRandomBytes(16);
  const iv = getRandomBytes(12);
  const key = deriveKey(password, salt);

  const serialized: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string") {
      serialized[k] = JSON.stringify({ __type: "Buffer", data: v });
    } else {
      serialized[k] = JSON.stringify({ __type: "json", data: v });
    }
  }

  const cipher = gcm(key, iv);
  const encrypted = cipher.encrypt(textToBytes(JSON.stringify(serialized)));
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);

  const result = new Uint8Array(16 + 12 + 16 + ciphertext.length);
  result.set(salt, 0);
  result.set(iv, 16);
  result.set(tag, 28);
  result.set(ciphertext, 44);
  return result;
}

/**
 * Encrypt an arbitrary string (e.g. pre-serialized JSON) with a password.
 * Uses the same wire format as encryptVaultBlob:
 * [16 bytes salt][12 bytes IV][16 bytes auth tag][ciphertext]
 */
export function encryptWithPassword(
  plaintext: string,
  password: string,
): Uint8Array {
  const salt = getRandomBytes(16);
  const iv = getRandomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = gcm(key, iv);
  const encrypted = cipher.encrypt(textToBytes(plaintext));
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);
  const result = new Uint8Array(44 + ciphertext.length);
  result.set(salt, 0);
  result.set(iv, 16);
  result.set(tag, 28);
  result.set(ciphertext, 44);
  return result;
}

/**
 * Decrypt a blob previously encrypted with encryptWithPassword.
 * Returns the original plaintext string.
 */
export function decryptWithPassword(
  data: Uint8Array,
  password: string,
): string {
  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const tag = data.slice(28, 44);
  const ciphertext = data.slice(44);
  const key = deriveKey(password, salt);
  const combined = new Uint8Array(ciphertext.length + 16);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const cipher = gcm(key, iv);
  const bytes = cipher.decrypt(combined);
  return bytesToText(bytes);
}
