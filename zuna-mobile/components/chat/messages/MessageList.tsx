import { useRef, useEffect, useCallback } from 'react';
import { FlashList, ListRenderItemInfo } from '@shopify/flash-list';
import {
  View,
  StyleSheet,
  ActivityIndicator,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { MessageBubble } from './MessageBubble';
import { Message, Server, AttachmentMeta } from '@/types/serverTypes';

const FIVE_MIN = 5 * 60 * 1000;

interface Props {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  sharedSecret: string | null;
  server: Server;
  senderName: string;
  senderAvatar?: string | null;
  senderIdentityKey: string;
  getPlaintext: (msg: Message) => string | undefined;
  getAttachmentMeta: (msg: Message) => AttachmentMeta | undefined;
  onReply: (msg: Message) => void;
  onEdit: (msg: Message) => void;
  onDelete: (id: number) => void;
  onPin: (id: number) => void;
  onFetchMore: () => void;
  onImagePress: (uri: string) => void;
  scrollToId?: number | null;
}

export function MessageList({
  messages,
  loading,
  hasMore,
  sharedSecret,
  server,
  senderName,
  senderAvatar,
  senderIdentityKey,
  getPlaintext,
  getAttachmentMeta,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onFetchMore,
  onImagePress,
  scrollToId,
}: Props) {
  const listRef = useRef<FlashList<Message>>(null);
  const isAtBottomRef = useRef(true);
  const prevLengthRef = useRef(messages.length);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    const prevLen = prevLengthRef.current;
    prevLengthRef.current = messages.length;

    if (messages.length <= prevLen) return; // no new messages (e.g. pagination prepend)

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.isOwn || isAtBottomRef.current) {
      // Small delay so FlashList has laid out the new item
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [messages.length]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    isAtBottomRef.current = distanceFromBottom < 80;
  }, []);

  useEffect(() => {
    if (scrollToId == null) return;
    const idx = messages.findIndex((m) => m.id === scrollToId);
    if (idx !== -1) {
      listRef.current?.scrollToIndex({ index: idx, animated: true });
    }
  }, [scrollToId]);

  function shouldShowAvatar(index: number): boolean {
    const msg = messages[index];
    if (msg.isOwn) return false;
    const next = messages[index + 1];
    if (!next) return true;
    if (next.senderId !== msg.senderId) return true;
    if (msg.sentAt - next.sentAt > FIVE_MIN) return true;
    return false;
  }

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<Message>) => (
      <MessageBubble
        message={item}
        plaintext={getPlaintext(item)}
        attachmentMeta={getAttachmentMeta(item)}
        sharedSecret={sharedSecret}
        senderName={senderName}
        senderAvatar={senderAvatar}
        senderIdentityKey={senderIdentityKey}
        server={server}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        onPin={onPin}
        onScrollToMessage={(id) => {
          const idx = messages.findIndex((m) => m.id === id);
          if (idx !== -1) listRef.current?.scrollToIndex({ index: idx, animated: true });
        }}
        onImagePress={onImagePress}
        showAvatar={shouldShowAvatar(index)}
      />
    ),
    [messages, getPlaintext, getAttachmentMeta, sharedSecret, senderName, server]
  );

  return (
    <FlashList
      ref={listRef}
      data={messages}
      estimatedItemSize={72}
      keyExtractor={(m, i) => (m.id != null ? String(m.id) : `local-${m.localId}-${i}`)}
      renderItem={renderItem}
      extraData={getPlaintext}
      onScroll={handleScroll}
      scrollEventThrottle={100}
      onEndReached={hasMore ? onFetchMore : undefined}
      onEndReachedThreshold={0.3}
      ListFooterComponent={
        loading ? (
          <View style={styles.loader}>
            <ActivityIndicator color="#71717a" />
          </View>
        ) : null
      }
      contentContainerStyle={styles.content}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: 8 },
  loader: { padding: 16, alignItems: 'center' },
});
