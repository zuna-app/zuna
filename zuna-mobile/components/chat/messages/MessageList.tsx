import { useRef, useEffect, useCallback, useMemo } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  View,
  StyleSheet,
  ActivityIndicator,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { MessageBubble } from './MessageBubble';
import { Message, Server, AttachmentMeta } from '@/types/serverTypes';

type GroupedMessage = Message & {
  isFirst: boolean;
  isLast: boolean;
};

function sameGroup(a: Message, b: Message): boolean {
  return a.senderId === b.senderId && b.sentAt - a.sentAt < 60 * 60 * 1000;
}

function groupMessages(messages: Message[]): GroupedMessage[] {
  return messages.map((msg, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    return {
      ...msg,
      isFirst: !prev || !sameGroup(prev, msg),
      isLast: !next || !sameGroup(msg, next),
    };
  });
}

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
  const listRef = useRef<FlatList<GroupedMessage>>(null);
  const isAtBottomRef = useRef(true);
  // Track the newest message key to distinguish new messages from pagination
  const prevNewestKeyRef = useRef<string | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupedMessages = useMemo(() => groupMessages(messages), [messages]);
  const groupedReversedMessages = useMemo(() => [...groupedMessages].reverse(), [groupedMessages]);

  const scrollToNewest = useCallback((animated: boolean) => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      listRef.current?.scrollToIndex({ index: 0, animated });
      scrollTimerRef.current = null;
    }, 30);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  // Auto-scroll only when the newest message actually changes, not on pagination
  useEffect(() => {
    if (messages.length === 0) return;

    // messages is oldest-first; last element is the newest
    const newest = messages[messages.length - 1];
    // Use same key priority as keyExtractor: localId first, then id
    const newestKey =
      newest?.localId != null
        ? `local-${newest.localId}`
        : newest?.id != null
          ? `id-${newest.id}`
          : null;

    if (newestKey === prevNewestKeyRef.current) return;
    prevNewestKeyRef.current = newestKey;

    if (newest?.isOwn || isAtBottomRef.current) {
      // Outgoing messages should appear immediately for snappier send feedback.
      scrollToNewest(!newest?.isOwn);
    }
  }, [messages, scrollToNewest]);

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
  }, [scrollToId, messages]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<GroupedMessage>) => (
      <MessageBubble
        message={item}
        isFirst={item.isFirst}
        isLast={item.isLast}
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
    <FlatList
      ref={listRef}
      data={groupedReversedMessages}
      inverted
      keyExtractor={(m) => {
        if (m.localId != null) return `local-${m.localId}`;
        if (m.id != null) return `id-${m.id}`;
        return `fallback-${m.senderId}-${m.sentAt}`;
      }}
      renderItem={renderItem}
      extraData={getPlaintext}
      onScroll={handleScroll}
      scrollEventThrottle={100}
      onEndReached={hasMore ? onFetchMore : undefined}
      onEndReachedThreshold={0.3}
      // Prevents scroll-position jump when older messages are prepended during pagination
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScrollToIndexFailed={() => {
        listRef.current?.scrollToEnd({ animated: false });
      }}
      // ListFooterComponent = visual top (history loading indicator when scrolled up)
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
