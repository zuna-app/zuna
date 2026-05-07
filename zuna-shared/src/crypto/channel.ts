import { gcm } from "@noble/ciphers/aes";
import {
  base64ToBytes,
  bytesToBase64,
  textToBytes,
  bytesToText,
} from "./base64";
import { computeSharedSecret, encrypt, decrypt } from "./x25519";
import type { EncryptedMessage } from "./x25519";

export type { EncryptedMessage };

function getRandomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/** Generate a random 32-byte AES-256 symmetric key for a channel. */
export function generateChannelKey(): string {
  return bytesToBase64(getRandomBytes(32));
}

/** Encrypt plaintext using a raw symmetric channel key (AES-256-GCM, no ECDH). */
export function encryptWithChannelKey(
  channelKeyB64: string,
  plaintext: string,
): EncryptedMessage {
  const key = base64ToBytes(channelKeyB64);
  const iv = getRandomBytes(12);
  const cipher = gcm(key, iv);
  const encrypted = cipher.encrypt(textToBytes(plaintext));
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const authTag = encrypted.slice(encrypted.length - 16);
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
  };
}

/** Decrypt a channel message using the raw symmetric channel key. */
export function decryptWithChannelKey(
  channelKeyB64: string,
  msg: EncryptedMessage,
): string {
  const key = base64ToBytes(channelKeyB64);
  const iv = base64ToBytes(msg.iv);
  const ciphertext = base64ToBytes(msg.ciphertext);
  const tag = base64ToBytes(msg.authTag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const cipher = gcm(key, iv);
  return bytesToText(cipher.decrypt(combined));
}

/**
 * Wrap (encrypt) a channel key for a specific recipient.
 * Reuses the existing X25519 ECDH + AES-GCM path so the recipient can
 * unwrap it with their own private key and the sender's public key.
 */
export function wrapChannelKey(
  ownPrivateKeyB64: string,
  recipientIdentityKeyB64: string,
  channelKeyB64: string,
): EncryptedMessage {
  const sharedSecret = computeSharedSecret(
    ownPrivateKeyB64,
    recipientIdentityKeyB64,
  );
  return encrypt(sharedSecret, channelKeyB64);
}

/** Unwrap a channel key that was wrapped for us. */
export function unwrapChannelKey(
  ownPrivateKeyB64: string,
  senderIdentityKeyB64: string,
  wrapped: EncryptedMessage,
): string {
  const sharedSecret = computeSharedSecret(
    ownPrivateKeyB64,
    senderIdentityKeyB64,
  );
  return decrypt(sharedSecret, wrapped);
}
