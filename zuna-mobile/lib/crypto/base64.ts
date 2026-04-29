export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Extract 32 raw bytes from a PKCS8 DER key (16-byte header + 32-byte key)
export function rawFromPkcs8(b64: string): Uint8Array {
  return base64ToBytes(b64).slice(16);
}

// Extract 32 raw bytes from a SPKI DER key (12-byte header + 32-byte key)
export function rawFromSpki(b64: string): Uint8Array {
  return base64ToBytes(b64).slice(12);
}
