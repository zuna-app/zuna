import { ed25519 } from '@noble/curves/ed25519';
import { base64ToBytes, bytesToBase64, rawFromPkcs8, textToBytes } from './base64';

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
    // sigPublicKey is stored as raw 32 bytes (header already stripped in Electron)
    const pubBytes = base64ToBytes(sigPublicKeyB64);
    const sigBytes = base64ToBytes(signatureB64);
    return ed25519.verify(sigBytes, textToBytes(serverId), pubBytes);
  } catch {
    return false;
  }
}
