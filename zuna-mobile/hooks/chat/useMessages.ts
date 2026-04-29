import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
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

export function useMessages(
  server: Server,
  chatId: string,
  sharedSecret: string | null,
  identityKey: string
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const localIdCounter = useRef(0);
  const isFetchingRef = useRef(false);
  const wasOlderPaginationRef = useRef(false);
  const prevReadyStateRef = useRef<ReadyState | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(AppState.currentState === 'active');
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInactiveRef = useRef(false);
  const lastPresenceRef = useRef<boolean | null>(null);
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
          m.localId === payload.local_id
            ? {
                ...m,
                id: payload.id,
                sentAt: payload.created_at,
                pending: false,
                localId: null,
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
          if (prev.some((m) => m.id === payload.id)) return prev;
          return [
            ...prev,
            {
              id: payload.id,
              localId: null,
              chatId: chatIdRef.current,
              cipherText: payload.cipher_text,
              iv: payload.iv,
              authTag: payload.auth_tag,
              sentAt: payload.created_at,
              senderId: payload.sender_id,
              isOwn: false,
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
          } catch {}
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
      },
      [updateLastMessage]
    )
  );

  // ── AppState presence (replaces window focus/blur) ──────────────────────────

  useEffect(() => {
    const INACTIVITY_MS = 60_000;

    const sendPresence = (active: boolean) => {
      if (lastPresenceRef.current === active) return;
      lastPresenceRef.current = active;
      wsSend(WS_MSG.PRESENCE, { active });
    };

    const clearTimer = () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };

    const startTimer = () => {
      clearTimer();
      inactivityTimerRef.current = setTimeout(() => {
        isInactiveRef.current = true;
        sendPresence(false);
      }, INACTIVITY_MS);
    };

    const onAppStateChange = (next: AppStateStatus) => {
      if (next === 'active') {
        isActiveRef.current = true;
        isInactiveRef.current = false;
        sendPresence(true);
        startTimer();
        const msgs = lastMessagesRef.current;
        const cId = chatIdRef.current;
        const lastMsg = msgs?.[cId];
        if (lastMsg?.unreadMessages > 0) {
          updateLastMessage({ ...lastMsg, unreadMessages: 0 });
        }
        wsSend(WS_MSG.MARK_READ, { chat_id: cId, timestamp: Date.now() });
      } else {
        isActiveRef.current = false;
        clearTimer();
        sendPresence(false);
      }
    };

    if (isActiveRef.current) {
      sendPresence(true);
      startTimer();
    }

    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      sub.remove();
      clearTimer();
    };
  }, [wsSend, updateLastMessage]);

  // ── Chat-open effect ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isActiveRef.current) return;
    const lastMsg = lastMessages?.[chatId];
    wsSend(WS_MSG.PRESENCE, { active: true });
    if (lastMsg) {
      updateLastMessage({ ...lastMsg, unreadMessages: 0 });
    }
    wsSend(WS_MSG.MARK_READ, { chat_id: chatId, timestamp: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

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
        const fetched: Message[] = (json.messages ?? []).reverse().map((m) => ({
          id: m.id,
          localId: null,
          chatId,
          cipherText: m.cipher_text,
          iv: m.iv,
          authTag: m.auth_tag,
          sentAt: m.sent_at,
          readAt: m.read_at > 0 ? m.read_at : undefined,
          senderId: m.sender_id,
          isOwn: m.sender_id === server.id,
          pending: false,
          attachmentId: m.attachment_id,
          attachmentMetadata: m.attachment_metadata,
          attachmentMetadataIv: m.attachment_metadata_iv,
          attachmentMetadataAuthTag: m.attachment_metadata_auth_tag,
          modified: m.modified,
          pinned: m.pinned ?? m.pin ?? false,
          isReply: m.is_reply,
          replyInfo: m.reply_info,
        }));

        if (cursor === MAX_CURSOR) {
          setMessages((prev) => {
            const pending = prev.filter((m) => m.pending);
            const fetchedIds = new Set(fetched.map((m) => m.id));
            const uniquePending = pending.filter((m) => m.id === null || !fetchedIds.has(m.id));
            return [...fetched, ...uniquePending];
          });
        } else {
          wasOlderPaginationRef.current = true;
          setMessages((prev) => [...fetched, ...prev]);
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
      const localId = ++localIdCounter.current;
      const optimistic: Message = {
        id: null,
        localId,
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
        local_id: localId,
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

      const localId = ++localIdCounter.current;
      const optimistic: Message = {
        id: null,
        localId,
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
        local_id: localId,
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

      const localId = ++localIdCounter.current;
      setMessages((prev) => [
        ...prev,
        {
          id: null,
          localId,
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
        const tempUri = `${(await import('expo-file-system/legacy')).cacheDirectory}upload_${localId}`;
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
              prev.map((m) => (m.localId === localId ? { ...m, uploadProgress: pct } : m))
            )
        );

        setMessages((prev) =>
          prev.map((m) =>
            m.localId === localId
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
          local_id: localId,
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
          .catch(() => {});
      } catch (err) {
        console.error('[useMessages] uploadAndSend failed:', err);
        setMessages((prev) => prev.filter((m) => m.localId !== localId));
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
