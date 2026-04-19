import { useCallback, useEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";
import { useWsConnection } from "@/hooks/ws/useWsConnection";
import { useWsHandler } from "@/hooks/ws/useWsHandler";
import {
  WS_MSG,
  MessageAckPayload,
  MessageReceivePayload,
  MessageReadInfoPayload,
} from "@/hooks/ws/wsTypes";
import { useAuthorizedServerFetch } from "@/hooks/server/useServerFetch";
import { Server } from "@/types/serverTypes";
import { useLastMessagesUpdater } from "./useLastChatMessages";

const MESSAGES_LIMIT = 50;
const MAX_CURSOR = "9223372036854775807";

export type Message = {
  id: number | null;
  localId: number | null;
  chatId: string;
  cipherText: string;
  iv: string;
  authTag: string;
  sentAt: number;
  readAt?: number;
  senderId: string;
  isOwn: boolean;
  pending: boolean;
  plaintext?: string;
};

type RawMessageDTO = {
  id: number;
  sender_id: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  sent_at: number;
  read_at: number;
};

export function useMessages(
  server: Server,
  chatId: string,
  sharedSecret: string | null,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const localIdCounter = useRef(0);
  const isFetchingRef = useRef(false);
  const prevReadyStateRef = useRef<ReadyState | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const isFocusedRef = useRef(
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const { lastMessages, updateLastMessage } = useLastMessagesUpdater();
  const { authorizedFetch } = useAuthorizedServerFetch(server);

  const lastMessagesRef = useRef(lastMessages);
  lastMessagesRef.current = lastMessages;

  const sharedSecretRef = useRef(sharedSecret);
  sharedSecretRef.current = sharedSecret;

  const { sendMessage: wsSend, readyState } = useWsConnection(server);

  // ── Typed message handlers ─────────────────────────────────────────────────

  useWsHandler<MessageAckPayload>(server, WS_MSG.MESSAGE_ACK, (payload) => {
    if (payload.chat_id !== chatIdRef.current) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.localId === payload.local_id
          ? {
              ...m,
              id: payload.id,
              sentAt: payload.created_at,
              pending: false,
              isOwn: true,
              localId: null,
            }
          : m,
      ),
    );
  });

  useWsHandler<MessageReceivePayload>(
    server,
    WS_MSG.MESSAGE_RECEIVE,
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
          },
        ];
      });

      wsSend(WS_MSG.MARK_READ, {
        chat_id: chatIdRef.current,
        timestamp: Date.now(),
      });

      if (sharedSecretRef.current) {
        window.security
          .decrypt(sharedSecretRef.current, {
            ciphertext: payload.cipher_text,
            iv: payload.iv,
            authTag: payload.auth_tag,
          })
          .then((plaintext) => {
            updateLastMessage({
              chatId: chatIdRef.current,
              senderId: payload.sender_id,
              content: plaintext,
              unreadMessages: isFocusedRef.current
                ? 0
                : (lastMessagesRef.current?.[chatIdRef.current]
                    ?.unreadMessages ?? 0) + 1,
              lastActivityAt: payload.created_at,
            });
          })
          .catch((err) => {
            console.error(
              "[useMessages] Failed to decrypt incoming message:",
              err,
            );
          });
      }
    },
  );

  useWsHandler<MessageReadInfoPayload>(
    server,
    WS_MSG.MESSAGE_READ_INFO,
    (payload) => {
      if (payload.chat_id !== chatIdRef.current) return;
      setMessages((prev) => prev.map((m) => ({ ...m, readAt: Date.now() })));
      updateLastMessage({
        chatId: chatIdRef.current,
        senderId: lastMessagesRef.current?.[chatIdRef.current]?.senderId ?? "",
        content: lastMessagesRef.current?.[chatIdRef.current]?.content ?? "",
        unreadMessages: 0,
        lastActivityAt:
          lastMessagesRef.current?.[chatIdRef.current]?.lastActivityAt ??
          Date.now(),
      });
    },
  );

  // ── Chat-open effect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!isFocusedRef.current) return;
    if (lastMessages) {
      const lastMsg = lastMessages[chatId];
      wsSend(WS_MSG.PRESENCE, { active: true });
      if (lastMsg) {
        updateLastMessage({
          chatId,
          senderId: lastMsg.senderId,
          content: lastMsg.content,
          unreadMessages: 0,
          lastActivityAt: lastMsg.lastActivityAt,
        });
      }
      wsSend(WS_MSG.MARK_READ, { chat_id: chatId, timestamp: Date.now() });
    }
  }, [chatId]);

  // ── Window focus / blur ────────────────────────────────────────────────────

  useEffect(() => {
    const onFocus = () => {
      isFocusedRef.current = true;
      wsSend(WS_MSG.PRESENCE, { active: true });
      const msgs = lastMessagesRef.current;
      const cId = chatIdRef.current;
      if (msgs && cId) {
        const lastMsg = msgs[cId];
        if (lastMsg && lastMsg.unreadMessages > 0) {
          updateLastMessage({
            chatId: cId,
            senderId: lastMsg.senderId,
            content: lastMsg.content,
            unreadMessages: 0,
            lastActivityAt: lastMsg.lastActivityAt,
          });
        }
        wsSend(WS_MSG.MARK_READ, { chat_id: cId, timestamp: Date.now() });
      }
    };

    const onBlur = () => {
      isFocusedRef.current = false;
      wsSend(WS_MSG.PRESENCE, { active: false });
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [wsSend]);

  // ── History fetch ──────────────────────────────────────────────────────────

  const fetchMessages = useCallback(
    async (cursor: string = MAX_CURSOR) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      setLoading(true);
      try {
        const res = await authorizedFetch(
          `/api/chat/messages?chat_id=${encodeURIComponent(chatId)}&limit=${MESSAGES_LIMIT}&cursor=${cursor}`,
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
        }));

        if (cursor === MAX_CURSOR) {
          setMessages((prev) => {
            const pending = prev.filter((m) => m.pending);
            const fetchedIds = new Set(fetched.map((m) => m.id));
            const uniquePending = pending.filter(
              (m) => m.id === null || !fetchedIds.has(m.id),
            );
            return [...fetched, ...uniquePending];
          });
        } else {
          setMessages((prev) => [...fetched, ...prev]);
        }

        setHasMore(fetched.length === MESSAGES_LIMIT);
      } catch (err) {
        console.error("[useMessages] failed to fetch messages:", err);
      } finally {
        setLoading(false);
        isFetchingRef.current = false;
      }
    },
    [authorizedFetch, chatId],
  );

  useEffect(() => {
    const chatChanged =
      prevChatIdRef.current !== null && prevChatIdRef.current !== chatId;
    const justConnected =
      readyState === ReadyState.OPEN &&
      prevReadyStateRef.current !== ReadyState.OPEN;

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

  // ── Send ───────────────────────────────────────────────────────────────────

  const sendChatMessage = useCallback(
    (cipherText: string, iv: string, authTag: string, plaintext: string) => {
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
      };
      setMessages((prev) => [...prev, optimistic]);
      wsSend(WS_MSG.MESSAGE, {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        local_id: localId,
      });

      updateLastMessage({
        chatId,
        senderId: server.id,
        content: plaintext,
        unreadMessages: 0,
        lastActivityAt: optimistic.sentAt,
      });
    },
    [chatId, wsSend, updateLastMessage],
  );

  const fetchMore = useCallback(() => {
    const oldest = messages.find((m) => m.id !== null);
    if (oldest?.id != null && !loading && hasMore) {
      fetchMessages(String(oldest.id));
    }
  }, [messages, loading, hasMore, fetchMessages]);

  return {
    messages,
    loading,
    hasMore,
    sendMessage: sendChatMessage,
    fetchMore,
    readyState,
  };
}
