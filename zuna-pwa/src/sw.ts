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

// ── In-memory vault key cache ─────────────────────────────────────────────────
// Cleared when the SW is terminated; repopulated via postMessage on reconnect.

let vaultKeys: VaultKeys | null = null;

// ── Message handler (vault key exchange with main thread) ─────────────────────

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type: string; payload?: unknown } | null;
  if (!data) return;
  if (data.type === "VAULT_KEYS") {
    vaultKeys = data.payload as VaultKeys;
  } else if (data.type === "VAULT_LOCKED") {
    vaultKeys = null;
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

  let body = "You have a new encrypted message";

  if (vaultKeys) {
    try {
      const server = vaultKeys.serverList.find(
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
          console.warn("[SW] Notification signature invalid – discarding");
          return;
        }
      }

      body = await decryptNotification(vaultKeys.encPrivateKey, payload);
    } catch {
      // Decryption failed; fall back to generic body
    }
  }

  await self.registration.showNotification("New Message", {
    body,
    icon: "/pwa-192x192.png",
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
