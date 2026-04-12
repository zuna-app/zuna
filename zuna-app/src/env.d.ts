/// <reference types="vite/client" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

interface Window {
  security: {
    encode: (str: string) => Promise<string>;
    decode: (base64: string) => Promise<string>;
    generateEncryptionKeyPair: () => Promise<{
      publicKey: string;
      privateKey: string;
    }>;
    computeSharedSecret: (
      privateKey: string,
      publicKey: string,
    ) => Promise<string>;
    encrypt: (sharedSecret: string, plaintext: string) => Promise<string>;
    decrypt: (
      sharedSecret: string,
      encryptedMessage: string,
    ) => Promise<string>;
    generateSigningKeyPair: () => Promise<{
      publicKey: string;
      privateKey: string;
    }>;
    signMessage: (privateKey: string, message: string) => Promise<string>;
  };
}
