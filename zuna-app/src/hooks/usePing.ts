import { useCallback, useEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";
import { useZunaWebSocket, ZunaResponse } from "@/hooks/useZunaWebSocket";
import { Server } from "@/types/serverTypes";

const PING_INTERVAL_MS = 5000;
const PONG_TIMEOUT_MS = 8000;

export function usePing(server: Server) {
  const [latency, setLatency] = useState<number | null>(null);
  const pendingTs = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPongTimeout = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const handleMessage = useCallback((message: ZunaResponse) => {
    if (message.type !== "pong") return;
    const ts: number = message.payload?.ts;
    if (typeof ts !== "number" || pendingTs.current !== ts) return;
    clearPongTimeout();
    setLatency(Date.now() - ts);
    pendingTs.current = null;
  }, []);

  const { sendMessage, readyState } = useZunaWebSocket(server, handleMessage);

  const sendPing = useCallback(() => {
    const ts = Date.now();
    pendingTs.current = ts;
    sendMessage("ping", { ts });

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
