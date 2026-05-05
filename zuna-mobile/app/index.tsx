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
import { clearSession, getSessionPin } from '@/lib/keychain';

import 'react-native-get-random-values';
import { fetchAndUpdateServerInfos } from '@/hooks/auth/useAuthorizer';

import * as LocalAuthentication from 'expo-local-authentication';

export default function Index() {
  const router = useRouter();
  const setVault = useSetAtom(vaultAtom, { store: jotaiStore });
  const setVaultPin = useSetAtom(vaultPinAtom, { store: jotaiStore });
  const setServerList = useSetAtom(serverListAtom, { store: jotaiStore });
  const setSelectedServer = useSetAtom(selectedServerAtom, { store: jotaiStore });

  useEffect(() => {
    async function authWithSession() {
      try {
        const vault = await unlockVaultWithSession();
        if (!vault) return false;

        setVault(vault);

        const servers = Array.isArray(vault['serverList']) ? (vault['serverList'] as any[]) : [];
        setServerList(servers);

        // Don't block navigation on metadata fetch.
        void fetchAndUpdateServerInfos(servers);

        if (servers.length > 0) {
          setSelectedServer(servers[0]);
          router.replace(`/(app)/${servers[0].id}` as any);
        } else {
          router.replace('/(app)/join' as any);
        }
        return true;
      } catch {
        await clearSession();
        return false;
      }
    }

    async function init() {
      const imported = await isVaultImported();
      if (!imported) {
        router.replace('/setup/import-vault' as any);
        return;
      }

      const sessionPin = await getSessionPin();
      if (sessionPin) {
        setVaultPin(sessionPin);
        const isWeakAuth = await LocalAuthentication.getEnrolledLevelAsync().then(
          (level) => level === LocalAuthentication.SecurityLevel.NONE
        );
        if (isWeakAuth) {
          await clearSession();
          router.replace('/setup/pin' as any);
          return;
        }
        //const hasBio = await canUseBiometrics();
        //if (hasBio) {
        //  const bioSuccess = await authenticateWithBiometrics('Unlock Zuna');
        //  if (bioSuccess) {
        const unlocked = await authWithSession();
        if (unlocked) return;

        await clearSession();
        router.replace('/setup/pin' as any);
        return;
        //  }
        //}
      }

      // if not unlocked with session, go to PIN entry
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
