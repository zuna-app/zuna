import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { FileIcon, DownloadIcon } from 'lucide-react-native';
import { useAttachmentDownload } from '@/hooks/chat/useAttachmentDownload';
import { Server, AttachmentMeta } from '@/types/serverTypes';

interface Props {
  server: Server;
  attachmentId: string;
  senderIdentityKey: string;
  meta: AttachmentMeta | undefined;
  onImagePress?: (uri: string) => void;
  onLongPress?: (e: import('react-native').GestureResponderEvent) => void;
}

export function AttachmentCard({
  server,
  attachmentId,
  senderIdentityKey,
  meta,
  onImagePress,
  onLongPress,
}: Props) {
  const mimeType = meta?.mimeType ?? 'application/octet-stream';
  const isImage = mimeType.startsWith('image/');
  const { uri, loading, error, download, saveFile } = useAttachmentDownload(
    server,
    attachmentId,
    senderIdentityKey,
    mimeType,
    isImage, // auto-fetch images
    meta?.name
  );

  if (isImage) {
    if (!uri && loading) {
      return (
        <View style={styles.imageLoading}>
          <ActivityIndicator color="#71717a" size="small" />
        </View>
      );
    }
    if (uri) {
      return (
        <Pressable onPress={() => onImagePress?.(uri)} onLongPress={onLongPress}>
          <Image source={{ uri }} style={styles.image} contentFit="cover" transition={200} />
        </Pressable>
      );
    }
  }

  return (
    <View style={styles.fileCard}>
      <View style={styles.fileRow}>
        <View style={styles.iconWrap}>
          <FileIcon size={18} color="#a1a1aa" />
        </View>
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={2}>
            {meta?.name ?? 'File'}
          </Text>
          {meta?.size != null && <Text style={styles.fileSize}>{formatBytes(meta.size)}</Text>}
        </View>
        {!uri ? (
          <Pressable style={styles.dlBtn} onPress={download} disabled={loading}>
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <DownloadIcon size={16} color="#fff" />
            )}
          </Pressable>
        ) : (
          <Pressable style={styles.dlBtn} onPress={saveFile}>
            <DownloadIcon size={16} color="#22c55e" />
          </Pressable>
        )}
      </View>
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  imageLoading: {
    width: 200,
    height: 150,
    backgroundColor: '#18181b',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: 220, height: 165, borderRadius: 12 },
  fileCard: {
    backgroundColor: '#18181b',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    maxWidth: 260,
    minWidth: 200,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  fileInfo: { flex: 1, minWidth: 0 },
  fileName: { color: '#fff', fontSize: 13, fontWeight: '500', flexShrink: 1 },
  fileSize: { color: '#71717a', fontSize: 11, marginTop: 2 },
  dlBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  errorText: { color: '#ef4444', fontSize: 11, marginTop: 6 },
});
