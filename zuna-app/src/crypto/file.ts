import { vaultGet } from "@/storage/safeVault";
import crypto from "crypto";
import { computeSharedSecret } from "./x25519";

export function encryptFile(data: Buffer, receiverPublicKey: string): Buffer {
  const privateKey = vaultGet("encPrivateKey");
  if (!privateKey) {
    throw new Error("Encryption private key not found in vault");
  }

  const sharedSecretB64 = computeSharedSecret(privateKey, receiverPublicKey);
  const key = Buffer.from(sharedSecretB64, "base64");

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]);
}

export function decryptFile(data: Buffer, senderPublicKey: string): Buffer {
  const privateKey = vaultGet("encPrivateKey");
  if (!privateKey) {
    throw new Error("Encryption private key not found in vault");
  }

  const sharedSecretB64 = computeSharedSecret(privateKey, senderPublicKey);
  const key = Buffer.from(sharedSecretB64, "base64");

  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
