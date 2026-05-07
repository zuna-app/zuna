import { MutableRefObject, useEffect, useRef } from "react";
import { WS_MSG } from "../../ws/wsTypes";
import { LastMessage } from "../../../types/serverTypes";

const INACTIVITY_MS = 1 * 60 * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown"] as const;

type WsSend = (type: string, payload?: unknown) => void;
type UpdateLastMessage = (msg: LastMessage) => void;

interface PresenceTrackingParams {
  chatId: string;
  chatIdRef: MutableRefObject<string>;
  lastMessages: Record<string, LastMessage> | null;
  lastMessagesRef: MutableRefObject<Record<string, LastMessage> | null>;
  isFocusedRef: MutableRefObject<boolean>;
  wsSend: WsSend;
  updateLastMessage: UpdateLastMessage;
}

export function usePresenceTracking({
  chatId,
  chatIdRef,
  lastMessages,
  lastMessagesRef,
  isFocusedRef,
  wsSend,
  updateLastMessage,
}: PresenceTrackingParams) {
  const isInactiveRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPresenceRef = useRef<boolean | null>(null);

  // ── Chat-open effect ─────────────────────────────────────────────────────

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

  // ── Focus / blur / inactivity tracking ──────────────────────────────────

  useEffect(() => {
    const sendPresence = (active: boolean) => {
      if (lastPresenceRef.current === active) return;
      lastPresenceRef.current = active;
      wsSend(WS_MSG.PRESENCE, { active });
    };

    const clearInactivityTimer = () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };

    const startInactivityTimer = () => {
      clearInactivityTimer();
      inactivityTimerRef.current = setTimeout(() => {
        isInactiveRef.current = true;
        sendPresence(false);
      }, INACTIVITY_MS);
    };

    const onActivity = () => {
      if (!isFocusedRef.current) return;
      if (isInactiveRef.current) {
        isInactiveRef.current = false;
        sendPresence(true);
      }
      startInactivityTimer();
    };

    const onFocus = () => {
      isFocusedRef.current = true;
      isInactiveRef.current = false;
      sendPresence(true);
      startInactivityTimer();

      const cId = chatIdRef.current;
      const msgs = lastMessagesRef.current;
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
      isInactiveRef.current = false;
      clearInactivityTimer();
      sendPresence(false);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        isFocusedRef.current = false;
        isInactiveRef.current = false;
        clearInactivityTimer();
        sendPresence(false);
      } else if (
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        isFocusedRef.current = true;
        isInactiveRef.current = false;
        sendPresence(true);
        startInactivityTimer();
      }
    };

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity));
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    if (isFocusedRef.current) {
      startInactivityTimer();
    }

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInactivityTimer();
    };
  }, [wsSend]);
}
