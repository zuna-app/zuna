import { ed25519 } from "@noble/curves/ed25519";
import {
  base64ToBytes,
  bytesToBase64,
  rawFromPkcs8,
  textToBytes,
} from "./base64";

export interface SigningKeyPair {
  publicKey: string;
  privateKey: string;
}

// PKCS8 DER header for Ed25519: OID 1.3.101.112
const ED25519_PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

/**
 * Generate an Ed25519 signing key pair.
 * Public key is exported as raw 32 bytes (no DER header) for Go compatibility.
 * Private key is exported in PKCS8 DER format (base64).
 */
export function generateSigningKeyPair(): SigningKeyPair {
  const privRaw = ed25519.utils.randomPrivateKey();
  const pubRaw = ed25519.getPublicKey(privRaw);

  const privateKeyDer = new Uint8Array(ED25519_PKCS8_HEADER.length + 32);
  privateKeyDer.set(ED25519_PKCS8_HEADER);
  privateKeyDer.set(privRaw, ED25519_PKCS8_HEADER.length);

  return {
    publicKey: bytesToBase64(pubRaw), // raw 32 bytes — no header
    privateKey: bytesToBase64(privateKeyDer),
  };
}

export function signMessage(sigPrivateKeyB64: string, nonce: string): string {
  const privBytes = rawFromPkcs8(sigPrivateKeyB64);
  const sig = ed25519.sign(textToBytes(nonce), privBytes);
  return bytesToBase64(sig);
}

export function verifySignature(
  sigPublicKeyB64: string,
  serverId: string,
  signatureB64: string,
): boolean {
  try {
    const pubBytes = base64ToBytes(sigPublicKeyB64);
    const sigBytes = base64ToBytes(signatureB64);
    return ed25519.verify(sigBytes, textToBytes(serverId), pubBytes);
  } catch {
    return false;
  }
}
