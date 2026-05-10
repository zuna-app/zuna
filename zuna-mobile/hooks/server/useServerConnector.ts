import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  jotaiStore,
  serverListAtom,
  selectedServerAtom,
  serverTokensAtom,
  vaultAtom,
  vaultPinAtom,
} from '@/store/atoms';
import { saveVaultChange } from '@/lib/vault';
import { Server } from '@/types/serverTypes';
import { getOrCreateDeviceId, unregisterDeviceFromServer } from '@/lib/notifications';
import { sendPresenceOfflineAndClose } from '@/hooks/ws/useWsConnection';
import { startGatewayBadgeSync } from '@/lib/gatewayBadgeSync';

export function useServerConnector() {
  const [serverList, setServerList] = useAtom(serverListAtom, { store: jotaiStore });
  const [selectedServer, setSelectedServer] = useAtom(selectedServerAtom, { store: jotaiStore });
  const setServerTokens = useSetAtom(serverTokensAtom, { store: jotaiStore });
  const vault = useAtomValue(vaultAtom, { store: jotaiStore });
  const pin = useAtomValue(vaultPinAtom, { store: jotaiStore });

  async function joinServer(params: {
    address: string;
    username: string;
    password: string;
    avatar: string;
  }): Promise<Server> {
    if (!vault) throw new Error('Vault not unlocked');

    const encPublicKey = vault['encPublicKey'] as string;
    const sigPublicKey = vault['sigPublicKey'] as string;

    const res = await fetch(`https://${params.address}/api/auth/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity_key: encPublicKey,
        signing_key: sigPublicKey,
        avatar: params.avatar,
        server_password: params.password,
        username: params.username,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Join failed (${res.status}): ${text}`);
    }

    const { id, server_public_key, server_id } = await res.json();

    const newServer: Server = {
      id,
      address: params.address,
      name: params.address,
      username: params.username,
      publicKey: server_public_key ?? null,
      serverId: server_id ?? null,
    };

    const updatedList = [...serverList, newServer];
    setServerList(updatedList);

    if (pin) {
      const updatedVault = { ...vault, serverList: updatedList };
      await saveVaultChange(updatedVault, pin).catch(console.error);
    }

    return newServer;
  }

  async function leaveServer(server: Server): Promise<void> {
    const nextList = serverList.filter((s) => s.id !== server.id);

    // Tell the server we're going offline so other clients get an immediate
    // presence_update instead of waiting for the TCP connection to time out.
    const authToken = jotaiStore.get(serverTokensAtom).get(server.id);
    if (authToken) {
      sendPresenceOfflineAndClose(server.id, authToken);
    }

    // Unregister APNs device - only needs authToken + deviceId, not the push token.
    if (authToken) {
      const deviceId = await getOrCreateDeviceId();
      await unregisterDeviceFromServer(server, deviceId, authToken).catch(console.error);
    }

    setServerList(nextList);
    setServerTokens((prev) => {
      const next = new Map(prev);
      next.delete(server.id);
      return next;
    });
    if (selectedServer?.id === server.id) {
      setSelectedServer(nextList[0] ?? null);
    }

    if (pin && vault) {
      const updatedVault = { ...vault, serverList: nextList };
      await saveVaultChange(updatedVault, pin).catch(console.error);
      // Restart WebSocket badge sync so the left server stops updating the badge.
      startGatewayBadgeSync(updatedVault);
    }
  }

  function selectServer(server: Server) {
    setSelectedServer(server);
  }

  return { serverList, selectedServer, joinServer, leaveServer, selectServer };
}
