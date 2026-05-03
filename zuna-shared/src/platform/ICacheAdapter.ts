/**
 * Cache adapter — lightweight persistent JSON cache by name + key.
 * Implementations: ElectronCacheAdapter (wraps IPC), WebCacheAdapter (localStorage).
 */
export interface ICacheAdapter {
  get<T = unknown>(cacheName: string, key: string): Promise<T | null>;
  set<T = unknown>(cacheName: string, key: string, value: T): Promise<void>;
}
