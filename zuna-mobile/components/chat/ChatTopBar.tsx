import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeftIcon, PinIcon } from 'lucide-react-native';
import { Avatar } from '@/components/ui/avatar';
import { usePresence, useWriting } from '@/hooks/ws/usePresence';
import { ChatMember, Message } from '@/types/serverTypes';

interface Props {
  member: ChatMember;
  messages: Message[];
  onShowPinned: () => void;
}

export function ChatTopBar({ member, messages, onShowPinned }: Props) {
  const router = useRouter();
  const { getMemberPresence } = usePresence();
  const { isMemberTyping } = useWriting();

  const presence = getMemberPresence(member.id);
  const isOnline = presence?.active ?? false;
  const isTyping = isMemberTyping(member.id, member.chatId);
  const pinnedCount = messages.filter((m) => m.pinned).length;

  return (
    <View style={styles.container}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <ChevronLeftIcon size={22} color="#fff" />
      </Pressable>

      <Avatar name={member.username} size={34} uri={member.avatar || null} />

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {member.username}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, isOnline && styles.dotOnline]} />
          <Text style={styles.status}>
            {isTyping ? 'typing…' : isOnline ? 'online' : 'offline'}
          </Text>
        </View>
      </View>

      {pinnedCount > 0 && (
        <Pressable style={styles.pinBtn} onPress={onShowPinned}>
          <PinIcon size={16} color="#a1a1aa" />
          <Text style={styles.pinCount}>{pinnedCount}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#18181b',
    backgroundColor: '#0a0a0a',
    gap: 10,
  },
  backBtn: { padding: 4 },
  info: { flex: 1 },
  name: { color: '#fff', fontWeight: '600', fontSize: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#52525b' },
  dotOnline: { backgroundColor: '#22c55e' },
  status: { color: '#71717a', fontSize: 12 },
  pinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#18181b',
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 8,
  },
  pinCount: { color: '#a1a1aa', fontSize: 12, fontWeight: '600' },
});
