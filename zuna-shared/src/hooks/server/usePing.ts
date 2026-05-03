import { useCallback, useEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";
import { useWsConnection } from "../ws/useWsConnection";
import { useWsHandler } from "../ws/useWsHandler";
import { WS_MSG } from "../ws/wsTypes";
import type { Server } from "../../types/serverTypes";

// PongPayload may arrive as { ts: number } or similar
interface PongPayload {
  ts: number;
}

const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 8000;

export function usePing(server: Server) {
  const [latency, setLatency] = useState<number | null>(null);
  const pendingTs = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { sendMessage, readyState } = useWsConnection(server);

  const clearPongTimeout = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useWsHandler<PongPayload>(server, WS_MSG.PONG, (payload) => {
    const { ts } = payload;
    if (typeof ts !== "number" || pendingTs.current !== ts) return;
    clearPongTimeout();
    setLatency(Date.now() - ts);
    pendingTs.current = null;
  });

  const sendPing = useCallback(() => {
    const ts = Date.now();
    pendingTs.current = ts;
    sendMessage(WS_MSG.PING, { ts });

    clearPongTimeout();
    timeoutRef.current = setTimeout(() => {
      if (pendingTs.current === ts) {
        setLatency(null);
        pendingTs.current = null;
      }
    }, PONG_TIMEOUT_MS);
  }, [sendMessage]);

  useEffect(() => {
    if (readyState !== ReadyState.OPEN) {
      clearPongTimeout();
      setLatency(null);
      pendingTs.current = null;
    }
  }, [readyState]);

  useEffect(() => {
    if (readyState !== ReadyState.OPEN) return;
    sendPing();
    const id = setInterval(sendPing, PING_INTERVAL_MS);
    return () => {
      clearInterval(id);
      clearPongTimeout();
    };
  }, [sendPing, readyState]);

  return { latency, readyState };
}
