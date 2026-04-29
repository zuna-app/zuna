import { useState, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useAtomValue } from 'jotai';
import { jotaiStore, vaultAtom, serverTokensAtom } from '@/store/atoms';
import { decryptFile } from '@/lib/crypto/file';
import { Server } from '@/types/serverTypes';

const CACHE_DIR = `${FileSystem.cacheDirectory}attachments/`;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function useAttachmentDownload(
  server: Server,
  attachmentId: string | undefined,
  senderIdentityKey: string,
  mimeType: string,
  autoFetch = false,
  fileName?: string
) {
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vault = useAtomValue(vaultAtom, { store: jotaiStore });
  const tokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const didAutoFetch = useRef(false);

  const download = useCallback(async () => {
    if (!attachmentId || !vault) return;
    const encPrivateKey = vault['encPrivateKey'] as string | undefined;
    if (!encPrivateKey) {
      setError('Encryption key not available');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Use original filename so the OS can identify the file type when sharing
      const safeName = fileName
        ? fileName.replace(/[^a-z0-9._-]/gi, '_')
        : attachmentId.replace(/[^a-z0-9]/gi, '_');
      const cacheFile = `${CACHE_DIR}${safeName}`;
      const cacheInfo = await FileSystem.getInfoAsync(cacheFile);

      if (cacheInfo.exists) {
        setUri(cacheFile);
        setLoading(false);
        return;
      }

      // Ensure cache directory exists
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });

      const token = tokens.get(server.id) ?? '';

      // Use fetch (goes through RN's patched OkHttp) instead of FileSystem.downloadAsync
      // which creates its own OkHttpClient that bypasses the self-signed cert trust patch.
      const response = await fetch(
        `https://${server.address}/api/attachment/download?id=${attachmentId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      const arrayBuffer = await response.arrayBuffer();
      const encBytes = new Uint8Array(arrayBuffer);
      const decrypted = decryptFile(encBytes, senderIdentityKey, encPrivateKey);

      // Write decrypted bytes to cache file
      await FileSystem.writeAsStringAsync(cacheFile, uint8ArrayToBase64(decrypted), {
        encoding: FileSystem.EncodingType.Base64,
      });

      setUri(cacheFile);

      // For non-image/video files: save directly to user-chosen folder on Android,
      // or open share sheet with "Save to Files" on iOS.
      const isMedia = mimeType.startsWith('image/') || mimeType.startsWith('video/');
      if (!isMedia) {
        await saveToFiles(cacheFile, fileName ?? 'file', mimeType);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setLoading(false);
    }
  }, [attachmentId, fileName, mimeType, server, senderIdentityKey, vault, tokens]);

  // Auto-fetch images on mount
  if (autoFetch && !didAutoFetch.current && attachmentId) {
    didAutoFetch.current = true;
    download();
  }

  const saveFile = useCallback(async () => {
    if (!uri) return;
    const isImage = mimeType.startsWith('image/');
    const isVideo = mimeType.startsWith('video/');

    if (isImage || isVideo) {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') return;
      await MediaLibrary.saveToLibraryAsync(uri);
    } else {
      await saveToFiles(uri, fileName ?? 'file', mimeType);
    }
  }, [uri, mimeType, fileName]);

  return { uri, loading, error, download, saveFile };
}

async function saveToFiles(cacheUri: string, name: string, mimeType: string): Promise<void> {
  if (Platform.OS === 'android') {
    // StorageAccessFramework opens a folder picker and writes the file directly —
    // no share sheet, file lands in the chosen directory (e.g. Downloads).
    const { StorageAccessFramework } = FileSystem;
    const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!result.granted) return;
    const directoryUri = result.directoryUri;

    const safeName = name.replace(/[^a-z0-9._-]/gi, '_');
    const destUri = await StorageAccessFramework.createFileAsync(directoryUri, safeName, mimeType);
    const b64 = await FileSystem.readAsStringAsync(cacheUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    await FileSystem.writeAsStringAsync(destUri, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } else {
    // iOS: share sheet with "Save to Files" as the primary option
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(cacheUri, { mimeType, UTI: mimeType, dialogTitle: 'Save file' });
    }
  }
}
