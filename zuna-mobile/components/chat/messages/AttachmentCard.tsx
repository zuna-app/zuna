import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import {
  FileIcon,
  DownloadIcon,
  MusicIcon,
  PauseIcon,
  PlayCircleIcon,
  PlayIcon,
} from 'lucide-react-native';
import { useAttachmentDownload } from '@/hooks/chat/useAttachmentDownload';
import { Server, AttachmentMeta } from '@/types/serverTypes';

const VIDEO_AUTO_FETCH_LIMIT = 50 * 1024 * 1024; // 50 MB - auto-download
const VIDEO_MAX_INLINE_SIZE = 200 * 1024 * 1024; // 200 MB - above this, generic file card
const AUDIO_AUTO_FETCH_LIMIT = 25 * 1024 * 1024; // 25 MB - auto-download
const AUDIO_MAX_INLINE_SIZE = 100 * 1024 * 1024; // 100 MB - above this, generic file card

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

function AudioPlayer({ uri }: { uri: string }) {
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  const [trackWidth, setTrackWidth] = useState(0);

  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <View style={styles.audioPlayer}>
      <Pressable
        style={styles.audioPlayBtn}
        onPress={() => (status.playing ? player.pause() : player.play())}
        hitSlop={8}>
        {status.playing ? (
          <PauseIcon size={22} color="#a1a1aa" />
        ) : (
          <PlayIcon size={22} color="#a1a1aa" />
        )}
      </Pressable>
      <View style={styles.audioRight}>
        <Pressable
          style={styles.audioTrack}
          onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
          onPress={(e) => {
            if (trackWidth > 0 && status.duration > 0) {
              const ratio = Math.min(Math.max(e.nativeEvent.locationX / trackWidth, 0), 1);
              player.seekTo(ratio * status.duration);
            }
          }}>
          <View style={[styles.audioTrackFill, { width: trackWidth * progress }]} />
        </Pressable>
        <Text style={styles.audioTime}>
          {formatAudioTime(status.currentTime)} / {formatAudioTime(status.duration)}
        </Text>
      </View>
    </View>
  );
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
  const isAudio = mimeType.startsWith('audio/');
  const isInlineVideo = isVideo && (meta == null || meta.size <= VIDEO_MAX_INLINE_SIZE);
  const videoAutoFetch = isVideo && meta != null && meta.size <= VIDEO_AUTO_FETCH_LIMIT;
  const isInlineAudio = isAudio && meta != null && meta.size <= AUDIO_MAX_INLINE_SIZE;
  const audioAutoFetch = isAudio && meta != null && meta.size <= AUDIO_AUTO_FETCH_LIMIT;

  const { uri, loading, error, download, saveFile } = useAttachmentDownload(
    server,
    attachmentId,
    senderIdentityKey,
    mimeType,
    isImage || videoAutoFetch || audioAutoFetch,
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
    return (
      <Pressable style={styles.videoPlaceholder} onPress={download} onLongPress={onLongPress}>
        <PlayCircleIcon size={36} color="#71717a" />
        {meta && <Text style={styles.videoSize}>{formatBytes(meta.size)}</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </Pressable>
    );
  }

  if (isInlineAudio) {
    return (
      <View style={styles.fileCard}>
        <View style={styles.fileRow}>
          <View style={styles.iconWrap}>
            <MusicIcon size={18} color="#a1a1aa" />
          </View>
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>
              {meta?.name ?? 'Audio'}
            </Text>
            {meta?.size != null && <Text style={styles.fileSize}>{formatBytes(meta.size)}</Text>}
          </View>
        </View>
        {uri ? (
          <AudioPlayer uri={uri} />
        ) : loading ? (
          <View style={styles.audioLoading}>
            <ActivityIndicator color="#71717a" size="small" />
            <Text style={styles.audioLoadingText}>Loading…</Text>
          </View>
        ) : (
          <>
            <Pressable style={styles.audioLoadBtn} onPress={download}>
              <PlayIcon size={14} color="#71717a" />
              <Text style={styles.audioLoadBtnText}>
                {meta ? formatBytes(meta.size) : 'Load audio'}
              </Text>
            </Pressable>
            {error && <Text style={styles.errorText}>{error}</Text>}
          </>
        )}
      </View>
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

function formatAudioTime(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
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
  audioPlayer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  audioPlayBtn: {
    flexShrink: 0,
  },
  audioRight: {
    flex: 1,
    gap: 5,
  },
  audioTrack: {
    height: 3,
    backgroundColor: '#3f3f46',
    borderRadius: 2,
  },
  audioTrackFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: '#a1a1aa',
    borderRadius: 2,
  },
  audioTime: {
    color: '#71717a',
    fontSize: 11,
  },
  audioLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
  },
  audioLoadingText: {
    color: '#71717a',
    fontSize: 12,
  },
  audioLoadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: '#27272a',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  audioLoadBtnText: {
    color: '#71717a',
    fontSize: 12,
  },
});
