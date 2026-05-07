import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ReadyState } from "react-use-websocket";
import { Message, RawMessageDTO, Server } from "../../../types/serverTypes";

const MESSAGES_LIMIT = 50;
const MAX_CURSOR = "9223372036854775807";

export function useMessageHistory(
  server: Server,
  chatId: string,
  authorizedFetch: (path: string) => Promise<Response>,
  readyState: ReadyState,
  hasToken = true,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const isFetchingRef = useRef(false);
  const wasOlderPaginationRef = useRef(false);
  const prevReadyStateRef = useRef<ReadyState | null>(null);
  const prevChatIdRef = useRef<string | null>(null);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;

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
          clientMessageId: m.client_message_id,
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
          pinned: m.pinned ?? (m as any).pin ?? false,
          isReply: m.is_reply,
          replyInfo: m.reply_info,
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
          wasOlderPaginationRef.current = true;
          setMessages((prev) => [...fetched, ...prev]);
        }

        setHasMore(fetched.length === MESSAGES_LIMIT);
      } catch (err) {
        console.error(
          "[useConversationMessages] Failed to fetch messages:",
          err,
        );
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

    if (
      readyState === ReadyState.OPEN &&
      (chatChanged || justConnected) &&
      hasToken
    ) {
      fetchMessages(MAX_CURSOR);
    }

    prevReadyStateRef.current = readyState;
    prevChatIdRef.current = chatId;
  }, [readyState, chatId, fetchMessages, hasToken]);

  useEffect(() => {
    if (wasOlderPaginationRef.current) {
      wasOlderPaginationRef.current = false;
      return;
    }
    if (messages.length > MESSAGES_LIMIT) {
      setHasMore(true);
      setMessages((prev) =>
        prev.length > MESSAGES_LIMIT
          ? prev.slice(prev.length - MESSAGES_LIMIT)
          : prev,
      );
    }
  }, [messages.length]);

  const fetchMore = useCallback(() => {
    const oldest = messagesRef.current.find((m) => m.id !== null);
    if (oldest?.id != null && !isFetchingRef.current && hasMoreRef.current) {
      fetchMessages(String(oldest.id));
    }
  }, [fetchMessages]);

  return {
    messages,
    loading,
    hasMore,
    setMessages,
    messagesRef,
    isFetchingRef,
    fetchMore,
  };
}
