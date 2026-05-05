import { useState, useRef, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useAtomValue } from 'jotai';
import { jotaiStore, serverListAtom, vaultAtom } from '@/store/atoms';
import { useChatList } from '@/hooks/chat/useChatList';
import { useMessages } from '@/hooks/chat/useMessages';
import { useSharedSecret } from '@/hooks/ws/useSharedSecret';
import { useMessageDecryption } from '@/hooks/chat/useMessageDecryption';
import { useWsConnection } from '@/hooks/ws/useWsConnection';
import { WS_MSG } from '@/hooks/ws/wsTypes';
import { ChatTopBar } from '@/components/chat/ChatTopBar';
import { MessageList } from '@/components/chat/messages/MessageList';
import { ChatInput } from '@/components/chat/input/ChatInput';
import { PinnedMessagesSheet } from '@/components/chat/messages/PinnedMessagesSheet';
import { ImageLightbox } from '@/components/chat/messages/ImageLightbox';
import { Message } from '@/types/serverTypes';

export default function ChatScreen() {
  const { serverId, chatId } = useLocalSearchParams<{ serverId: string; chatId: string }>();

  const serverList = useAtomValue(serverListAtom, { store: jotaiStore });
  const server = serverList.find((s) => s.id === serverId)!;

  const { data: members = [] } = useChatList(server);
  const member = members.find((m) => m.chatId === chatId);

  const sharedSecret = useSharedSecret(member ?? null);

  const {
    messages,
    loading,
    hasMore,
    sendMessage,
    sendReplyMessage,
    editMessage,
    deleteMessage,
    togglePinMessage,
    uploadAndSend,
    fetchMore,
    readyState,
  } = useMessages(server, chatId, sharedSecret, member?.identityKey ?? '');

  const { getPlaintext, getAttachmentMeta } = useMessageDecryption(messages, sharedSecret);
  const { sendMessage: wsSend } = useWsConnection(server);

  // UI state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [showPinned, setShowPinned] = useState(false);
  const [lightboxUri, setLightboxUri] = useState<string | null>(null);
  const [scrollToId, setScrollToId] = useState<number | null>(null);

  const handleReply = useCallback((msg: Message) => {
    setReplyingTo(msg);
    setEditingMessage(null);
  }, []);

  const handleEdit = useCallback((msg: Message) => {
    setEditingMessage(msg);
    setReplyingTo(null);
  }, []);

  const handleWriting = useCallback(
    (writing: boolean) => {
      if (!member) return;
      wsSend(WS_MSG.WRITE, { chat_id: chatId, writing });
    },
    [wsSend, chatId, member]
  );

  if (!server || !member) return null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ChatTopBar member={member} messages={messages} onShowPinned={() => setShowPinned(true)} />

      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <MessageList
          messages={messages}
          loading={loading}
          hasMore={hasMore}
          sharedSecret={sharedSecret}
          server={server}
          // senderName={member.username}
          // senderAvatar={member.avatar || null}
          senderIdentityKey={member.identityKey}
          getPlaintext={getPlaintext}
          getAttachmentMeta={getAttachmentMeta}
          onReply={handleReply}
          onEdit={handleEdit}
          onDelete={deleteMessage}
          onPin={togglePinMessage}
          onFetchMore={fetchMore}
          onImagePress={setLightboxUri}
          scrollToId={scrollToId}
        />

        <ChatInput
          sharedSecret={sharedSecret}
          replyingTo={replyingTo}
          editingMessage={editingMessage}
          getPlaintext={getPlaintext}
          onSend={sendMessage}
          onSendReply={sendReplyMessage}
          onEdit={editMessage}
          onUpload={uploadAndSend}
          onCancelReply={() => setReplyingTo(null)}
          onCancelEdit={() => setEditingMessage(null)}
          onWriting={handleWriting}
        />
      </KeyboardAvoidingView>

      <PinnedMessagesSheet
        visible={showPinned}
        messages={messages}
        getPlaintext={getPlaintext}
        onClose={() => setShowPinned(false)}
        onScrollTo={(id) => {
          setScrollToId(id);
          setShowPinned(false);
        }}
        onUnpin={togglePinMessage}
      />

      <ImageLightbox uri={lightboxUri} onClose={() => setLightboxUri(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  flex: { flex: 1 },
});
