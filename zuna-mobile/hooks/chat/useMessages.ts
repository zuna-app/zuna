import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useWsConnection, ReadyState } from '@/hooks/ws/useWsConnection';
import { useWsHandler } from '@/hooks/ws/useWsHandler';
import {
  WS_MSG,
  MessageAckPayload,
  MessageReceivePayload,
  MessageReadInfoPayload,
  MessageDeleteReceivePayload,
  MessageModifyReceivePayload,
  MessagePinReceivePayload,
} from '@/hooks/ws/wsTypes';
import { useAuthorizedServerFetch } from '@/hooks/server/useServerFetch';
import { useAtomValue } from 'jotai';
import { jotaiStore, serverTokensAtom, vaultAtom } from '@/store/atoms';
import { useLastMessagesUpdater } from './useLastChatMessages';
import { encrypt, decrypt } from '@/lib/crypto/x25519';
import { encryptFile } from '@/lib/crypto/file';
import { generateUuid } from '@/lib/utils';
import { Server, Message, RawMessageDTO } from '@/types/serverTypes';

const MESSAGES_LIMIT = 50;
const MAX_CURSOR = '9223372036854775807';

async function xhrUpload(
  url: string,
  token: string,
  formData: FormData,
  onProgress: (pct: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 201) {
        try {
          const response = JSON.parse(xhr.responseText) as { attachment_id: string };
          resolve(response.attachment_id);
        } catch {
          reject(new Error('Invalid upload response'));
        }
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.send(formData);
  });
}

function isSameMessage(a: Pick<Message, 'id' | 'clientMessageId'>, b: Pick<Message, 'id' | 'clientMessageId'>) {
  return (a.id != null && b.id != null && a.id === b.id) || a.clientMessageId === b.clientMessageId;
}

function mergeMessages(base: Message[], incoming: Message[]): Message[] {
  const next = [...base];

  for (const message of incoming) {
    const existingIndex = next.findIndex((candidate) => isSameMessage(candidate, message));

    if (existingIndex === -1) {
      next.push(message);
      continue;
    }

    const existing = next[existingIndex];
    next[existingIndex] = {
      ...existing,
      ...message,
      plaintext: message.plaintext ?? existing.plaintext,
      uploadProgress: message.uploadProgress ?? existing.uploadProgress,
      attachmentFilename: message.attachmentFilename ?? existing.attachmentFilename,
    };
  }

  return next;
}

function mapRawMessage(chatId: string, serverId: string, message: RawMessageDTO): Message {
  return {
    id: message.id,
    clientMessageId: message.client_message_id,
    chatId,
    cipherText: message.cipher_text,
    iv: message.iv,
    authTag: message.auth_tag,
    sentAt: message.sent_at,
    readAt: message.read_at > 0 ? message.read_at : undefined,
    senderId: message.sender_id,
    isOwn: message.sender_id === serverId,
    pending: false,
    attachmentId: message.attachment_id,
    attachmentMetadata: message.attachment_metadata,
    attachmentMetadataIv: message.attachment_metadata_iv,
    attachmentMetadataAuthTag: message.attachment_metadata_auth_tag,
    modified: message.modified,
    pinned: message.pinned ?? message.pin ?? false,
    isReply: message.is_reply,
    replyInfo: message.reply_info,
  };
}

export function useMessages(
  server: Server,
  chatId: string,
  sharedSecret: string | null,
  identityKey: string
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const isFetchingRef = useRef(false);
  const wasOlderPaginationRef = useRef(false);
  const prevReadyStateRef = useRef<ReadyState | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(AppState.currentState === 'active');
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const sharedSecretRef = useRef(sharedSecret);
  sharedSecretRef.current = sharedSecret;

  const vault = useAtomValue(vaultAtom, { store: jotaiStore });
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  const { lastMessages, updateLastMessage } = useLastMessagesUpdater();
  const lastMessagesRef = useRef(lastMessages);
  lastMessagesRef.current = lastMessages;
  const queryClient = useQueryClient();

  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const { sendMessage: wsSend, readyState } = useWsConnection(server);

  // ── WS Handlers ─────────────────────────────────────────────────────────────

  useWsHandler<MessageAckPayload>(
    server,
    WS_MSG.MESSAGE_ACK,
    useCallback((payload) => {
      if (payload.chat_id !== chatIdRef.current) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.clientMessageId === payload.client_message_id
            ? {
              ...m,
              id: payload.id,
              sentAt: payload.created_at,
              pending: false,
              isOwn: true,
              uploadProgress: undefined,
              attachmentId: payload.attachment_id ?? m.attachmentId,
              attachmentMetadata: payload.attachment_metadata ?? m.attachmentMetadata,
              attachmentMetadataIv: payload.attachment_metadata_iv ?? m.attachmentMetadataIv,
              attachmentMetadataAuthTag:
                payload.attachment_metadata_auth_tag ?? m.attachmentMetadataAuthTag,
            }
            : m
        )
      );
    }, [])
  );

  useWsHandler<MessageReceivePayload>(
    server,
    WS_MSG.MESSAGE_RECEIVE,
    useCallback(
      (payload) => {
        if (payload.chat_id !== chatIdRef.current) return;

        setMessages((prev) => {
          const existingIdx = prev.findIndex(
            (m) =>
              m.id === payload.id || m.clientMessageId === payload.client_message_id
          );

          if (existingIdx !== -1) {
            return prev.map((m, idx) =>
              idx === existingIdx
                ? {
                  ...m,
                  id: payload.id,
                  clientMessageId: payload.client_message_id,
                  sentAt: payload.created_at,
                  pending: false,
                  senderId: payload.sender_id,
                  isOwn: payload.sender_id === server.id,
                  attachmentId: payload.attachment_id,
                  attachmentMetadata: payload.attachment_metadata,
                  attachmentMetadataIv: payload.attachment_metadata_iv,
                  attachmentMetadataAuthTag: payload.attachment_metadata_auth_tag,
                  modified: payload.modified ?? m.modified,
                  pinned: payload.pinned ?? m.pinned,
                  isReply: payload.is_reply,
                  replyInfo: payload.reply_info,
                }
                : m
            );
          }

          return [
            ...prev,
            {
              id: payload.id,
              clientMessageId: payload.client_message_id,
              chatId: chatIdRef.current,
              cipherText: payload.cipher_text,
              iv: payload.iv,
              authTag: payload.auth_tag,
              sentAt: payload.created_at,
              senderId: payload.sender_id,
              isOwn: payload.sender_id === server.id,
              pending: false,
              attachmentId: payload.attachment_id,
              attachmentMetadata: payload.attachment_metadata,
              attachmentMetadataIv: payload.attachment_metadata_iv,
              attachmentMetadataAuthTag: payload.attachment_metadata_auth_tag,
              modified: payload.modified ?? false,
              pinned: payload.pinned ?? false,
              isReply: payload.is_reply,
              replyInfo: payload.reply_info,
            },
          ];
        });

        if (isActiveRef.current) {
          wsSend(WS_MSG.MARK_READ, { chat_id: chatIdRef.current, timestamp: Date.now() });
        }

        if (sharedSecretRef.current) {
          try {
            const plaintext = decrypt(sharedSecretRef.current, {
              ciphertext: payload.cipher_text,
              iv: payload.iv,
              authTag: payload.auth_tag,
            });
            updateLastMessage({
              chatId: chatIdRef.current,
              senderId: payload.sender_id,
              content: payload.attachment_id ? '📎 Attachment' : plaintext,
              unreadMessages: isActiveRef.current
                ? 0
                : (lastMessagesRef.current?.[chatIdRef.current]?.unreadMessages ?? 0) + 1,
              lastActivityAt: payload.created_at,
            });
          } catch { }
        }
      },
      [wsSend, updateLastMessage]
    )
  );

  useWsHandler<MessageDeleteReceivePayload>(
    server,
    WS_MSG.MESSAGE_DELETE_RECEIVE,
    useCallback((payload) => {
      setMessages((prev) => prev.filter((m) => m.id !== payload.id));
    }, [])
  );

  useWsHandler<MessageModifyReceivePayload>(
    server,
    WS_MSG.MESSAGE_MODIFY_RECEIVE,
    useCallback((payload) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.id
            ? {
              ...m,
              cipherText: payload.cipher_text,
              iv: payload.iv,
              authTag: payload.auth_tag,
              plaintext: undefined,
              modified: true,
            }
            : m
        )
      );
    }, [])
  );

  useWsHandler<MessagePinReceivePayload>(
    server,
    WS_MSG.MESSAGE_PIN_RECEIVE,
    useCallback((payload) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === payload.id ? { ...m, pinned: payload.pinned } : m))
      );
    }, [])
  );

  useWsHandler<MessageReadInfoPayload>(
    server,
    WS_MSG.MESSAGE_READ_INFO,
    useCallback(
      (payload) => {
        if (payload.chat_id !== chatIdRef.current) return;
        const now = Date.now();
        setMessages((prev) => {
          const needsUpdate = prev.some((m) => m.isOwn && !m.readAt);
          if (!needsUpdate) return prev;
          return prev.map((m) => (m.isOwn && !m.readAt ? { ...m, readAt: now } : m));
        });
        updateLastMessage({
          chatId: chatIdRef.current,
          senderId: lastMessagesRef.current?.[chatIdRef.current]?.senderId ?? '',
          content: lastMessagesRef.current?.[chatIdRef.current]?.content ?? '',
          unreadMessages: 0,
          lastActivityAt:
            lastMessagesRef.current?.[chatIdRef.current]?.lastActivityAt ?? Date.now(),
        });
        void queryClient.invalidateQueries({ queryKey: ['chat-list', server.id] });
      },
      [queryClient, server.id, updateLastMessage]
    )
  );

  // ── AppState presence: foreground = online, background/closed = offline ──────

  useEffect(() => {
    const onAppStateChange = (next: AppStateStatus) => {
      if (next === 'active') {
        isActiveRef.current = true;
        const msgs = lastMessagesRef.current;
        const cId = chatIdRef.current;
        const lastMsg = msgs?.[cId];
        if (lastMsg?.unreadMessages > 0) {
          updateLastMessage({ ...lastMsg, unreadMessages: 0 });
        }
        wsSend(WS_MSG.MARK_READ, { chat_id: cId, timestamp: Date.now() });
        void queryClient.invalidateQueries({ queryKey: ['chat-list', server.id] });
      } else {
        isActiveRef.current = false;
      }
    };

    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      sub.remove();
    };
  }, [wsSend, updateLastMessage]);

  // ── Chat-open effect ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isActiveRef.current) return;
    const lastMsg = lastMessages?.[chatId];
    if (lastMsg) {
      updateLastMessage({ ...lastMsg, unreadMessages: 0 });
    }
    wsSend(WS_MSG.MARK_READ, { chat_id: chatId, timestamp: Date.now() });
    void queryClient.invalidateQueries({ queryKey: ['chat-list', server.id] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, queryClient, server.id]);

  // ── History fetch ───────────────────────────────────────────────────────────

  const fetchMessages = useCallback(
    async (cursor: string = MAX_CURSOR) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      setLoading(true);
      try {
        const res = await authorizedFetch(
          `/api/chat/messages?chat_id=${encodeURIComponent(chatId)}&limit=${MESSAGES_LIMIT}&cursor=${cursor}`
        );
        const json: { messages: RawMessageDTO[] } = await res.json();
        const fetched: Message[] = (json.messages ?? []).reverse().map((m) =>
          mapRawMessage(chatId, server.id, m)
        );

        if (cursor === MAX_CURSOR) {
          setMessages((prev) => {
            const pending = prev.filter((m) => m.pending);
            const uniquePending = pending.filter(
              (pendingMessage) => !fetched.some((fetchedMessage) => isSameMessage(fetchedMessage, pendingMessage))
            );
            return mergeMessages(fetched, uniquePending);
          });
        } else {
          wasOlderPaginationRef.current = true;
          setMessages((prev) => {
            const olderUnique = fetched.filter(
              (fetchedMessage) => !prev.some((existingMessage) => isSameMessage(existingMessage, fetchedMessage))
            );
            return [...olderUnique, ...prev];
          });
        }

        setHasMore(fetched.length === MESSAGES_LIMIT);
      } catch (err) {
        console.error('[useMessages] failed to fetch:', err);
      } finally {
        setLoading(false);
        isFetchingRef.current = false;
      }
    },
    [authorizedFetch, chatId, server.id]
  );

  useEffect(() => {
    const chatChanged = prevChatIdRef.current !== null && prevChatIdRef.current !== chatId;
    const justConnected =
      readyState === ReadyState.OPEN && prevReadyStateRef.current !== ReadyState.OPEN;

    if (chatChanged) {
      setMessages([]);
      setHasMore(true);
      isFetchingRef.current = false;
    }

    if (readyState === ReadyState.OPEN && (chatChanged || justConnected)) {
      fetchMessages(MAX_CURSOR);
    }

    prevReadyStateRef.current = readyState;
    prevChatIdRef.current = chatId;
  }, [readyState, chatId, fetchMessages]);

  // ── Message operations ───────────────────────────────────────────────────────

  const sendChatMessage = useCallback(
    async (cipherText: string, iv: string, authTag: string, plaintext: string) => {
      const clientMessageId = generateUuid();
      const optimistic: Message = {
        id: null,
        clientMessageId,
        chatId,
        cipherText,
        iv,
        authTag,
        sentAt: Date.now(),
        senderId: server.id,
        isOwn: true,
        pending: true,
        plaintext,
        modified: false,
        pinned: false,
        isReply: false,
      };
      setMessages((prev) => [...prev, optimistic]);

      const preview = plaintext.length <= 100 ? plaintext : plaintext.slice(0, 100) + '...';
      const encPreview = sharedSecretRef.current
        ? encrypt(sharedSecretRef.current, preview)
        : { ciphertext: '', iv: '', authTag: '' };

      wsSend(WS_MSG.MESSAGE, {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        client_message_id: clientMessageId,
        short_cipher_text: encPreview.ciphertext,
        short_iv: encPreview.iv,
        short_auth_tag: encPreview.authTag,
        reply_to: 0,
      });

      updateLastMessage({
        chatId,
        senderId: server.id,
        content: plaintext,
        unreadMessages: 0,
        lastActivityAt: optimistic.sentAt,
      });
    },
    [chatId, server.id, wsSend, updateLastMessage]
  );

  const sendReplyChatMessage = useCallback(
    async (cipherText: string, iv: string, authTag: string, plaintext: string, replyTo: number) => {
      const replyMessage = messagesRef.current.find((m) => m.id === replyTo);
      if (!replyMessage) return;

      const clientMessageId = generateUuid();
      const optimistic: Message = {
        id: null,
        clientMessageId,
        chatId,
        cipherText,
        iv,
        authTag,
        sentAt: Date.now(),
        senderId: server.id,
        isOwn: true,
        pending: true,
        plaintext,
        modified: false,
        pinned: false,
        isReply: true,
        replyInfo: {
          id: replyTo,
          cipher_text: replyMessage.cipherText,
          iv: replyMessage.iv,
          auth_tag: replyMessage.authTag,
          has_attachment: !!replyMessage.attachmentId,
        },
      };
      setMessages((prev) => [...prev, optimistic]);

      const preview = plaintext.length <= 100 ? plaintext : plaintext.slice(0, 100) + '...';
      const encPreview = sharedSecretRef.current
        ? encrypt(sharedSecretRef.current, preview)
        : { ciphertext: '', iv: '', authTag: '' };

      wsSend(WS_MSG.MESSAGE, {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        client_message_id: clientMessageId,
        short_cipher_text: encPreview.ciphertext,
        short_iv: encPreview.iv,
        short_auth_tag: encPreview.authTag,
        reply_to: replyTo,
      });

      updateLastMessage({
        chatId,
        senderId: server.id,
        content: plaintext,
        unreadMessages: 0,
        lastActivityAt: optimistic.sentAt,
      });
    },
    [chatId, server.id, wsSend, updateLastMessage]
  );

  const editChatMessage = useCallback(
    (messageId: number, cipherText: string, iv: string, authTag: string, plaintext: string) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, cipherText, iv, authTag, plaintext, modified: true } : m
        )
      );
      wsSend(WS_MSG.MESSAGE_MODIFY, {
        id: messageId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
      });
    },
    [wsSend]
  );

  const deleteChatMessage = useCallback(
    (messageId: number) => {
      wsSend(WS_MSG.MESSAGE_DELETE, { id: messageId });
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    },
    [wsSend]
  );

  const togglePinMessage = useCallback(
    (messageId: number) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, pinned: !m.pinned } : m))
      );
      wsSend(WS_MSG.MESSAGE_PIN, { id: messageId });
    },
    [wsSend]
  );

  const fetchMore = useCallback(() => {
    const oldest = messagesRef.current.find((m) => m.id !== null);
    if (oldest?.id != null && !isFetchingRef.current && hasMoreRef.current) {
      fetchMessages(String(oldest.id));
    }
  }, [fetchMessages]);

  const uploadAndSend = useCallback(
    async (
      fileUri: string,
      fileName: string,
      fileSize: number,
      mimeType: string,
      plaintext: string
    ) => {
      if (!vaultRef.current) throw new Error('Vault not unlocked');
      const encPrivateKey = vaultRef.current['encPrivateKey'] as string;
      if (!encPrivateKey) throw new Error('Encryption key not in vault');

      const clientMessageId = generateUuid();
      setMessages((prev) => [
        ...prev,
        {
          id: null,
          clientMessageId,
          chatId,
          cipherText: '',
          iv: '',
          authTag: '',
          sentAt: Date.now(),
          senderId: server.id,
          isOwn: true,
          pending: true,
          plaintext,
          uploadProgress: 0,
          attachmentFilename: fileName,
          modified: false,
          pinned: false,
          isReply: false,
        },
      ]);

      try {
        // Read file as base64 and convert to Uint8Array
        const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy');
        const b64 = await readAsStringAsync(fileUri, { encoding: EncodingType.Base64 });
        const binary = atob(b64);
        const fileBytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) fileBytes[i] = binary.charCodeAt(i);

        const encryptedBytes = encryptFile(fileBytes, identityKey, encPrivateKey);

        const metadataJson = JSON.stringify({ name: fileName, size: fileSize, mimeType });
        const secret = sharedSecretRef.current;
        if (!secret) throw new Error('No shared secret');
        const encMeta = encrypt(secret, metadataJson);
        const textToEncrypt = plaintext.trim() || '​';
        const encText = encrypt(secret, textToEncrypt);

        // Write encrypted bytes to temp file so we can pass it to FormData
        const tempUri = `${(await import('expo-file-system/legacy')).cacheDirectory}upload_${clientMessageId}`;
        let b64Out = '';
        for (let i = 0; i < encryptedBytes.length; i++) {
          b64Out += String.fromCharCode(encryptedBytes[i]);
        }
        await (
          await import('expo-file-system/legacy')
        ).writeAsStringAsync(tempUri, btoa(b64Out), {
          encoding: (await import('expo-file-system/legacy')).EncodingType.Base64,
        });

        const formData = new FormData();
        formData.append('size', String(encryptedBytes.length));
        formData.append('metadata', encMeta.ciphertext);
        formData.append('metadata_iv', encMeta.iv);
        formData.append('metadata_auth_tag', encMeta.authTag);
        formData.append('file', { uri: tempUri, name: fileName, type: mimeType } as any);

        const token = jotaiStore.get(serverTokensAtom).get(server.id) ?? '';
        const attachmentId = await xhrUpload(
          `https://${server.address}/api/attachment/upload`,
          token,
          formData,
          (pct) =>
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMessageId === clientMessageId ? { ...m, uploadProgress: pct } : m
              )
            )
        );

        setMessages((prev) =>
          prev.map((m) =>
            m.clientMessageId === clientMessageId
              ? {
                ...m,
                uploadProgress: undefined,
                cipherText: encText.ciphertext,
                iv: encText.iv,
                authTag: encText.authTag,
                plaintext: plaintext.trim() || undefined,
                attachmentId,
                attachmentFilename: undefined,
                attachmentMetadata: encMeta.ciphertext,
                attachmentMetadataIv: encMeta.iv,
                attachmentMetadataAuthTag: encMeta.authTag,
                modified: false,
                pinned: false,
              }
              : m
          )
        );

        wsSend(WS_MSG.MESSAGE, {
          chat_id: chatId,
          cipher_text: encText.ciphertext,
          iv: encText.iv,
          auth_tag: encText.authTag,
          client_message_id: clientMessageId,
          attachment_id: attachmentId,
        });

        updateLastMessage({
          chatId,
          senderId: server.id,
          content: plaintext.trim() || `📎 ${fileName}`,
          unreadMessages: 0,
          lastActivityAt: Date.now(),
        });

        // Cleanup temp file
        (await import('expo-file-system/legacy'))
          .deleteAsync(tempUri, { idempotent: true })
          .catch(() => { });
      } catch (err) {
        console.error('[useMessages] uploadAndSend failed:', err);
        setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
      }
    },
    [chatId, server, identityKey, wsSend, updateLastMessage]
  );

  return {
    messages,
    loading,
    hasMore,
    sendMessage: sendChatMessage,
    sendReplyMessage: sendReplyChatMessage,
    editMessage: editChatMessage,
    deleteMessage: deleteChatMessage,
    togglePinMessage,
    uploadAndSend,
    fetchMore,
    readyState,
  };
}
