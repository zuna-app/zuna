import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { XIcon, FileIcon } from 'lucide-react-native';

export interface PendingFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
}

interface Props {
  file: PendingFile;
  onRemove: () => void;
}

export function AttachmentPreview({ file, onRemove }: Props) {
  const isImage = file.mimeType.startsWith('image/');

  return (
    <View style={styles.container}>
      {isImage ? (
        <Image source={{ uri: file.uri }} style={styles.thumb} contentFit="cover" />
      ) : (
        <View style={styles.fileIcon}>
          <FileIcon size={20} color="#a1a1aa" />
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{file.name}</Text>
        <Text style={styles.size}>{formatBytes(file.size)}</Text>
      </View>
      <Pressable style={styles.removeBtn} onPress={onRemove} hitSlop={8}>
        <XIcon size={16} color="#71717a" />
      </Pressable>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#18181b', margin: 8, borderRadius: 12,
    paddingVertical: 8, paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#27272a',
  },
  thumb: { width: 48, height: 48, borderRadius: 8 },
  fileIcon: {
    width: 48, height: 48, borderRadius: 8,
    backgroundColor: '#27272a', alignItems: 'center', justifyContent: 'center',
  },
  info: { flex: 1 },
  name: { color: '#fff', fontSize: 13, fontWeight: '500' },
  size: { color: '#71717a', fontSize: 11, marginTop: 2 },
  removeBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#27272a', alignItems: 'center', justifyContent: 'center',
  },
});
