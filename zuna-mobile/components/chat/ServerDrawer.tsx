import { View, Text, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useAtomValue } from 'jotai';
import { jotaiStore, serverListAtom, selectedServerAtom, serverMetaAtom } from '@/store/atoms';
import { useServerConnector } from '@/hooks/server/useServerConnector';
import { Server } from '@/types/serverTypes';
import { Avatar } from '@/components/ui/avatar';
import { SafeAreaView } from 'react-native-safe-area-context';

interface JoinSheetProps {
  onClose: () => void;
}

function JoinSheet({ onClose }: JoinSheetProps) {
  const [address, setAddress] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { joinServer } = useServerConnector();
  const router = useRouter();

  async function handleJoin() {
    try {
      const server = await joinServer({
        address: address.trim(),
        username: username.trim(),
        password: password.trim(),
        avatar: '😊',
      });
      onClose();
      router.replace(`/(app)/${server.id}` as any);
    } catch (err) {
      Alert.alert('Join failed', err instanceof Error ? err.message : String(err));
    }
  }

  const { TextInput } = require('react-native');
  return (
    <View style={join.container}>
      <Text style={join.title}>Add Server</Text>
      <TextInput
        style={join.input}
        value={address}
        onChangeText={setAddress}
        placeholder="address:port"
        placeholderTextColor="#52525b"
        autoCapitalize="none"
      />
      <TextInput
        style={join.input}
        value={username}
        onChangeText={setUsername}
        placeholder="username"
        placeholderTextColor="#52525b"
        autoCapitalize="none"
      />
      <TextInput
        style={join.input}
        value={password}
        onChangeText={setPassword}
        placeholder="server password"
        placeholderTextColor="#52525b"
        secureTextEntry
      />
      <Pressable style={join.btn} onPress={handleJoin}>
        <Text style={join.btnText}>Join</Text>
      </Pressable>
      <Pressable style={join.cancel} onPress={onClose}>
        <Text style={join.cancelText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

interface DrawerProps {
  onClose: () => void;
}

export function ServerDrawer({ onClose }: DrawerProps) {
  const router = useRouter();
  const serverList = useAtomValue(serverListAtom, { store: jotaiStore });
  const selectedServer = useAtomValue(selectedServerAtom, { store: jotaiStore });
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });
  const { selectServer } = useServerConnector();
  const [showJoin, setShowJoin] = useState(false);

  if (showJoin) return <JoinSheet onClose={() => setShowJoin(false)} />;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Text style={styles.header}>Servers</Text>
      <ScrollView style={styles.list}>
        {serverList.map((server) => (
          <Pressable
            key={server.id}
            style={[styles.serverItem, selectedServer?.id === server.id && styles.serverItemActive]}
            onPress={() => {
              selectServer(server);
              router.replace(`/(app)/${server.id}` as any);
              onClose();
            }}>
            <View
              style={[styles.indicator, selectedServer?.id === server.id && styles.indicatorActive]}
            />
            <Avatar
              name={serverMeta.get(server.id)?.name || server.name || server.address}
              size={44}
              uri={serverMeta.get(server.id)?.logo}
            />
            <View style={styles.serverInfo}>
              <Text style={styles.serverName} numberOfLines={1}>
                {serverMeta.get(server.id)?.name || server.name || server.address}
              </Text>
              <Text style={styles.serverAddress} numberOfLines={1}>
                {server.username} · {server.address}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable style={styles.addBtn} onPress={() => setShowJoin(true)}>
        <Text style={styles.addBtnText}>+ Add Server</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#09090b' },
  header: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  list: { flex: 1 },
  serverItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  serverItemActive: { backgroundColor: '#18181b' },
  indicator: { width: 4, height: 36, borderRadius: 2, backgroundColor: 'transparent' },
  indicatorActive: { backgroundColor: '#fff' },
  serverInfo: { flex: 1 },
  serverName: { color: '#fff', fontWeight: '600', fontSize: 15 },
  serverAddress: { color: '#52525b', fontSize: 12, marginTop: 1 },
  addBtn: {
    borderTopWidth: 1,
    borderTopColor: '#18181b',
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  addBtnText: { color: '#a1a1aa', fontWeight: '600', fontSize: 15 },
});

const join = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#09090b',
    padding: 24,
    gap: 12,
    justifyContent: 'center',
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  input: {
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#27272a',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: '#fff',
  },
  btn: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: '#000', fontWeight: '600', fontSize: 15 },
  cancel: { alignItems: 'center', paddingVertical: 8 },
  cancelText: { color: '#71717a' },
});
