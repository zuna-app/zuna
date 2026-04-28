import WebSocket from "ws";
import { BrowserWindow, nativeImage, Notification } from "electron";
import { vaultGet } from "../storage/safeVault";
import { userCache } from "../storage/appCache";
import { computeSharedSecret, decrypt } from "../crypto/x25519";
import type { Server } from "../types/serverTypes";
import { verifySignature } from "@/crypto/ed25519";
import { setBadgeCount } from "@/utils/badge";
import { sendNotification } from "../notification/notification";
import { getNotificationWindowHost } from "../notification/host";

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

const activeConnections = new Map<string, WebSocket>();
export let unreadMessagesBadge = 0;

export function setUnreadMessagesBadge(count: number): void {
  unreadMessagesBadge = count;
  setBadgeCount(unreadMessagesBadge);
}

export function startGatewayListeners(): void {
  stopGatewayListeners();

  let serverList: Server[];
  let gatewayRecord: Record<string, string>;

  try {
    serverList = (vaultGet("serverList") as Server[] | null) ?? [];
    const raw = vaultGet("gatewayList") as string | null;
    gatewayRecord = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    console.error(
      "Failed to load server or gateway list from vault, skipping gateway listener setup",
    );
    return;
  }

  // Group servers by unique gateway address to avoid duplicate connections
  const gatewayToServers = new Map<string, Server[]>();
  for (const server of serverList) {
    const gwAddr = gatewayRecord[server.id];
    if (!gwAddr) continue;
    const list = gatewayToServers.get(gwAddr) ?? [];
    list.push(server);
    gatewayToServers.set(gwAddr, list);
  }

  for (const [address, servers] of gatewayToServers) {
    connectToGateway(address, servers);
  }
}

export function stopGatewayListeners(): void {
  for (const ws of activeConnections.values()) {
    ws.terminate();
  }
  activeConnections.clear();
}

function connectToGateway(address: string, servers: Server[]): void {
  const ws = new WebSocket(`wss://${address}/ws`);
  activeConnections.set(address, ws);

  ws.on("open", () => {
    for (const server of servers) {
      ws.send(
        JSON.stringify({
          type: "register_request",
          payload: {
            user_id: server.id,
            server_id: server.serverId ? [server.serverId] : [],
            mobile: false,
          },
        }),
      );
    }
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMessage;
      if (msg.type === "notification_info") {
        handleNotification(msg.payload as NotificationInfoPayload);
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.on("close", () => {
    activeConnections.delete(address);
    // Reconnect after 5s unless listeners were stopped
    setTimeout(() => {
      if (!activeConnections.has(address)) {
        connectToGateway(address, servers);
      }
    }, 5000);
  });

  ws.on("error", () => {
    // 'close' will follow and trigger reconnect
  });
}

function handleNotification(payload: NotificationInfoPayload): void {
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

    const serverList = (vaultGet("serverList") as Server[] | null) ?? [];
    const server = serverList.find((s) => s.serverId === payload.server_id);
    if (!server) return;

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
