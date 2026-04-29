import { useEffect, useRef, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View, StyleSheet } from 'react-native';
import { useAtomValue, useSetAtom } from 'jotai';
import { jotaiStore, serverListAtom, selectedServerAtom, vaultAtom } from '@/store/atoms';
import { serverTokensAtom } from '@/store/atoms';
import { useAuthorizer } from '@/hooks/auth/useAuthorizer';
import { Server } from '@/types/serverTypes';

export default function ServerLayout() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const serverList = useAtomValue(serverListAtom, { store: jotaiStore });
  const setSelectedServer = useSetAtom(selectedServerAtom, { store: jotaiStore });

  const server = serverList.find((s) => s.id === serverId) ?? null;

  useEffect(() => {
    if (server) setSelectedServer(server);
  }, [server?.id]);

  if (!server) return null;

  return <ServerAuthWrapper server={server} />;
}

function ServerAuthWrapper({ server }: { server: Server }) {
  const { authorize, token, isAuthorizing, error } = useAuthorizer(server);
  const authorizedRef = useRef(false);

  useEffect(() => {
    if (!token && !authorizedRef.current && !isAuthorizing) {
      authorizedRef.current = true;
      authorize(server.username).catch(console.error);
    }
  }, [token, server.id]);

  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />
  );
}
