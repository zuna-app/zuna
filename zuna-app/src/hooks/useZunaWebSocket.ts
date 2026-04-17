import { useAtomValue } from "jotai";
import { useCallback, useRef } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import {
  jotaiStore,
  reauthorize,
  serverTokensAtom,
} from "@/hooks/useAuthorizer";
import { Server } from "@/types/serverTypes";

export type ZunaResponse = {
  type: string;
  payload: any;
};

export const useZunaWebSocket = (
  server: Server,
  onMessage: (message: ZunaResponse) => void,
) => {
  const serverTokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const token = serverTokens.get(server.id) ?? null;

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const serverRef = useRef(server);
  serverRef.current = server;

  const isReauthorizingRef = useRef(false);

  const onOpenStable = useCallback(() => {
    rawSendRef.current(
      JSON.stringify({
        type: "auth",
        token: tokenRef.current ?? "",
        payload: {},
      }),
    );
  }, []);

  const onMessageStable = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "error" && data.payload?.code === "forbidden") {
        if (isReauthorizingRef.current) return;
        isReauthorizingRef.current = true;
        reauthorize(serverRef.current)
          .then(() => {
            const freshToken =
              jotaiStore.get(serverTokensAtom).get(serverRef.current.id) ?? "";
            rawSendRef.current(
              JSON.stringify({
                type: "auth",
                token: freshToken,
                payload: {},
              }),
            );
          })
          .catch((err) => console.error("[ws] reauthorize failed:", err))
          .finally(() => {
            isReauthorizingRef.current = false;
          });
        return;
      }
      onMessageRef.current(data);
    } catch (err) {
      console.error("Failed to parse WebSocket message:", err);
    }
  }, []);

  const rawSendRef = useRef<(data: string) => void>(() => {});

  const {
    sendMessage: rawSend,
    lastMessage,
    readyState,
  } = useWebSocket(token ? `ws://${server.address}/ws` : null, {
    shouldReconnect: () => true,
    share: true,
    reconnectAttempts: 10,
    reconnectInterval: 3000,
    onOpen: onOpenStable,
    onMessage: onMessageStable,
  });

  rawSendRef.current = rawSend;

  const sendMessage = useCallback(
    (type: string, payload: any = {}) => {
      rawSend(
        JSON.stringify({
          type,
          token: tokenRef.current ?? "",
          payload,
        }),
      );
    },
    [rawSend],
  );

  return {
    sendMessage,
    lastMessage,
    readyState,
  };
};
