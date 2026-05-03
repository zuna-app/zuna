import WebSocket from "ws";
import { BrowserWindow, nativeImage, Notification } from "electron";
import { vaultGet } from "../storage/safeVault";
import { userCache } from "../storage/appCache";
import {
  computeSharedSecret,
  decrypt,
  verifySignature,
} from "@zuna/shared/src/crypto";
import type { Server } from "@zuna/shared/src/types/serverTypes";
import { setBadgeCount } from "../utils/badge";
import { sendNotification } from "../notification/notification";

interface NotificationInfoPayload {
  server_id: string;
  sender_id: string;
  sender_identity_key: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  signature: string;
}

interface WsMessage {
  type: string;
  payload: unknown;
}

// keyed by server.id
const activeConnections = new Map<string, WebSocket>();
export let unreadMessagesBadge = 0;

export function setUnreadMessagesBadge(count: number): void {
  unreadMessagesBadge = count;
  setBadgeCount(unreadMessagesBadge);
}

export function startGatewayListeners(): void {
  stopGatewayListeners();

  let serverList: Server[];
  try {
    serverList = (vaultGet("serverList") as Server[] | null) ?? [];
  } catch {
    console.error(
      "Failed to load server list from vault, skipping notification listener setup",
    );
    return;
  }

  for (const server of serverList) {
    connectToServer(server);
  }
}

export function stopGatewayListeners(): void {
  for (const ws of activeConnections.values()) {
    ws.terminate();
  }
  activeConnections.clear();
}

function connectToServer(server: Server): void {
  const ws = new WebSocket(`wss://${server.address}/ws/notify`, {
    rejectUnauthorized: false,
  });
  activeConnections.set(server.id, ws);

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "register_request",
        payload: {
          user_id: server.id,
        },
      }),
    );
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMessage;
      if (msg.type === "notification_info") {
        handleNotification(msg.payload as NotificationInfoPayload, server);
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.on("close", () => {
    activeConnections.delete(server.id);
    // Reconnect after 5s unless listeners were stopped
    setTimeout(() => {
      if (!activeConnections.has(server.id)) {
        connectToServer(server);
      }
    }, 5000);
  });

  ws.on("error", () => {
    // 'close' will follow and trigger reconnect
  });
}

function handleNotification(
  payload: NotificationInfoPayload,
  server: Server,
): void {
  try {
    const encPrivateKey = vaultGet("encPrivateKey") as string | null;
    if (!encPrivateKey) return;

    const sharedSecret = computeSharedSecret(
      encPrivateKey,
      payload.sender_identity_key,
    );
    const plaintext = decrypt(sharedSecret, {
      ciphertext: payload.cipher_text,
      iv: payload.iv,
      authTag: payload.auth_tag,
    });

    const serverPublicKey = server.publicKey;
    if (!serverPublicKey) return;

    const isValid = verifySignature(
      serverPublicKey,
      payload.server_id,
      payload.signature,
    );
    if (!isValid) {
      console.warn("Received notification with invalid signature, ignoring");
      return;
    }

    const senderInfo = userCache.get("users")[payload.sender_id];

    if (process.platform === "win32") {
      sendNotification({
        senderName: senderInfo?.username || "New Message",
        content: plaintext,
        avatarUrl: senderInfo?.avatar || undefined,
      });
    } else {
      const n = new Notification({
        title: senderInfo?.username || "New Message",
        body: plaintext,
        icon: senderInfo?.avatar
          ? nativeImage.createFromDataURL(senderInfo.avatar)
          : undefined,
      });

      n.on("click", () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          if (win.isMinimized()) win.restore();
          win.setAlwaysOnTop(true);
          win.show();
          win.focus();
          win.setAlwaysOnTop(false);
        }
      });
      n.show();
    }
    setUnreadMessagesBadge(unreadMessagesBadge + 1);
  } catch (e) {
    // ignore decrypt errors (e.g. wrong key, tampered message)
    console.error("Failed to handle notification:", e);
  }
}
