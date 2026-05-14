import WebSocket from "ws";
import { BrowserWindow, nativeImage, Notification } from "electron";
import { vaultGet } from "../storage/safeVault";
import { userCache } from "../storage/appCache";
import { verifySignature } from "@/crypto/ed25519";
import { setBadgeCount } from "@/utils/badge";
import { sendNotification } from "../notification/notification";
import { getNotificationWindowHost } from "../notification/host";
import { Server } from "@/types";
import { computeSharedSecret, decrypt } from "@/crypto";
import { decryptWithChannelKey } from "@/crypto/channel";
import fetch from "node-fetch";
import https from "https";
import { getZunaWindow } from "@/utils/basicUtils";
import { isDev } from "@/utils/env";

const agent = new https.Agent({
  rejectUnauthorized: false,
});

interface NotificationInfoPayload {
  user_id: string;
  server_id: string;
  sender_id: string;
  sender_identity_key: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  signature: string;
  unread_notifications: number;
}

interface RegisterResponsePayload {
  status: string;
  user_id?: string;
  unread_notifications?: number;
}

interface ChannelNotificationInfoPayload {
  user_id: string;
  server_id: string;
  sender_id: string;
  sender_username: string;
  channel_id: string;
  channel_name: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  unread_notifications: number;
}

interface NotificationClearPayload {
  user_id?: string;
  unread_notifications?: number;
}

interface WsMessage {
  type: string;
  payload: unknown;
}

let activeConnection: WebSocket | null;
let activeServerAddress: string;
const unreadByUser = new Map<string, number>();
export let unreadMessagesBadge = 0;

export function setUnreadMessagesBadge(count: number): void {
  unreadMessagesBadge = count;
  setBadgeCount(unreadMessagesBadge);
}

function recomputeBadgeFromUsers(): void {
  let total = 0;
  for (const count of unreadByUser.values()) {
    total += count;
  }

  setUnreadMessagesBadge(total);
}

export function startGatewayListeners(): void {
  stopGatewayListeners();
  unreadByUser.clear();
  setUnreadMessagesBadge(0);

  let serverList: Server[];

  try {
    serverList = (vaultGet("serverList") as Server[] | null) ?? [];
  } catch {
    console.error(
      "Failed to load server or gateway list from vault, skipping gateway listener setup",
    );
    return;
  }

  let serverAddress;
  if (isDev) {
    serverAddress = "devgw.zuna.chat";
  } else {
    serverAddress = "gateway.zuna.chat";
  }
  connectToGateway(serverAddress, serverList);
  activeServerAddress = serverAddress;
}

export function stopGatewayListeners(): void {
  if (activeConnection) {
    activeConnection.terminate();
    activeConnection = null;
  }
}

function connectToGateway(address: string, servers: Server[]): void {
  const ws = new WebSocket(`wss://${address}/ws`);
  activeConnection = ws;

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "register_request",
        payload: {
          user_ids: servers.map((s) => s.id),
          mobile: false,
        },
      }),
    );
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMessage;
      if (msg.type === "notification_info") {
        handleNotification(msg.payload as NotificationInfoPayload);
      } else if (msg.type === "channel_notification_info") {
        handleChannelNotification(
          msg.payload as ChannelNotificationInfoPayload,
        );
      } else if (msg.type === "register_response") {
        const payload = msg.payload as RegisterResponsePayload;
        if (
          payload.status === "ok" &&
          typeof payload.user_id === "string" &&
          typeof payload.unread_notifications === "number"
        ) {
          unreadByUser.set(payload.user_id, payload.unread_notifications);
          recomputeBadgeFromUsers();
        }
      } else if (msg.type === "notification_badge_update") {
        const payload = msg.payload as NotificationClearPayload;
        if (typeof payload.user_id === "string") {
          const unreadCount =
            typeof payload.unread_notifications === "number"
              ? payload.unread_notifications
              : 0;
          unreadByUser.set(payload.user_id, unreadCount);
          recomputeBadgeFromUsers();
        } else {
          unreadByUser.clear();
          setUnreadMessagesBadge(0);
        }
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.on("close", () => {
    activeConnection = null;
    // Reconnect after 5s unless listeners were stopped
    setTimeout(() => {
      connectToGateway(activeServerAddress, servers);
    }, 5000);
  });

  ws.on("error", () => {
    // 'close' will follow and trigger reconnect
  });
}

async function handleChannelNotification(
  payload: ChannelNotificationInfoPayload,
): Promise<void> {
  try {
    const channelKey = vaultGet(`channel_key_${payload.channel_id}`) as
      | string
      | null;

    let messageBody: string;
    if (channelKey) {
      try {
        const plaintext = decryptWithChannelKey(channelKey, {
          ciphertext: payload.cipher_text,
          iv: payload.iv,
          authTag: payload.auth_tag,
        });
        messageBody = payload.sender_username + ": " + plaintext;
      } catch {
        messageBody = payload.sender_username + ": New message";
      }
    } else {
      messageBody = payload.sender_username + ": New message";
    }

    const title = "#" + payload.channel_name;
    const senderAvatarUrl = userCache.get("users")[payload.sender_id]?.avatar;

    if (process.platform === "win32") {
      const mainWindow = getZunaWindow();
      if (mainWindow) {
        mainWindow.flashFrame(true);
      }
      sendNotification({
        senderName: title,
        content: messageBody,
        avatarUrl: senderAvatarUrl || undefined,
      });
    } else {
      let senderAvatarNativeImage: Electron.NativeImage | undefined;
      if (senderAvatarUrl) {
        try {
          const response = await fetch(senderAvatarUrl, { agent });
          const buffer = await response.arrayBuffer();
          senderAvatarNativeImage = nativeImage.createFromBuffer(
            Buffer.from(buffer),
          );
        } catch {
          // ignore avatar download errors and fallback to no avatar
        }
      }

      const n = new Notification({
        title,
        body: messageBody,
        icon: senderAvatarNativeImage,
      });

      n.on("click", () => {
        const win = getZunaWindow();
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
    unreadByUser.set(payload.user_id, payload.unread_notifications);
    recomputeBadgeFromUsers();
  } catch (e) {
    console.error("Failed to handle channel notification:", e);
  }
}

async function handleNotification(
  payload: NotificationInfoPayload,
): Promise<void> {
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

    const senderAvatarUrl = senderInfo?.avatar;
    if (process.platform === "win32") {
      const mainWindow = getZunaWindow();
      if (mainWindow) {
        mainWindow.flashFrame(true);
      }
      sendNotification({
        senderName: senderInfo?.username || "New Message",
        content: plaintext,
        avatarUrl: senderAvatarUrl || undefined,
      });
    } else {
      let senderAvatarNativeImage: Electron.NativeImage | undefined;
      if (senderAvatarUrl) {
        try {
          const response = await fetch(senderAvatarUrl, {
            agent,
          });
          const buffer = await response.arrayBuffer();
          senderAvatarNativeImage = nativeImage.createFromBuffer(
            Buffer.from(buffer),
          );
        } catch {
          // ignore avatar download errors and fallback to no avatar
        }
      }

      const n = new Notification({
        title: senderInfo?.username || "New Message",
        body: plaintext,
        icon: senderAvatarNativeImage,
      });

      n.on("click", () => {
        const win = getZunaWindow();
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
    unreadByUser.set(payload.user_id, payload.unread_notifications);
    recomputeBadgeFromUsers();
  } catch (e) {
    // ignore decrypt errors (e.g. wrong key, tampered message)
    console.error("Failed to handle notification:", e);
  }
}
