import { MutableRefObject, useEffect } from "react";
import { WS_MSG } from "../../ws/wsTypes";
import { LastMessage } from "../../../types/serverTypes";

type WsSend = (type: string, payload?: unknown) => void;
type UpdateLastMessage = (msg: LastMessage) => void;

interface PresenceTrackingParams {
  chatId: string;
  lastMessages: Record<string, LastMessage> | null;
  isFocused: boolean;
  wsSend: WsSend;
  updateLastMessage: UpdateLastMessage;
}

export function usePresenceTracking({
  chatId,
  lastMessages,
  isFocused,
  wsSend,
  updateLastMessage,
}: PresenceTrackingParams) {
  // ── Chat-open effect ─────────────────────────────────────────────────────
  // Marks the conversation read and clears the unread badge when chat changes.
  // App-level focus/blur/inactivity presence is handled by useAppPresence.

  useEffect(() => {
    if (!isFocused) return;
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
  }, [chatId, isFocused]);
}
