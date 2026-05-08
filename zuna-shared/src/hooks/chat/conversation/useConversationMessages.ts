import { useEffect, useRef, useState } from "react";
import { useWsConnection } from "../../ws/useWsConnection";
import { useAuthorizedServerFetch } from "../../server/useServerFetch";
import { Server } from "../../../types/serverTypes";
import { useLastMessagesUpdater } from "../useLastChatMessages";
import { usePlatform } from "../../../platform";
import { useMessageHistory } from "./useMessageHistory";
import { useConversationWsHandlers } from "./useConversationWsHandlers";
import { usePresenceTracking } from "./usePresenceTracking";
import { useMessageActions } from "./useMessageActions";

export function useConversationMessages(
  server: Server,
  chatId: string,
  sharedSecret: string | null,
  identityKey: string,
) {
  const { vault } = usePlatform();
  const { lastMessages, updateLastMessage } = useLastMessagesUpdater();
  const { authorizedFetch, hasToken } = useAuthorizedServerFetch(server);
  const { sendMessage: wsSend, readyState } = useWsConnection(server);

  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  const sharedSecretRef = useRef(sharedSecret);
  sharedSecretRef.current = sharedSecret;

  const lastMessagesRef = useRef(lastMessages);
  lastMessagesRef.current = lastMessages;

  const [isFocused, setIsFocused] = useState(
    () => typeof document !== "undefined" && document.hasFocus(),
  );

  useEffect(() => {
    const onFocus = () => {
      setIsFocused(true);
    };

    const onBlur = () => {
      setIsFocused(false);
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const { messages, loading, hasMore, setMessages, messagesRef, fetchMore } =
    useMessageHistory(server, chatId, authorizedFetch, readyState, hasToken);

  useConversationWsHandlers({
    server,
    chatIdRef,
    sharedSecretRef,
    isFocused,
    lastMessagesRef,
    setMessages,
    wsSend,
    updateLastMessage,
  });

  usePresenceTracking({
    chatId,
    lastMessages,
    isFocused,
    wsSend,
    updateLastMessage,
  });

  const {
    sendMessage,
    sendReplyMessage,
    editMessage,
    togglePinMessage,
    uploadAndSend,
  } = useMessageActions({
    server,
    chatId,
    sharedSecretRef,
    messagesRef,
    setMessages,
    wsSend,
    updateLastMessage,
    identityKey,
    vault,
  });

  return {
    messages,
    loading,
    hasMore,
    sendMessage,
    sendReplyMessage,
    editMessage,
    togglePinMessage,
    uploadAndSend,
    fetchMore,
    readyState,
  };
}
