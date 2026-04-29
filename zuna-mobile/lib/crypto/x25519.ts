import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { base64ToBytes, bytesToBase64, rawFromPkcs8, rawFromSpki, textToBytes, bytesToText } from './base64';

export interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function getRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

// identityKey from the server may be SPKI DER (44 bytes → 12-byte header + 32 raw)
// or raw 32 bytes. Detect by length after base64 decode.
function extractPublicKeyBytes(b64: string): Uint8Array {
  const raw = base64ToBytes(b64);
  if (raw.length === 44) return rawFromSpki(b64);
  return raw; // already 32 raw bytes
}

export function computeSharedSecret(encPrivateKeyB64: string, identityKeyB64: string): string {
  const privBytes = rawFromPkcs8(encPrivateKeyB64);
  const pubBytes = extractPublicKeyBytes(identityKeyB64);
  const shared = x25519.getSharedSecret(privBytes, pubBytes);
  return bytesToBase64(shared);
}

export function encrypt(sharedSecretB64: string, plaintext: string): EncryptedMessage {
  const key = base64ToBytes(sharedSecretB64);
  const iv = getRandomBytes(12);
  const cipher = gcm(key, iv);
  const encrypted = cipher.encrypt(textToBytes(plaintext));
  // @noble/ciphers gcm appends the 16-byte tag at the end of the encrypted output
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const authTag = encrypted.slice(encrypted.length - 16);
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
  };
}

export function decrypt(sharedSecretB64: string, msg: EncryptedMessage): string {
  const key = base64ToBytes(sharedSecretB64);
  const iv = base64ToBytes(msg.iv);
  const ciphertext = base64ToBytes(msg.ciphertext);
  const tag = base64ToBytes(msg.authTag);
  // gcm expects ciphertext+tag concatenated
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const cipher = gcm(key, iv);
  const plaintext = cipher.decrypt(combined);
  return bytesToText(plaintext);
}
