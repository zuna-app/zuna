import { Pressable, View, Text, StyleSheet } from 'react-native';
import { Avatar } from '@/components/ui/avatar';
import { ChatMember, LastMessage } from '@/types/serverTypes';

interface Props {
  member: ChatMember;
  lastMessage?: LastMessage;
  isSelected: boolean;
  onPress: () => void;
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ChatListItem({ member, lastMessage, isSelected, onPress }: Props) {
  const unread = lastMessage?.unreadMessages ?? member.unreadMessages ?? 0;
  const preview = lastMessage?.content ?? '';
  const ts = lastMessage?.lastActivityAt ?? member.lastActivityAt ?? 0;

  return (
    <Pressable style={[styles.item, isSelected && styles.itemSelected]} onPress={onPress}>
      <Avatar name={member.username} size={44} uri={member.avatar || null} />
      <View style={styles.content}>
        <View style={styles.row}>
          <Text style={styles.username} numberOfLines={1}>
            {member.username}
          </Text>
          {ts > 0 && <Text style={styles.time}>{formatTime(ts)}</Text>}
        </View>
        <View style={styles.row}>
          <Text style={[styles.preview, unread > 0 && styles.previewUnread]} numberOfLines={1}>
            {preview || ' '}
          </Text>
          {unread > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 12,
  },
  itemSelected: { backgroundColor: '#18181b' },
  content: { flex: 1, gap: 3 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  username: { color: '#fff', fontWeight: '600', fontSize: 15, flex: 1 },
  time: { color: '#52525b', fontSize: 12, marginLeft: 8 },
  preview: { color: '#71717a', fontSize: 13, flex: 1 },
  previewUnread: { color: '#a1a1aa', fontWeight: '500' },
  badge: {
    backgroundColor: '#fff',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    marginLeft: 8,
  },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '700' },
});
