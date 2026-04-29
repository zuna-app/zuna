import { useState, useCallback, useRef } from 'react';
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
  autoFetch = false
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
      // Check cache first
      const cacheKey = attachmentId.replace(/[^a-z0-9]/gi, '_');
      const cacheFile = `${CACHE_DIR}${cacheKey}`;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setLoading(false);
    }
  }, [attachmentId, server, senderIdentityKey, vault, tokens]);

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
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Save file' });
      }
    }
  }, [uri, mimeType]);

  return { uri, loading, error, download, saveFile };
}
