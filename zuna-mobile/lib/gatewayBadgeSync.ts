import * as Notifications from 'expo-notifications';
import { Server } from '@/types/serverTypes';

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

const activeConnections = new Map<string, WebSocket>();
const unreadByUser = new Map<string, number>();

async function setBadgeFromUnreadMap(): Promise<void> {
  let total = 0;
  for (const count of unreadByUser.values()) {
    total += count;
  }

  await Notifications.setBadgeCountAsync(total).catch(() => {
    // no-op on unsupported platforms
  });
}

function parseGatewayRecord(vault: Record<string, unknown>): Record<string, string> {
  const raw = vault['gatewayList'];

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  if (raw && typeof raw === 'object') {
    return raw as Record<string, string>;
  }

  return {};
}

function connectToGateway(address: string, servers: Server[]): void {
  const ws = new WebSocket(`wss://${address}/ws`);
  activeConnections.set(address, ws);

  ws.onopen = () => {
    for (const server of servers) {
      ws.send(
        JSON.stringify({
          type: 'register_request',
          payload: {
            user_id: server.id,
            mobile: true,
          },
        })
      );
    }
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
    activeConnections.delete(address);

    setTimeout(() => {
      if (!activeConnections.has(address)) {
        connectToGateway(address, servers);
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
  const gatewayRecord = parseGatewayRecord(vault);

  unreadByUser.clear();

  const gatewayToServers = new Map<string, Server[]>();
  for (const server of serverList) {
    const gatewayAddress = gatewayRecord[server.id];
    if (!gatewayAddress) {
      continue;
    }

    const list = gatewayToServers.get(gatewayAddress) ?? [];
    list.push(server);
    gatewayToServers.set(gatewayAddress, list);
  }

  for (const [address, servers] of gatewayToServers) {
    connectToGateway(address, servers);
  }
}

export function stopGatewayBadgeSync(): void {
  for (const ws of activeConnections.values()) {
    ws.close();
  }
  activeConnections.clear();
}
