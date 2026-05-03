/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope;

// Take control immediately on update
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigation fallback — serve index.html for all page navigations except
// API and WebSocket routes. Avoids createHandlerBoundToURL which requires
// index.html to be in the precache manifest (fails in dev).
registerRoute(
  ({ request }) =>
    request.mode === "navigate" &&
    !request.url.includes("/api/") &&
    !request.url.includes("/ws/"),
  async () => {
    const cached = await caches.match("/index.html");
    return cached ?? fetch("/index.html");
  },
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface Server {
  id: string;
  address: string;
  name: string;
  username: string;
  publicKey: string | null;
  serverId: string | null;
}

interface VaultKeys {
  encPrivateKey: string; // PKCS8 DER base64 X25519 private key
  serverList: Server[];
}

interface CachedUserInfo {
  username?: string;
  avatar?: string;
}

type UserCacheMap = Record<string, CachedUserInfo>;

interface NotificationPayload {
  type: string;
  server_id: string;
  sender_id: string;
  sender_identity_key: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  signature: string;
}

const VAULT_DB_NAME = "zuna-sw";
const VAULT_DB_VERSION = 1;
const VAULT_STORE_NAME = "state";
const VAULT_KEYS_RECORD_ID = "vault-keys";
const USER_CACHE_RECORD_ID = "user-cache";

// ── In-memory vault key cache ─────────────────────────────────────────────────
// Cleared when the SW is terminated; repopulated via postMessage on reconnect.

let vaultKeys: VaultKeys | null = null;
let userCache: UserCacheMap | null = null;

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
        db.createObjectStore(VAULT_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("failed to open indexeddb"));
  });
}

async function persistVaultKeys(keys: VaultKeys): Promise<void> {
  const db = await openVaultDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE_NAME, "readwrite");
      tx.objectStore(VAULT_STORE_NAME).put(keys, VAULT_KEYS_RECORD_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("failed to persist vault keys"));
    });
  } finally {
    db.close();
  }
}

async function clearPersistedVaultKeys(): Promise<void> {
  const db = await openVaultDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE_NAME, "readwrite");
      tx.objectStore(VAULT_STORE_NAME).delete(VAULT_KEYS_RECORD_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("failed to clear vault keys"));
    });
  } finally {
    db.close();
  }
}

async function loadPersistedVaultKeys(): Promise<VaultKeys | null> {
  const db = await openVaultDb();
  try {
    return await new Promise<VaultKeys | null>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE_NAME, "readonly");
      const req = tx.objectStore(VAULT_STORE_NAME).get(VAULT_KEYS_RECORD_ID);
      req.onsuccess = () =>
        resolve((req.result as VaultKeys | undefined) ?? null);
      req.onerror = () =>
        reject(req.error ?? new Error("failed to read vault keys"));
    });
  } finally {
    db.close();
  }
}

async function persistUserCache(users: UserCacheMap): Promise<void> {
  const db = await openVaultDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE_NAME, "readwrite");
      tx.objectStore(VAULT_STORE_NAME).put(users, USER_CACHE_RECORD_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error("failed to persist user cache"));
    });
  } finally {
    db.close();
  }
}

async function loadPersistedUserCache(): Promise<UserCacheMap | null> {
  const db = await openVaultDb();
  try {
    return await new Promise<UserCacheMap | null>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE_NAME, "readonly");
      const req = tx.objectStore(VAULT_STORE_NAME).get(USER_CACHE_RECORD_ID);
      req.onsuccess = () =>
        resolve((req.result as UserCacheMap | undefined) ?? null);
      req.onerror = () =>
        reject(req.error ?? new Error("failed to read user cache"));
    });
  } finally {
    db.close();
  }
}

async function getUserCache(): Promise<UserCacheMap | null> {
  if (userCache) return userCache;
  try {
    userCache = await loadPersistedUserCache();
  } catch (err) {
    console.error("[SW] Failed to load persisted user cache:", err);
  }
  return userCache;
}

async function getVaultKeys(): Promise<VaultKeys | null> {
  if (vaultKeys) return vaultKeys;
  try {
    vaultKeys = await loadPersistedVaultKeys();
  } catch (err) {
    console.error("[SW] Failed to load persisted vault keys:", err);
  }
  return vaultKeys;
}

// ── Message handler (vault key exchange with main thread) ─────────────────────

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type: string; payload?: unknown } | null;
  if (!data) return;
  if (data.type === "VAULT_KEYS") {
    const keys = data.payload as VaultKeys;
    vaultKeys = keys;
    event.waitUntil(
      (async () => {
        try {
          await persistVaultKeys(keys);
        } catch (err) {
          console.error("[SW] Failed to persist vault keys:", err);
        }
      })(),
    );
  } else if (data.type === "VAULT_LOCKED") {
    vaultKeys = null;
    event.waitUntil(
      (async () => {
        try {
          await clearPersistedVaultKeys();
        } catch (err) {
          console.error("[SW] Failed to clear persisted vault keys:", err);
        }
      })(),
    );
  } else if (data.type === "USER_CACHE") {
    const users = (data.payload as UserCacheMap | null) ?? {};
    userCache = users;
    event.waitUntil(
      (async () => {
        try {
          await persistUserCache(users);
        } catch (err) {
          console.error("[SW] Failed to persist user cache:", err);
        }
      })(),
    );
  }
});

// ── Push event handler ────────────────────────────────────────────────────────

self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  event.waitUntil(handlePush(event.data.text()));
});

async function handlePush(rawText: string): Promise<void> {
  let payload: NotificationPayload;
  try {
    payload = JSON.parse(rawText) as NotificationPayload;
  } catch {
    return;
  }

  if (payload.type !== "notification_info") return;

  const users = await getUserCache();
  const sender = users?.[payload.sender_id];
  const notificationTitle = sender?.username || "New Message";

  let body = "You have a new encrypted message";
  const keys = await getVaultKeys();

  if (keys) {
    try {
      const server = keys.serverList.find(
        (s) => s.serverId === payload.server_id,
      );

      // Verify the server's Ed25519 signature before decrypting
      if (server?.publicKey) {
        const valid = await verifyEd25519(
          server.publicKey,
          payload.server_id,
          payload.signature,
        );
        if (!valid) {
          console.warn("[SW] Notification signature invalid, discarding");
          return;
        }
      }

      body = await decryptNotification(keys.encPrivateKey, payload);
    } catch {
      // Decryption failed; fall back to generic body
    }
  }

  await self.registration.showNotification(notificationTitle, {
    body: sender?.avatar || "/pwa-192x192.png",
    icon: sender?.avatar || "/pwa-192x192.png",
    badge: "/pwa-64x64.png",
    data: {
      serverId: payload.server_id,
      senderId: payload.sender_id,
    },
  });
}

// ── Notification click handler ────────────────────────────────────────────────

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (windows.length > 0) {
        await windows[0].focus();
      } else {
        await self.clients.openWindow("/");
      }
    })(),
  );
});

// ── Crypto helpers (Web Crypto API — no external imports needed) ──────────────

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out as Uint8Array<ArrayBuffer>;
}

/**
 * Decrypt the notification body using X25519 ECDH + AES-256-GCM.
 * Keys are in the same PKCS8/SPKI DER formats used by the rest of the app.
 */
async function decryptNotification(
  encPrivKeyPkcs8B64: string,
  p: NotificationPayload,
): Promise<string> {
  // Import X25519 private key (PKCS8 DER)
  const privKey = await crypto.subtle.importKey(
    "pkcs8",
    b64ToBytes(encPrivKeyPkcs8B64),
    { name: "X25519" },
    false,
    ["deriveBits"],
  );

  // Import sender's X25519 public key — raw 32 bytes or SPKI DER (44 bytes)
  const senderPubBytes = b64ToBytes(p.sender_identity_key);
  const rawPub =
    senderPubBytes.length === 44 ? senderPubBytes.slice(12) : senderPubBytes;
  const pubKey = await crypto.subtle.importKey(
    "raw",
    rawPub,
    { name: "X25519" },
    false,
    [],
  );

  // Derive 32-byte shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: pubKey } as AlgorithmIdentifier,
    privKey,
    256,
  );

  // Import as AES-256-GCM key
  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  // Concatenate ciphertext + auth tag (matches @noble/ciphers wire format)
  const ct = b64ToBytes(p.cipher_text);
  const tag = b64ToBytes(p.auth_tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(p.iv), tagLength: 128 },
    aesKey,
    combined,
  );

  return new TextDecoder().decode(plaintext);
}

/** Verify an Ed25519 signature using the Web Crypto API. */
async function verifyEd25519(
  pubKeyB64: string,
  serverId: string,
  sigB64: string,
): Promise<boolean> {
  try {
    const pubKey = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(pubKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" } as AlgorithmIdentifier,
      pubKey,
      b64ToBytes(sigB64),
      new TextEncoder().encode(serverId),
    );
  } catch {
    return false;
  }
}
