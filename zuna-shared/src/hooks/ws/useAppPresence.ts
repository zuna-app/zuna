import { useEffect, useRef } from "react";
import { useWsConnection } from "./useWsConnection";
import type { Server } from "../../types/serverTypes";
import { WS_MSG } from "./wsTypes";

const INACTIVITY_MS = 1 * 60 * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown"] as const;

/**
 * App-level presence tracking.
 * Sends PRESENCE { active } based on window focus/blur/inactivity so the
 * server keeps delivering PRESENCE_UPDATE pushes regardless of whether a
 * 1-on-1 or a channel is currently open.
 */
export function useAppPresence(server: Server) {
  const { sendMessage: wsSend } = useWsConnection(server);

  const isFocusedRef = useRef(
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  const isInactiveRef = useRef(false);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPresenceRef = useRef<boolean | null>(null);

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

    // Send initial presence
    if (isFocusedRef.current) {
      sendPresence(true);
      startInactivityTimer();
    }

    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity));
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInactivityTimer();
    };
  }, [wsSend]);
}
