import { useEffect, useRef } from "react";
import { Server } from "@/types/serverTypes";
import { registerHandler } from "./wsRegistry";

/**
 * Registers a typed handler for a specific WebSocket message type.
 * The handler is kept fresh on every render via an internal ref, so it
 * always closes over the latest component state without needing to be
 * re-registered.
 */
export function useWsHandler<P = unknown>(
  server: Server,
  type: string,
  handler: (payload: P) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const stable = (payload: P) => handlerRef.current(payload);
    return registerHandler<P>(server.id, type, stable);
  }, [server.id, type]);
}
