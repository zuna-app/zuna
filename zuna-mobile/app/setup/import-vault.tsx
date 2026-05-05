import { useState, useRef } from 'react';
import { View, Text, Pressable, Alert, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { importVaultFromBase64 } from '@/lib/vault';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ImportVaultScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const scannedRef = useRef(false);

  async function handleBarcode(result: BarcodeScanningResult) {
    if (scannedRef.current || fetchingUrl || scanLocked) return;
    scannedRef.current = true;
    setScanLocked(true);
    setFetchingUrl(true);

    try {
      const url = result.data;
      // Fetch vault.bin from the Electron export server (self-signed TLS — RN accepts it)
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      // Response body is raw binary; convert it to base64 once via blob.
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const b64Data = dataUrl.split(',')[1];
        await importVaultFromBase64(b64Data);
        router.replace('/setup/pin');
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      Alert.alert('Import failed', err instanceof Error ? err.message : String(err));
      setFetchingUrl(false);
    }
  }

  async function handleFilePicker() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      const b64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await importVaultFromBase64(b64);
      router.replace('/setup/pin');
    } catch (err) {
      Alert.alert('Import failed', err instanceof Error ? err.message : String(err));
    }
  }

  async function requestAndScan() {
    if (!permission?.granted) {
      const { granted } = await requestPermission();
      if (!granted) return;
    }
    scannedRef.current = false;
    setScanLocked(false);
    setScanning(true);
  }

  if (scanning) {
    return (
      <View style={StyleSheet.absoluteFill}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={fetchingUrl || scanLocked ? undefined : handleBarcode}
        />
        <SafeAreaView style={styles.scanOverlay} edges={['top', 'bottom']}>
          <View style={styles.scanFrame} />
          <Text style={styles.scanHint}>
            {fetchingUrl ? 'Downloading vault…' : 'Point at the QR code shown in Zuna desktop'}
          </Text>
          <Pressable
            style={styles.cancelBtn}
            onPress={() => {
              setScanning(false);
              setScanLocked(false);
              scannedRef.current = false;
            }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>Import Vault</Text>
        <Text style={styles.subtitle}>
          Open Zuna on your desktop, go to Settings → Export Vault, and scan the QR code — or pick
          the vault.bin file directly.
        </Text>

        <Pressable style={styles.primaryBtn} onPress={requestAndScan}>
          <Text style={styles.primaryBtnText}>Scan QR Code</Text>
        </Pressable>

        <Pressable style={styles.secondaryBtn} onPress={handleFilePicker}>
          <Text style={styles.secondaryBtnText}>Pick vault.bin file</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  inner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginBottom: 8 },
  subtitle: {
    color: '#71717a',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 16,
  },
  primaryBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  primaryBtnText: { color: '#000', fontWeight: '600', fontSize: 16 },
  secondaryBtn: {
    borderColor: '#27272a',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#a1a1aa', fontWeight: '500', fontSize: 16 },
  scanOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 60,
    paddingBottom: 40,
  },
  scanFrame: {
    width: 260,
    height: 260,
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 20,
    marginTop: 80,
  },
  scanHint: { color: '#fff', fontSize: 14, textAlign: 'center', paddingHorizontal: 32 },
  cancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  cancelText: { color: '#fff', fontWeight: '600' },
});
