import { useCallback, useEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";
import { useZunaWebSocket, ZunaResponse } from "@/hooks/useZunaWebSocket";
import { useAuthorizedServerFetch } from "@/hooks/useServerFetch";
import { Server } from "@/types/serverTypes";

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

type MessageAckPayload = {
  local_id: number;
  id: number;
  chat_id: string;
  created_at: number;
};

type MessageReceivePayload = {
  id: number;
  chat_id: string;
  created_at: number;
  sender_id: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
};

export function useMessages(server: Server, chatId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const localIdCounter = useRef(0);
  const isFetchingRef = useRef(false);
  const prevReadyStateRef = useRef<ReadyState | null>(null);
  const prevChatIdRef = useRef<string | null>(null);

  const { authorizedFetch } = useAuthorizedServerFetch(server);

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

  const onMessage = useCallback(
    (msg: ZunaResponse) => {
      if (msg.type === "message_ack" && msg.payload?.chat_id === chatId) {
        const ack = msg.payload as MessageAckPayload;
        setMessages((prev) =>
          prev.map((m) =>
            m.localId === ack.local_id
              ? {
                  ...m,
                  id: ack.id,
                  sentAt: ack.created_at,
                  pending: false,
                  isOwn: true,
                  localId: null,
                }
              : m,
          ),
        );
      } else if (
        msg.type === "message_receive" &&
        msg.payload?.chat_id === chatId
      ) {
        const recv = msg.payload as MessageReceivePayload;
        setMessages((prev) => {
          if (prev.some((m) => m.id === recv.id)) return prev;
          return [
            ...prev,
            {
              id: recv.id,
              localId: null,
              chatId,
              cipherText: recv.cipher_text,
              iv: recv.iv,
              authTag: recv.auth_tag,
              sentAt: recv.created_at,
              senderId: recv.sender_id,
              isOwn: false,
              pending: false,
            },
          ];
        });
      }
    },
    [chatId],
  );

  const { sendMessage: wsSend, readyState } = useZunaWebSocket(
    server,
    onMessage,
  );

  useEffect(() => {
    window.addEventListener("focus", () => {
      wsSend("presence", { active: true });
    });

    window.addEventListener("blur", () => {
      wsSend("presence", { active: false });
    });
  }, []);

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
      wsSend("message", {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        local_id: localId,
      });
    },
    [chatId, wsSend],
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
