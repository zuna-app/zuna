/// <reference types="vite/client" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

interface Window {
  security: {
    encryptFile: (data: Buffer, receiverPublicKey: string) => Promise<Buffer>;
    decryptFile: (data: Buffer, senderPublicKey: string) => Promise<Buffer>;
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
  env: {
    platform: string;
  };
  system: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  };
  vault: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    delete: (key: string) => Promise<void>;
    lock: () => Promise<void>;
    unlock: (password: string) => Promise<void>;
    isFirstTimeSetup: () => Promise<boolean>;
    import: (base64Data: string) => Promise<boolean>;
  };
}
