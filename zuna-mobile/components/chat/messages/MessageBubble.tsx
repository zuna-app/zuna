import { View, Text, Pressable, StyleSheet, ActionSheetIOS, Platform, Alert } from 'react-native';
import { CheckIcon, CheckCheckIcon, ClockIcon } from 'lucide-react-native';
import { Avatar } from '@/components/ui/avatar';
import { AttachmentCard } from './AttachmentCard';
import { ReplyBubble } from './ReplyBubble';
import { Message, Server, AttachmentMeta } from '@/types/serverTypes';

interface Props {
  message: Message;
  plaintext: string | undefined;
  attachmentMeta: AttachmentMeta | undefined;
  sharedSecret: string | null;
  senderName: string;
  senderAvatar?: string | null;
  senderIdentityKey: string;
  server: Server;
  onReply: (msg: Message) => void;
  onEdit: (msg: Message) => void;
  onDelete: (id: number) => void;
  onPin: (id: number) => void;
  onScrollToMessage: (id: number) => void;
  onImagePress: (uri: string) => void;
  showAvatar: boolean;
}

type Status = 'pending' | 'sent' | 'read';

function getStatus(msg: Message): Status {
  if (msg.pending) return 'pending';
  if (msg.readAt) return 'read';
  return 'sent';
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({
  message,
  plaintext,
  attachmentMeta,
  sharedSecret,
  senderName,
  senderAvatar,
  senderIdentityKey,
  server,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onScrollToMessage,
  onImagePress,
  showAvatar,
}: Props) {
  const isOwn = message.isOwn;
  const status = getStatus(message);
  const text = plaintext ?? message.plaintext ?? '';
  const hasPendingUpload = message.uploadProgress != null;

  function showActions() {
    const options = [
      'Reply',
      ...(isOwn ? ['Edit'] : []),
      message.pinned ? 'Unpin' : 'Pin',
      ...(isOwn ? ['Delete'] : []),
      'Cancel',
    ];
    const destructiveIndex = isOwn ? options.indexOf('Delete') : -1;
    const cancelIndex = options.length - 1;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
        (idx) => handleAction(options[idx])
      );
    } else {
      Alert.alert('Message', undefined, [
        { text: 'Reply', onPress: () => onReply(message) },
        ...(isOwn ? [{ text: 'Edit', onPress: () => onEdit(message) }] : []),
        { text: message.pinned ? 'Unpin' : 'Pin', onPress: () => message.id && onPin(message.id) },
        ...(isOwn && message.id != null
          ? [
              {
                text: 'Delete',
                style: 'destructive' as const,
                onPress: () => onDelete(message.id!),
              },
            ]
          : []),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }

  function handleAction(action: string) {
    if (action === 'Reply') onReply(message);
    else if (action === 'Edit') onEdit(message);
    else if (action === 'Pin' || action === 'Unpin') message.id && onPin(message.id);
    else if (action === 'Delete') message.id && onDelete(message.id);
  }

  return (
    <View style={[styles.row, isOwn && styles.rowOwn]}>
      {!isOwn && (
        <View style={styles.avatarSlot}>
          {showAvatar ? <Avatar name={senderName} size={30} uri={senderAvatar ?? null} /> : null}
        </View>
      )}

      <Pressable
        style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}
        onLongPress={showActions}>
        {!isOwn && showAvatar && <Text style={styles.senderName}>{senderName}</Text>}

        {message.isReply && message.replyInfo && (
          <ReplyBubble
            replyInfo={message.replyInfo}
            sharedSecret={sharedSecret}
            onPress={() => message.replyInfo && onScrollToMessage(message.replyInfo.id)}
          />
        )}

        {message.attachmentId && (
          <AttachmentCard
            server={server}
            attachmentId={message.attachmentId}
            senderIdentityKey={senderIdentityKey}
            meta={attachmentMeta}
            onImagePress={onImagePress}
          />
        )}

        {hasPendingUpload && (
          <View style={styles.uploadProgress}>
            <View style={[styles.progressBar, { width: `${message.uploadProgress}%` }]} />
            <Text style={styles.uploadText}>{message.uploadProgress}%</Text>
          </View>
        )}

        {text || !message.attachmentId ? (
          <Text style={[styles.text, isOwn && styles.textOwn]}>{text || ''}</Text>
        ) : null}

        <View style={styles.footer}>
          {message.modified && <Text style={styles.edited}>(edited)</Text>}
          {message.pinned && <Text style={styles.pinned}>📌</Text>}
          <Text style={styles.time}>{formatTime(message.sentAt)}</Text>
          {isOwn && (
            <View style={styles.statusIcon}>
              {status === 'pending' && <ClockIcon size={12} color="#71717a" />}
              {status === 'sent' && <CheckIcon size={12} color="#71717a" />}
              {status === 'read' && <CheckCheckIcon size={12} color="#60a5fa" />}
            </View>
          )}
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: 2,
    paddingHorizontal: 12,
    gap: 6,
  },
  rowOwn: { flexDirection: 'row-reverse' },
  avatarSlot: { width: 30 },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 4,
  },
  bubbleOwn: { backgroundColor: '#27272a', borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: '#18181b', borderBottomLeftRadius: 4 },
  senderName: { color: '#a1a1aa', fontSize: 12, fontWeight: '600', marginBottom: 2 },
  text: { color: '#fff', fontSize: 15, lineHeight: 21 },
  textOwn: { color: '#f4f4f5' },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  time: { color: '#71717a', fontSize: 11 },
  edited: { color: '#52525b', fontSize: 11 },
  pinned: { fontSize: 11 },
  statusIcon: { marginLeft: 2 },
  uploadProgress: {
    height: 6,
    backgroundColor: '#27272a',
    borderRadius: 3,
    width: 180,
    overflow: 'hidden',
    marginBottom: 4,
  },
  progressBar: { height: 6, backgroundColor: '#fff', borderRadius: 3 },
  uploadText: { color: '#71717a', fontSize: 11, marginTop: 2 },
});
