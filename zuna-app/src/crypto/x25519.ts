import crypto from "crypto";

export interface EncryptionKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function generateEncryptionKeyPair(): EncryptionKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");

  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });

  return {
    publicKey: publicDer.toString("base64"),
    privateKey: privateDer.toString("base64"),
  };
}

export function computeSharedSecret(
  privateKey: string,
  publicKey: string,
): string {
  const privateDer = Buffer.from(privateKey, "base64");
  const publicDer = Buffer.from(publicKey, "base64");
  const privateKeyObj = crypto.createPrivateKey({
    key: privateDer,
    format: "der",
    type: "pkcs8",
  });
  const publicKeyObj = crypto.createPublicKey({
    key: publicDer,
    format: "der",
    type: "spki",
  });
  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKeyObj,
    publicKey: publicKeyObj,
  });
  return sharedSecret.toString("base64");
}

export function encrypt(
  sharedSecret: string,
  plaintext: string,
): EncryptedMessage {
  const key = Buffer.from(sharedSecret, "base64");

  if (key.length !== 32) {
    throw new Error("Key must be 32 bytes (base64-encoded)");
  }

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decrypt(
  sharedSecret: string,
  encryptedMessage: EncryptedMessage,
): string {
  const key = Buffer.from(sharedSecret, "base64");
  const iv = Buffer.from(encryptedMessage.iv, "base64");
  const authTag = Buffer.from(encryptedMessage.authTag, "base64");
  const ciphertext = Buffer.from(encryptedMessage.ciphertext, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
