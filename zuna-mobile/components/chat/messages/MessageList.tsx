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

interface Props {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  sharedSecret: string | null;
  server: Server;
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
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollToNewest = useCallback((animated: boolean) => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      listRef.current?.scrollToIndex({ index: 0, animated });
      scrollTimerRef.current = null;
    }, 100);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (messages.length === 0) return;

    const prevLen = prevLengthRef.current;
    prevLengthRef.current = messages.length;

    if (messages.length <= prevLen) return; // pagination, don't scroll

    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.isOwn || isAtBottomRef.current) {
      scrollToNewest(true);
    }
  }, [messages.length, scrollToNewest]);

  // With inverted list, offset 0 = newest messages (visual bottom)
  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    isAtBottomRef.current = e.nativeEvent.contentOffset.y < 80;
  }, []);

  useEffect(() => {
    if (scrollToId == null) return;
    const idx = messages.findIndex((m) => m.id === scrollToId);
    if (idx !== -1) {
      // inverted list: index in reversed array
      listRef.current?.scrollToIndex({ index: messages.length - 1 - idx, animated: true });
    }
  }, [scrollToId]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => (
      <MessageBubble
        message={item}
        plaintext={getPlaintext(item)}
        attachmentMeta={getAttachmentMeta(item)}
        sharedSecret={sharedSecret}
        senderIdentityKey={senderIdentityKey}
        server={server}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
        onPin={onPin}
        onScrollToMessage={(id) => {
          const idx = messages.findIndex((m) => m.id === id);
          if (idx !== -1)
            listRef.current?.scrollToIndex({ index: messages.length - 1 - idx, animated: true });
        }}
        onImagePress={onImagePress}
      />
    ),
    [messages, getPlaintext, getAttachmentMeta, sharedSecret, server]
  );

  return (
    <FlashList
      ref={listRef}
      data={[...messages].reverse()}
      inverted
      estimatedItemSize={72}
      keyExtractor={(m, i) => (m.id != null ? String(m.id) : `local-${m.localId}-${i}`)}
      renderItem={renderItem}
      extraData={getPlaintext}
      onScroll={handleScroll}
      scrollEventThrottle={100}
      onEndReached={hasMore ? onFetchMore : undefined}
      onEndReachedThreshold={0.3}
      ListHeaderComponent={
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
