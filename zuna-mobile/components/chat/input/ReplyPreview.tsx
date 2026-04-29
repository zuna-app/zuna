import { View, Text, Pressable, StyleSheet } from 'react-native';
import { XIcon, ReplyIcon } from 'lucide-react-native';
import { Message } from '@/types/serverTypes';

interface Props {
  message: Message;
  getPlaintext: (msg: Message) => string | undefined;
  onDismiss: () => void;
}

export function ReplyPreview({ message, getPlaintext, onDismiss }: Props) {
  const text = message.attachmentId
    ? '📎 Attachment'
    : (getPlaintext(message) ?? message.plaintext ?? '…');

  return (
    <View style={styles.container}>
      <ReplyIcon size={14} color="#71717a" />
      <Text style={styles.text} numberOfLines={1}>{text}</Text>
      <Pressable onPress={onDismiss} hitSlop={8}>
        <XIcon size={16} color="#71717a" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#18181b',
    paddingVertical: 8, paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#27272a',
  },
  text: { flex: 1, color: '#71717a', fontSize: 13 },
});
