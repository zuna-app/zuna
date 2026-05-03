import type { Server } from "@zuna/shared";

const GATEWAY_HOST = "gateway.zuna.chat";

const VAPID_PUBLIC_KEY =
  "BIGetD2x3diIxvF2tJ_aqkHHQBLz3yZ7Wmaa_OvMGpquJF9KjnJ4viyBgH2zCwxq9nWSjCCcQucQ7DhNOYHWNu0";

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

async function getOrSubscribe(
  reg: ServiceWorkerRegistration,
): Promise<PushSubscription | null> {
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(VAPID_PUBLIC_KEY),
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

  const subJson = sub.toJSON();
  const p256dh = subJson.keys?.p256dh;
  const auth = subJson.keys?.auth;
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
