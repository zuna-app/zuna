import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { isVaultImported, unlockVaultWithSession } from '@/lib/vault';
import { useSetAtom } from 'jotai';
import {
  jotaiStore,
  vaultAtom,
  vaultPinAtom,
  serverListAtom,
  selectedServerAtom,
} from '@/store/atoms';
import { getSessionPin } from '@/lib/keychain';

import 'react-native-get-random-values';
import { fetchAndUpdateServerInfos } from '@/hooks/auth/useAuthorizer';

export default function Index() {
  const router = useRouter();
  const setVault = useSetAtom(vaultAtom, { store: jotaiStore });
  const setVaultPin = useSetAtom(vaultPinAtom, { store: jotaiStore });
  const setServerList = useSetAtom(serverListAtom, { store: jotaiStore });
  const setSelectedServer = useSetAtom(selectedServerAtom, { store: jotaiStore });

  useEffect(() => {
    async function init() {
      const imported = await isVaultImported();
      if (!imported) {
        router.replace('/setup/import-vault' as any);
        return;
      }

      // Try auto-unlock with stored session PIN
      const vault = await unlockVaultWithSession();
      if (vault) {
        setVault(vault);
        const pin = await getSessionPin();
        if (pin) setVaultPin(pin);

        const servers = Array.isArray(vault['serverList']) ? (vault['serverList'] as any[]) : [];
        setServerList(servers);
        if (servers.length > 0) {
          setSelectedServer(servers[0]);
          await fetchAndUpdateServerInfos(servers);
          router.replace(`/(app)/${servers[0].id}` as any);
        } else {
          router.replace('/(app)/join' as any);
        }
        return;
      }

      // Session expired — ask for PIN
      router.replace('/setup/pin' as any);
    }

    init().catch(console.error);
  }, []);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0a0a0a',
      }}>
      <ActivityIndicator color="#fff" />
    </View>
  );
}
