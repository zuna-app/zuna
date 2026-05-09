import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeftIcon, PinIcon, ShieldIcon } from 'lucide-react-native';
import { Avatar } from '@/components/ui/avatar';
import { usePresence, useWriting } from '@/hooks/ws/usePresence';
import { convertTimeToRelative } from '@/lib/utils';
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
  const isTyping = isOnline && isMemberTyping(member.id, member.chatId);
  const pinnedCount = messages.filter((m) => m.pinned).length;

  return (
    <View style={styles.container}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <ChevronLeftIcon size={22} color="#fff" />
      </Pressable>

      <View style={styles.avatarWrap}>
        <Avatar name={member.username} size={44} uri={member.avatar || null} />
        <View style={[styles.dot, isOnline && styles.dotOnline]} />
      </View>

      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {member.username}
          </Text>
          <View style={styles.encryptedBadge}>
            <ShieldIcon size={10} color="#a1a1aa" />
            <Text style={styles.encryptedText}>Encrypted</Text>
          </View>
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.status}>
            {isTyping
              ? 'typing…'
              : isOnline
                ? 'online'
                : `Last seen ${presence?.lastSeen ? convertTimeToRelative(presence.lastSeen) : 'sometimes ago'}`}
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
  avatarWrap: { position: 'relative' },
  info: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: '#fff', fontWeight: '600', fontSize: 16, flexShrink: 1 },
  encryptedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#18181b',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  encryptedText: { color: '#a1a1aa', fontSize: 11, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 1 },
  dot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#52525b',
    borderWidth: 2,
    borderColor: '#0a0a0a',
  },
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
