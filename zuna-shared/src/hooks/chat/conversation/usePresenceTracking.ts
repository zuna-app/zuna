import { MutableRefObject, useEffect } from "react";
import { WS_MSG } from "../../ws/wsTypes";
import { LastMessage } from "../../../types/serverTypes";

type WsSend = (type: string, payload?: unknown) => void;
type UpdateLastMessage = (msg: LastMessage) => void;

interface PresenceTrackingParams {
  chatId: string;
  lastMessages: Record<string, LastMessage> | null;
  isFocusedRef: MutableRefObject<boolean>;
  wsSend: WsSend;
  updateLastMessage: UpdateLastMessage;
}

export function usePresenceTracking({
  chatId,
  lastMessages,
  isFocusedRef,
  wsSend,
  updateLastMessage,
}: PresenceTrackingParams) {
  // ── Chat-open effect ─────────────────────────────────────────────────────
  // Marks the conversation read and clears the unread badge when chat changes.
  // App-level focus/blur/inactivity presence is handled by useAppPresence.

  useEffect(() => {
    if (!isFocusedRef.current) return;
    if (lastMessages) {
      const lastMsg = lastMessages[chatId];
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
}
