import crypto from "crypto";

// ─── Ed25519 (signing) ────────────────────────────────────────────────────────

export function generateSigningKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicSpki = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  // SPKI DER for ed25519 is 44 bytes: 12-byte ASN.1 header + 32-byte raw key.
  // The Go server's ed25519.Verify expects the raw 32-byte key.
  const publicRaw = publicSpki.subarray(12);
  return {
    publicKey: publicRaw.toString("base64"),
    privateKey: privateDer.toString("base64"),
  };
}

export function signMessage(privateKeyB64, nonce) {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(
    null,
    Buffer.from(nonce, "utf8"),
    privateKeyObj,
  );
  return signature.toString("base64");
}

// ─── X25519 (ECDH) ────────────────────────────────────────────────────────────

export function generateEncryptionKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    publicKey: publicDer.toString("base64"),
    privateKey: privateDer.toString("base64"),
  };
}

export function computeSharedSecret(privateKeyB64, publicKeyB64) {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyObj = crypto.createPublicKey({
    key: Buffer.from(publicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKeyObj,
    publicKey: publicKeyObj,
  });
  return sharedSecret.toString("base64");
}

// ─── AES-256-GCM ─────────────────────────────────────────────────────────────

export function encrypt(sharedSecretB64, plaintext) {
  const key = Buffer.from(sharedSecretB64, "base64");
  if (key.length !== 32) throw new Error("Shared secret must be 32 bytes");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const ciphertextBuf = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertextBuf.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decrypt(sharedSecretB64, { ciphertext, iv, authTag }) {
  const key = Buffer.from(sharedSecretB64, "base64");
  const ivBuf = Buffer.from(iv, "base64");
  const authTagBuf = Buffer.from(authTag, "base64");
  const ciphertextBuf = Buffer.from(ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBuf, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTagBuf);
  return Buffer.concat([
    decipher.update(ciphertextBuf),
    decipher.final(),
  ]).toString("utf8");
}
