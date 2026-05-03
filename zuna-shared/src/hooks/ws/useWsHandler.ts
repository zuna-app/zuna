import { useEffect, useRef } from "react";
import type { Server } from "../../types/serverTypes";
import { registerHandler } from "./wsRegistry";

/**
 * Registers a typed handler for a specific WebSocket message type.
 * The handler ref is kept fresh on every render so it always closes
 * over latest state without needing to be re-registered.
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
