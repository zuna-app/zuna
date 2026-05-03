/**
 * Vault adapter — manages encrypted key/value storage.
 * Implementations: ElectronVaultAdapter (wraps IPC), WebVaultAdapter (IndexedDB).
 */
export interface IVaultAdapter {
  isFirstTimeSetup(): Promise<boolean>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  importVault(base64Bytes: string): Promise<void>;

  /**
   * Optional — Electron-only vault export capabilities.
   * Components should check `vault.export !== undefined` before using.
   */
  export?: {
    startServer(pin: string): Promise<{ url: string } | null>;
    stopServer(): Promise<void>;
    saveFile(pin: string): Promise<{ ok: boolean; reason?: string }>;
  };
}
