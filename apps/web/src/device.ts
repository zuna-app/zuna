// This browser's device key. Browsers have no keychain a page can use, so it sits
// in IndexedDB, and the Security screen says what that means.

const DATABASE = "zuna";
const STORE = "device";
const KEY = "key";
/** Where packages/ui/src/core/sqlite.ts keeps the database, in the origin-private file system. */
const DATABASE_FOLDER = ".zuna-db";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("This browser's storage isn't available."));
  });
}

/** The 32-byte key, made the first time and kept from then on, and whether it was just made. */
export async function loadDeviceKey(): Promise<{ key: Uint8Array; created: boolean }> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      // Reading and creating it in one transaction, so there's only ever one.
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      let key: Uint8Array;
      let created = false;
      const read = store.get(KEY);
      read.onsuccess = () => {
        const stored = read.result as unknown;
        if (stored instanceof Uint8Array && stored.length === 32) {
          key = stored;
        } else {
          key = crypto.getRandomValues(new Uint8Array(32));
          created = true;
          store.put(key, KEY);
        }
      };
      transaction.oncomplete = () => resolve({ key, created });
      transaction.onerror = () => reject(transaction.error ?? new Error("This browser's storage isn't available."));
      transaction.onabort = () => reject(transaction.error ?? new Error("This browser's storage isn't available."));
    });
  } finally {
    db.close();
  }
}

/**
 * Removes a database a new key can't read, as when only some of the site's data
 * was cleared. Without this the app couldn't start at all. Signing in again
 * brings the history back from the vault.
 */
export async function removeUnreadableDatabase(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DATABASE_FOLDER, { recursive: true });
  } catch {
    // Usually there's nothing there.
  }
}

/** What Devices calls this browser, such as "Firefox on macOS". */
export function deviceName(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  // An iPhone says it's "like Mac OS X", and Android says it's Linux.
  const system = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Mac OS X|Macintosh/.test(agent)
      ? "macOS"
      : /Windows/.test(agent)
        ? "Windows"
        : /Android/.test(agent)
          ? "Android"
          : /Linux|X11/.test(agent)
            ? "Linux"
            : null;
  return system ? `${browser} on ${system}` : browser;
}
