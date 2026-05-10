import { Pressable, View, Text, StyleSheet } from 'react-native';
import { Avatar } from '@/components/ui/avatar';
import { usePresence } from '@/hooks/ws/usePresence';
import { convertTimeToRelative } from '@/lib/utils';
import { ChatMember, LastMessage } from '@/types/serverTypes';

interface Props {
  member: ChatMember;
  lastMessage?: LastMessage;
  isSelected: boolean;
  onPress: () => void;
}

export function ChatListItem({ member, lastMessage, isSelected, onPress }: Props) {
  const { getMemberPresence } = usePresence();

  const presence = getMemberPresence(member.id);
  const isOnline = presence?.active ?? false;
  const unread = member.unreadMessages ?? 0;
  const preview = lastMessage?.content?.trim() ? lastMessage.content : 'No messages yet';
  const ts = lastMessage?.lastActivityAt ?? member.lastActivityAt ?? 0;

  return (
    <Pressable style={[styles.item, isSelected && styles.itemSelected]} onPress={onPress}>
      <View style={styles.avatarWrap}>
        <Avatar name={member.username} size={44} uri={member.avatar || null} />
        <View style={[styles.dot, isOnline && styles.dotOnline]} />
      </View>
      <View style={styles.content}>
        <View style={styles.row}>
          <Text style={styles.username} numberOfLines={1}>
            {member.username}
          </Text>
          {ts > 0 && <Text style={styles.time}>{convertTimeToRelative(ts)}</Text>}
        </View>
        <View style={styles.row}>
          <Text style={[styles.preview, unread > 0 && styles.previewUnread]} numberOfLines={1}>
            {preview}
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
  avatarWrap: { position: 'relative' },
  content: { flex: 1, gap: 3 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
