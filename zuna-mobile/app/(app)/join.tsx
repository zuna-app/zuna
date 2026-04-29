import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useServerConnector } from '@/hooks/server/useServerConnector';

export default function JoinServerScreen() {
  const router = useRouter();
  const { joinServer } = useServerConnector();

  const [address, setAddress] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [avatar, setAvatar] = useState('😊');
  const [loading, setLoading] = useState(false);

  async function handleJoin() {
    if (!address.trim() || !username.trim()) {
      Alert.alert('Missing fields', 'Server address and username are required.');
      return;
    }
    setLoading(true);
    try {
      const server = await joinServer({
        address: address.trim(),
        username: username.trim(),
        password: password.trim(),
        avatar,
      });
      router.replace(`/(app)/${server.id}` as any);
    } catch (err) {
      Alert.alert('Join failed', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Join Server</Text>
        <Text style={styles.subtitle}>Connect to a Zuna server with your vault keys</Text>

        <View style={styles.field}>
          <Text style={styles.label}>Server Address</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder="example.com:8080"
            placeholderTextColor="#52525b"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="your_username"
            placeholderTextColor="#52525b"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Server Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Server join password"
            placeholderTextColor="#52525b"
            secureTextEntry
          />
        </View>

        <Pressable
          style={[styles.btn, loading && styles.btnDisabled]}
          onPress={handleJoin}
          disabled={loading}
        >
          <Text style={styles.btnText}>{loading ? 'Joining…' : 'Join Server'}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 16 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginBottom: 4 },
  subtitle: { color: '#71717a', fontSize: 14, marginBottom: 16 },
  field: { gap: 6 },
  label: { color: '#a1a1aa', fontSize: 13, fontWeight: '500' },
  input: {
    backgroundColor: '#18181b', borderWidth: 1, borderColor: '#27272a',
    borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14,
    color: '#fff', fontSize: 15,
  },
  btn: {
    marginTop: 8, backgroundColor: '#fff', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#000', fontWeight: '600', fontSize: 16 },
});
