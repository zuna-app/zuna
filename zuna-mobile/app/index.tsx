import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { isVaultImported, unlockVault } from '@/lib/vault';
import { useSetAtom } from 'jotai';
import {
  jotaiStore,
  vaultAtom,
  vaultPinAtom,
  serverListAtom,
  selectedServerAtom,
} from '@/store/atoms';
import { getSessionPin, clearSession } from '@/lib/keychain';
import { canUseBiometrics, authenticateWithBiometrics } from '@/lib/biometrics';

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

      const sessionPin = await getSessionPin();
      if (sessionPin) {
        //const hasBio = await canUseBiometrics();
        //if (hasBio) {
        //  const bioSuccess = await authenticateWithBiometrics('Unlock Zuna');
        //  if (bioSuccess) {
        try {
          const vault = await unlockVault(sessionPin);
          setVault(vault);
          setVaultPin(sessionPin);
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
        } catch {
          await clearSession();
        }
        //  }
        //}
      }

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
