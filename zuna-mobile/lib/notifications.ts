import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { jotaiStore, serverListAtom, serverTokensAtom, pushTokenAtom } from '@/store/atoms';
import { getDeviceId, setDeviceId, setEncPrivateKeyForNSE, getStoredUserMap, storeUserMapForNSE } from './keychain';
import { Server, ChatMember } from '@/types/serverTypes';

function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await getDeviceId();
  if (existing) return existing;
  const id = generateUUID();
  await setDeviceId(id);
  return id;
}

export async function registerDeviceWithServer(
  server: Server,
  deviceId: string,
  deviceToken: string,
  authToken: string
): Promise<void> {
  await fetch(`https://${server.address}/api/notifications/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      user_id: server.id,
      device_id: deviceId,
      device_token: deviceToken,
      platform: 'ios',
    }),
  });
}

export async function unregisterDeviceFromServer(
  server: Server,
  deviceId: string,
  authToken: string
): Promise<void> {
  await fetch(`https://${server.address}/api/notifications/unregister`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      user_id: server.id,
      device_id: deviceId,
    }),
  });
}

export async function registerDeviceWithAllServers(deviceToken: string): Promise<void> {
  const servers = jotaiStore.get(serverListAtom);
  const tokens = jotaiStore.get(serverTokensAtom);
  const deviceId = await getOrCreateDeviceId();

  await Promise.allSettled(
    servers.map(async (server) => {
      const authToken = tokens.get(server.id);
      if (!authToken) return;
      await registerDeviceWithServer(server, deviceId, deviceToken, authToken);
    })
  );
}

// Called on every vault unlock so the NSE can decrypt incoming notifications.
export async function storeEncPrivateKeyForNSE(vault: Record<string, unknown>): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const encPrivateKey = vault['encPrivateKey'] as string | undefined;
  if (!encPrivateKey) return;
  await setEncPrivateKeyForNSE(encPrivateKey).catch(console.error);
}

// Merges chat members into the shared-keychain user map so the NSE can resolve
// sender IDs to usernames and knows which server address to use for avatar downloads.
export async function updateUserMapForNSE(members: ChatMember[], serverAddress: string): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const map = await getStoredUserMap();
  for (const m of members) {
    map[m.id] = { username: m.username, serverAddress };
  }
  await storeUserMapForNSE(map).catch(console.error);
}

// Request permission and get the raw APNs device token.
// Returns null if permissions are denied or the platform is not iOS.
export async function setupPushNotifications(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;

  const { status } = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });

  if (status !== 'granted') return null;

  try {
    const tokenData = await Notifications.getDevicePushTokenAsync();
    return tokenData.data as string;
  } catch {
    return null;
  }
}
