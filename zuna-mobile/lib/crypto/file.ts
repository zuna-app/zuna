import { gcm } from '@noble/ciphers/aes';
import { computeSharedSecret } from './x25519';
import { base64ToBytes, bytesToBase64 } from './base64';

// Wire format (identical to Electron zuna-app):
// [12 bytes IV][16 bytes auth tag][variable encrypted file data]

function getRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function encryptFile(
  data: Uint8Array,
  receiverIdentityKey: string,
  ownPrivateKey: string,
): Uint8Array {
  const sharedSecretB64 = computeSharedSecret(ownPrivateKey, receiverIdentityKey);
  const key = base64ToBytes(sharedSecretB64);
  const iv = getRandomBytes(12);
  const cipher = gcm(key, iv);
  const encrypted = cipher.encrypt(data);
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const tag = encrypted.slice(encrypted.length - 16);

  const result = new Uint8Array(12 + 16 + ciphertext.length);
  result.set(iv, 0);
  result.set(tag, 12);
  result.set(ciphertext, 28);
  return result;
}

export function decryptFile(
  data: Uint8Array,
  senderIdentityKey: string,
  ownPrivateKey: string,
): Uint8Array {
  const sharedSecretB64 = computeSharedSecret(ownPrivateKey, senderIdentityKey);
  const key = base64ToBytes(sharedSecretB64);
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const ciphertext = data.slice(28);

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const cipher = gcm(key, iv);
  return cipher.decrypt(combined);
}
