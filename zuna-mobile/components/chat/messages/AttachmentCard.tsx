import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { FileIcon, DownloadIcon, PlayCircleIcon } from 'lucide-react-native';
import { useAttachmentDownload } from '@/hooks/chat/useAttachmentDownload';
import { Server, AttachmentMeta } from '@/types/serverTypes';

const VIDEO_AUTO_FETCH_LIMIT = 50 * 1024 * 1024;  // 50 MB — auto-download
const VIDEO_MAX_INLINE_SIZE = 200 * 1024 * 1024;  // 200 MB — above this, generic file card

interface Props {
  server: Server;
  attachmentId: string;
  senderIdentityKey: string;
  meta: AttachmentMeta | undefined;
  onImagePress?: (uri: string) => void;
  onLongPress?: (e: import('react-native').GestureResponderEvent) => void;
}

function VideoPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} style={styles.video} nativeControls />;
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
  const isVideo = mimeType.startsWith('video/');
  const isInlineVideo = isVideo && (meta == null || meta.size <= VIDEO_MAX_INLINE_SIZE);
  const videoAutoFetch = isVideo && meta != null && meta.size <= VIDEO_AUTO_FETCH_LIMIT;

  const { uri, loading, error, download, saveFile } = useAttachmentDownload(
    server,
    attachmentId,
    senderIdentityKey,
    mimeType,
    isImage || videoAutoFetch,
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

  if (isInlineVideo) {
    if (uri) {
      return <VideoPlayer uri={uri} />;
    }
    if (loading) {
      return (
        <View style={styles.videoPlaceholder}>
          <ActivityIndicator color="#71717a" size="small" />
        </View>
      );
    }
    // Not yet fetched — show tap-to-load prompt (always shown for >50 MB, shown on error retry too)
    return (
      <Pressable style={styles.videoPlaceholder} onPress={download} onLongPress={onLongPress}>
        <PlayCircleIcon size={36} color="#71717a" />
        {meta && <Text style={styles.videoSize}>{formatBytes(meta.size)}</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </Pressable>
    );
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
  video: { width: 220, height: 165, borderRadius: 12 },
  videoPlaceholder: {
    width: 220,
    height: 165,
    backgroundColor: '#18181b',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  videoSize: { color: '#71717a', fontSize: 12 },
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
