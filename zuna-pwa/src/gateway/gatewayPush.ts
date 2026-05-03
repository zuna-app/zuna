import type { Server } from "@zuna/shared";

const GATEWAY_HOST = "gateway.zuna.chat";

let cachedVapidPublicKey: string | null = null;

export type UserCacheMap = Record<
  string,
  { username?: string; avatar?: string }
>;

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const view = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return view;
}

function toUint8Array(
  buf: ArrayBuffer | ArrayBufferView,
): Uint8Array<ArrayBuffer> {
  if (ArrayBuffer.isView(buf)) {
    // Copy into an ArrayBuffer-backed view to satisfy strict BufferSource typing.
    const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const copy = new Uint8Array(new ArrayBuffer(view.byteLength));
    copy.set(view);
    return copy;
  }
  return new Uint8Array(buf);
}

function arrayBuffersEqual(
  a: ArrayBuffer | ArrayBufferView,
  b: ArrayBuffer | ArrayBufferView,
): boolean {
  const left = toUint8Array(a);
  const right = toUint8Array(b);
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function extractSubscriptionKeys(sub: PushSubscription): {
  p256dh: string | null;
  auth: string | null;
} {
  const subJson = sub.toJSON();
  let p256dh = subJson.keys?.p256dh ?? null;
  let auth = subJson.keys?.auth ?? null;

  // Safari/iOS may omit keys from toJSON(); fallback to getKey.
  if (!p256dh) {
    const key = sub.getKey("p256dh");
    if (key) p256dh = bytesToBase64Url(new Uint8Array(key));
  }

  if (!auth) {
    const key = sub.getKey("auth");
    if (key) auth = bytesToBase64Url(new Uint8Array(key));
  }

  return { p256dh, auth };
}

async function getOrSubscribe(
  reg: ServiceWorkerRegistration,
): Promise<PushSubscription | null> {
  const vapidPublicKey =
    "BIGetD2x3diIxvF2tJ_aqkHHQBLz3yZ7Wmaa_OvMGpquJF9KjnJ4viyBgH2zCwxq9nWSjCCcQucQ7DhNOYHWNu0";
  if (!vapidPublicKey) return null;

  const desiredServerKey = urlBase64ToUint8Array(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();

  if (sub?.options.applicationServerKey) {
    const sameKey = arrayBuffersEqual(
      sub.options.applicationServerKey,
      desiredServerKey,
    );
    if (!sameKey) {
      try {
        await sub.unsubscribe();
      } catch (err) {
        console.error(
          "[GatewayPush] Failed to remove stale subscription:",
          err,
        );
      }
      sub = null;
    }
  }

  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: desiredServerKey,
      });
    } catch (err) {
      console.error("[GatewayPush] Push subscription failed:", err);
      return null;
    }
  }
  return sub;
}

/**
 * Post the decryption keys to the active service worker so it can decrypt
 * incoming push payloads. Should be called after vault unlock and re-called
 * whenever the SW controller changes (e.g. after an update).
 */
export async function sendVaultKeysToSW(
  encPrivateKey: string,
  serverList: Server[],
): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active) return;
  reg.active.postMessage({
    type: "VAULT_KEYS",
    payload: { encPrivateKey, serverList },
  });
}

/** Tell the service worker to discard the vault keys (called on vault lock). */
export async function clearVaultKeysFromSW(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({ type: "VAULT_LOCKED" });
}

/** Sync cached user profiles so SW notifications can resolve sender name/avatar. */
export async function sendUserCacheToSW(users: UserCacheMap): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active) return;
  reg.active.postMessage({ type: "USER_CACHE", payload: users });
}

/**
 * Subscribe to Web Push via gateway.zuna.chat and register the subscription
 * for every server that has a serverId.
 *
 * @param encPrivateKey  PKCS8 DER base64 X25519 private key from the vault
 * @param servers        Current server list from the vault
 */
export async function initGatewayPush(
  encPrivateKey: string,
  servers: Server[],
): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (Notification.permission !== "granted") return;

  const reg = await navigator.serviceWorker.ready;
  const sub = await getOrSubscribe(reg);
  if (!sub) return;

  // Forward vault keys so the SW can decrypt push payloads
  await sendVaultKeysToSW(encPrivateKey, servers);

  const { p256dh, auth } = extractSubscriptionKeys(sub);
  if (!p256dh || !auth) return;

  await Promise.allSettled(
    servers
      .filter((server) => server.serverId)
      .map((server) =>
        fetch(`https://${GATEWAY_HOST}/api/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: server.id,
            server_id: server.serverId,
            subscription: { endpoint: sub.endpoint, p256dh, auth },
          }),
        }).catch((err) =>
          console.error(
            `[GatewayPush] Failed to register server ${server.id}:`,
            err,
          ),
        ),
      ),
  );
}
