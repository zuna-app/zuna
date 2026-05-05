import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Modal,
  Image,
  useWindowDimensions,
  GestureResponderEvent,
  Animated,
  Easing,
} from 'react-native';
import {
  CheckIcon,
  CheckCheckIcon,
  ClockIcon,
  ReplyIcon,
  PinIcon,
  PinOffIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react-native';
import { AttachmentCard } from './AttachmentCard';
import { ReplyBubble } from './ReplyBubble';
import { Message, Server, AttachmentMeta } from '@/types/serverTypes';
import { EmoteV3, getEmoteDisplaySize } from '@/lib/seventv';

const EMOTE_SPLIT_RE = /(\b[a-zA-Z0-9_]+\b)/g;

interface Props {
  message: Message;
  isFirst: boolean;
  isLast: boolean;
  plaintext: string | undefined;
  attachmentMeta: AttachmentMeta | undefined;
  emoteMap: ReadonlyMap<string, string>;
  emoteDataMap: ReadonlyMap<string, EmoteV3>;
  sharedSecret: string | null;
  senderIdentityKey: string;
  server: Server;
  onReply: (msg: Message) => void;
  onEdit: (msg: Message) => void;
  onDelete: (id: number) => void;
  onPin: (id: number) => void;
  onScrollToMessage: (id: number) => void;
  onImagePress: (uri: string) => void;
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

function renderMessageText(
  text: string,
  isOwn: boolean,
  emoteMap: ReadonlyMap<string, string>,
  emoteDataMap: ReadonlyMap<string, EmoteV3>,
) {
  return text.split(EMOTE_SPLIT_RE).map((part, index) => {
    const src = emoteMap.get(part);
    if (!src) {
      if (!part) return null;
      return (
        <Text key={`text-${index}`} style={[styles.text, isOwn && styles.textOwn]}>
          {part}
        </Text>
      );
    }

    const emote = emoteDataMap.get(part);
    const dimensions = emote ? getEmoteDisplaySize(emote) : null;
    const height = 28;
    const width = dimensions
      ? Math.max(24, Math.round((dimensions.width / dimensions.height) * height))
      : height;

    return <Image key={`emote-${index}`} source={{ uri: src }} style={[styles.emote, { width, height }]} />;
  });
}

export function MessageBubble({
  message,
  isFirst,
  isLast,
  plaintext,
  attachmentMeta,
  emoteMap,
  emoteDataMap,
  sharedSecret,
  senderIdentityKey,
  server,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onScrollToMessage,
  onImagePress,
}: Props) {
  const { width, height } = useWindowDimensions();
  const isOwn = message.isOwn;
  const shouldAnimateEnter = isOwn && message.localId != null;
  const enterAnim = useRef(new Animated.Value(shouldAnimateEnter ? 0 : 1)).current;
  const status = getStatus(message);
  const text = plaintext ?? message.plaintext ?? '';
  const hasPendingUpload = message.uploadProgress != null;
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!shouldAnimateEnter) {
      enterAnim.setValue(1);
      return;
    }

    enterAnim.setValue(0);
    Animated.timing(enterAnim, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enterAnim, shouldAnimateEnter]);

  const enterStyle = {
    opacity: enterAnim,
    transform: [
      {
        translateY: enterAnim.interpolate({
          inputRange: [0, 1],
          outputRange: [8, 0],
        }),
      },
    ],
  };

  const menuItems = [
    {
      key: 'reply',
      label: 'Reply',
      icon: ReplyIcon,
      onPress: () => onReply(message),
      destructive: false,
    },
    ...(isOwn
      ? [
          {
            key: 'edit',
            label: 'Edit',
            icon: PencilIcon,
            onPress: () => onEdit(message),
            destructive: false,
          },
        ]
      : []),
    {
      key: 'pin',
      label: message.pinned ? 'Unpin' : 'Pin',
      icon: message.pinned ? PinOffIcon : PinIcon,
      onPress: () => message.id && onPin(message.id),
      destructive: false,
    },
    ...(isOwn && message.id != null
      ? [
          {
            key: 'delete',
            label: 'Delete',
            icon: Trash2Icon,
            onPress: () => onDelete(message.id!),
            destructive: true,
          },
        ]
      : []),
  ];

  const menuWidth = 188;
  const menuHeight = menuItems.length * 44 + 12;
  const menuLeft = Math.min(Math.max(menuAnchor.x - menuWidth / 2, 12), width - menuWidth - 12);
  const menuTop = Math.min(Math.max(menuAnchor.y - menuHeight - 10, 12), height - menuHeight - 20);

  function showActions(e: GestureResponderEvent) {
    setMenuAnchor({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
    setMenuVisible(true);
  }

  function handleMenuAction(action: () => void) {
    setMenuVisible(false);
    action();
  }

  return (
    <Animated.View style={[styles.row, isFirst ? styles.rowFirst : styles.rowGrouped, isOwn && styles.rowOwn, enterStyle]}>
      <Pressable
        style={[
          styles.bubble,
          isOwn
            ? isFirst && isLast
              ? styles.bubbleOwnSingle
              : isFirst
                ? styles.bubbleOwnFirst
                : isLast
                  ? styles.bubbleOwnLast
                  : styles.bubbleOwnMiddle
            : isFirst && isLast
              ? styles.bubbleOtherSingle
              : isFirst
                ? styles.bubbleOtherFirst
                : isLast
                  ? styles.bubbleOtherLast
                  : styles.bubbleOtherMiddle,
        ]}
        onLongPress={showActions}>
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
            <View style={[styles.progressBar, { width: `${message.uploadProgress ?? 0}%` }]} />
            <Text style={styles.uploadText}>{message.uploadProgress}%</Text>
          </View>
        )}

        {text || !message.attachmentId ? (
          <View style={styles.textRow}>
            <View style={styles.textContent}>
              {renderMessageText(text || '', isOwn, emoteMap, emoteDataMap)}
            </View>
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
          </View>
        ) : (
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
        )}
      </Pressable>

      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <Pressable style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <View style={[styles.menu, { left: menuLeft, top: menuTop, width: menuWidth }]}>
            {menuItems.map((item, idx) => {
              const Icon = item.icon;
              return (
                <Pressable
                  key={item.key}
                  style={[styles.menuItem, idx !== menuItems.length - 1 && styles.menuItemBorder]}
                  onPress={() => handleMenuAction(item.onPress)}>
                  <Icon size={16} color={item.destructive ? '#ef4444' : '#e4e4e7'} />
                  <Text style={[styles.menuItemText, item.destructive && styles.menuItemTextDestructive]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    gap: 6,
  },
  rowFirst: { marginTop: 6 },
  rowGrouped: { marginTop: 1 },
  rowOwn: { flexDirection: 'row-reverse' },
  bubble: {
    maxWidth: '78%',
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 4,
  },
  bubbleOwnSingle: {
    backgroundColor: '#27272a',
    borderRadius: 18,
  },
  bubbleOwnFirst: {
    backgroundColor: '#27272a',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 4,
  },
  bubbleOwnLast: {
    backgroundColor: '#27272a',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
  },
  bubbleOwnMiddle: {
    backgroundColor: '#27272a',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 4,
  },
  bubbleOtherSingle: {
    backgroundColor: '#18181b',
    borderRadius: 18,
  },
  bubbleOtherFirst: {
    backgroundColor: '#18181b',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 4,
    borderBottomRightRadius: 18,
  },
  bubbleOtherLast: {
    backgroundColor: '#18181b',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
  },
  bubbleOtherMiddle: {
    backgroundColor: '#18181b',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 4,
    borderBottomRightRadius: 18,
  },
  text: { color: '#fff', fontSize: 15, lineHeight: 21, flexShrink: 1 },
  textOwn: { color: '#f4f4f5' },
  emote: {
    marginVertical: 1,
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
  },
  textContent: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    flexShrink: 1,
    gap: 0,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-end',
    marginBottom: 1,
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
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.22)',
  },
  menu: {
    position: 'absolute',
    backgroundColor: '#09090b',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  menuItemBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#27272a',
  },
  menuItemText: {
    color: '#f4f4f5',
    fontSize: 14,
    fontWeight: '500',
  },
  menuItemTextDestructive: {
    color: '#ef4444',
  },
});
