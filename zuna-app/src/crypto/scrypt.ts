import crypto from "crypto";

function deriveKeyFromPassword(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 32, {
    N: 2 ** 14,
    r: 8,
    p: 1,
  });
}

export function encryptWithPassword(
  plaintext: string,
  password: string,
): Buffer {
  const salt = crypto.randomBytes(16);
  const key = deriveKeyFromPassword(password, salt);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, tag, encrypted]);
}

export function decryptWithPassword(data: Buffer, password: string): string {
  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 28);
  const tag = data.subarray(28, 44);
  const encrypted = data.subarray(44);

  const key = deriveKeyFromPassword(password, salt);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
