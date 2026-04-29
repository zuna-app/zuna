import { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Alert, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { useSetAtom } from 'jotai';
import {
  jotaiStore,
  vaultAtom,
  vaultPinAtom,
  serverListAtom,
  selectedServerAtom,
} from '@/store/atoms';
import { unlockVault } from '@/lib/vault';
import { canUseBiometrics, authenticateWithBiometrics } from '@/lib/biometrics';
import { getSessionPin } from '@/lib/keychain';
import { unlockVaultWithSession } from '@/lib/vault';
import { SafeAreaView } from 'react-native-safe-area-context';

const PIN_LENGTH = 4;

export default function PinScreen() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasBiometrics, setHasBiometrics] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const setVault = useSetAtom(vaultAtom, { store: jotaiStore });
  const setVaultPin = useSetAtom(vaultPinAtom, { store: jotaiStore });
  const setServerList = useSetAtom(serverListAtom, { store: jotaiStore });
  const setSelectedServer = useSetAtom(selectedServerAtom, { store: jotaiStore });

  useEffect(() => {
    canUseBiometrics().then(setHasBiometrics);
    // Auto-focus PIN input
    setTimeout(() => inputRef.current?.focus(), 400);
  }, []);

  function shake() {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }

  async function handleVaultUnlock(enteredPin: string) {
    setLoading(true);
    setError('');
    try {
      const vault = await unlockVault(enteredPin);
      setVault(vault);
      setVaultPin(enteredPin);
      const servers = Array.isArray(vault['serverList']) ? (vault['serverList'] as any[]) : [];
      setServerList(servers);
      if (servers.length > 0) {
        setSelectedServer(servers[0]);
        router.replace(`/(app)/${servers[0].id}` as any);
      } else {
        router.replace('/(app)/join' as any);
      }
    } catch {
      shake();
      setError('Wrong PIN. Try again.');
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  function handlePinChange(text: string) {
    const digits = text.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(digits);
    setError('');
    if (digits.length === PIN_LENGTH) {
      handleVaultUnlock(digits);
    }
  }

  async function handleBiometrics() {
    const success = await authenticateWithBiometrics('Unlock Zuna');
    if (!success) return;
    const vault = await unlockVaultWithSession();
    if (!vault) {
      Alert.alert('Session expired', 'Please enter your PIN.');
      return;
    }
    const pinFromStore = await getSessionPin();
    setVault(vault);
    if (pinFromStore) setVaultPin(pinFromStore);
    const servers = Array.isArray(vault['serverList']) ? (vault['serverList'] as any[]) : [];
    setServerList(servers);
    if (servers.length > 0) {
      setSelectedServer(servers[0]);
      router.replace(`/(app)/${servers[0].id}` as any);
    } else {
      router.replace('/(app)/join' as any);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>Enter PIN</Text>
        <Text style={styles.subtitle}>Enter your vault PIN to unlock Zuna</Text>

        <Animated.View style={[styles.dotsRow, { transform: [{ translateX: shakeAnim }] }]}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <Pressable key={i} style={styles.dotWrapper} onPress={() => inputRef.current?.focus()}>
              <View style={[styles.dot, pin.length > i && styles.dotFilled]} />
            </Pressable>
          ))}
        </Animated.View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Hidden text input for keyboard */}
        <TextInput
          ref={inputRef}
          value={pin}
          onChangeText={handlePinChange}
          keyboardType="number-pad"
          maxLength={PIN_LENGTH}
          style={styles.hiddenInput}
          editable={!loading}
          caretHidden
          secureTextEntry
        />

        {hasBiometrics && (
          <Pressable style={styles.biometricsBtn} onPress={handleBiometrics}>
            <Text style={styles.biometricsText}>Use Face ID / Biometrics</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  inner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#71717a', fontSize: 14, marginBottom: 24 },
  dotsRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  dotWrapper: { padding: 8 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#52525b',
    backgroundColor: 'transparent',
  },
  dotFilled: { backgroundColor: '#fff', borderColor: '#fff' },
  errorText: { color: '#ef4444', fontSize: 13 },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
  },
  biometricsBtn: {
    marginTop: 24,
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  biometricsText: { color: '#a1a1aa', fontWeight: '500' },
});
