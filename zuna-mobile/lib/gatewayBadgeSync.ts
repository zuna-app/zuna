import * as Notifications from 'expo-notifications';
import { Server } from '@/types/serverTypes';

declare const __DEV__: boolean;

type WsMessage = {
  type: string;
  payload: unknown;
};

type RegisterResponsePayload = {
  status: string;
  user_id?: string;
  unread_notifications?: number;
};

type NotificationInfoPayload = {
  user_id?: string;
  unread_notifications?: number;
};

type NotificationClearPayload = {
  user_id?: string;
  unread_notifications?: number;
};

const unreadByUser = new Map<string, number>();
let activeConnection: WebSocket | null = null;
let activeAddress: string | null = null;

async function setBadgeFromUnreadMap(): Promise<void> {
  let total = 0;
  for (const count of unreadByUser.values()) {
    total += count;
  }

  await Notifications.setBadgeCountAsync(total).catch(() => {
    // no-op on unsupported platforms
  });
}

function connectToGateway(address: string, servers: Server[]): void {
  const ws = new WebSocket(`wss://${address}/ws`);
  activeConnection = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'register_request',
        payload: {
          user_ids: servers.map((s) => s.id),
          mobile: true,
        },
      })
    );
  };

  ws.onmessage = ({ data }) => {
    try {
      const raw = typeof data === 'string' ? data : String(data);
      const msg = JSON.parse(raw) as WsMessage;

      if (msg.type === 'register_response') {
        const payload = msg.payload as RegisterResponsePayload;
        if (
          payload.status === 'ok' &&
          typeof payload.user_id === 'string' &&
          typeof payload.unread_notifications === 'number'
        ) {
          unreadByUser.set(payload.user_id, payload.unread_notifications);
          void setBadgeFromUnreadMap();
        }
      } else if (msg.type === 'notification_info') {
        const payload = msg.payload as NotificationInfoPayload;
        if (
          typeof payload.user_id === 'string' &&
          typeof payload.unread_notifications === 'number'
        ) {
          unreadByUser.set(payload.user_id, payload.unread_notifications);
          void setBadgeFromUnreadMap();
        }
      } else if (msg.type === 'notification_badge_update') {
        const payload = msg.payload as NotificationClearPayload;
        if (typeof payload.user_id === 'string') {
          const unreadCount =
            typeof payload.unread_notifications === 'number'
              ? payload.unread_notifications
              : 0;
          unreadByUser.set(payload.user_id, unreadCount);
          void setBadgeFromUnreadMap();
        }
      }
    } catch {
      // ignore malformed frames
    }
  };

  ws.onclose = () => {
    activeConnection = null;

    setTimeout(() => {
      if (activeAddress) {
        connectToGateway(activeAddress, servers);
      }
    }, 5000);
  };

  ws.onerror = () => {
    // close handler reconnects
  };
}

export function startGatewayBadgeSync(vault: Record<string, unknown> | null): void {
  stopGatewayBadgeSync();

  if (!vault) {
    return;
  }

  const serverList = Array.isArray(vault['serverList'])
    ? (vault['serverList'] as Server[])
    : [];

  if (serverList.length === 0) {
    return;
  }

  unreadByUser.clear();
  void setBadgeFromUnreadMap();

  activeAddress = __DEV__ ? 'devgw.zuna.chat' : 'gateway.zuna.chat';
  connectToGateway(activeAddress, serverList);
}

export function stopGatewayBadgeSync(): void {
  activeAddress = null;
  if (activeConnection) {
    activeConnection.close();
    activeConnection = null;
  }
  unreadByUser.clear();
}
