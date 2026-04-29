import { scrypt } from '@noble/hashes/scrypt';
import { textToBytes } from './base64';

// Identical parameters to Electron zuna-app: N=16384, r=8, p=1, dkLen=32
export function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(textToBytes(password), salt, { N: 16384, r: 8, p: 1, dkLen: 32 });
}
