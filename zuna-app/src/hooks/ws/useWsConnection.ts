import { useCallback, useEffect, useRef } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { useAtomValue } from "jotai";
import {
  jotaiStore,
  reauthorize,
  serverTokensAtom,
} from "@/hooks/auth/useAuthorizer";
import { Server } from "@/types/serverTypes";
import { dispatch } from "./wsRegistry";
import { presenceAtom, writingAtom } from "./usePresence";
import {
  WS_MSG,
  PresenceUpdatePayload,
  PresenceResponsePayload,
  ErrorPayload,
  WriteReceivePayload,
} from "./wsTypes";

/**
 * Module-level WeakSet so that when multiple hook instances share the same
 * underlying socket (react-use-websocket share:true), each MessageEvent is
 * dispatched to the registry exactly once regardless of how many
 * useWsConnection instances are mounted.
 */
const processedMessages = new WeakSet<MessageEvent>();

export function useWsConnection(server: Server) {
  const serverTokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const token = serverTokens.get(server.id) ?? null;

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const serverRef = useRef(server);
  serverRef.current = server;

  const isReauthorizingRef = useRef(false);
  const rawSendRef = useRef<(data: string) => void>(() => {});

  const onOpenStable = useCallback(() => {
    rawSendRef.current(
      JSON.stringify({
        type: WS_MSG.AUTH,
        token: tokenRef.current ?? "",
        payload: {},
      }),
    );
  }, []);

  const {
    sendMessage: rawSend,
    lastMessage,
    readyState,
  } = useWebSocket(token ? `wss://${server.address}/ws` : null, {
    shouldReconnect: () => true,
    share: true,
    reconnectAttempts: 10,
    reconnectInterval: 3000,
    onOpen: onOpenStable,
  });

  rawSendRef.current = rawSend;

  useEffect(() => {
    if (!lastMessage || processedMessages.has(lastMessage)) return;
    processedMessages.add(lastMessage);

    let envelope: { type: string; payload: unknown };
    try {
      envelope = JSON.parse(lastMessage.data);
    } catch {
      return;
    }

    const { type, payload } = envelope;

    // System messages are handled inline so they always fire exactly once
    // (guaranteed by the WeakSet above) regardless of how many hook instances
    // are mounted for the same server.

    if (type === WS_MSG.AUTH_CONFIRMATION) {
      rawSendRef.current(
        JSON.stringify({
          type: WS_MSG.PRESENCE_REQUEST,
          token: tokenRef.current ?? "",
          payload: {},
        }),
      );
      return;
    }

    if (type === WS_MSG.PRESENCE_UPDATE) {
      const { user_id, active, last_seen } = (payload as PresenceUpdatePayload)
        .presence;
      jotaiStore.set(presenceAtom, (prev) => {
        const next = new Map(prev);
        next.set(user_id, { userId: user_id, active, lastSeen: last_seen });
        return next;
      });
      return;
    }

    if (type === WS_MSG.PRESENCE_RESPONSE) {
      const list = (payload as PresenceResponsePayload).presence;
      if (Array.isArray(list)) {
        jotaiStore.set(presenceAtom, (prev) => {
          const next = new Map(prev);
          for (const p of list) {
            next.set(p.user_id, {
              userId: p.user_id,
              active: p.active,
              lastSeen: p.last_seen,
            });
          }
          return next;
        });
      }
      return;
    }

    if (type === WS_MSG.WRITE_RECEIVE) {
      const { chat_id, sender_id, writing } = payload as WriteReceivePayload;
      const presence = jotaiStore.get(presenceAtom);
      if (!presence.get(sender_id)?.active) return;
      jotaiStore.set(writingAtom, (prev) => {
        const next = new Map(prev);
        next.set(sender_id, { chatId: chat_id, writing });
        return next;
      });
      return;
    }

    if (
      type === WS_MSG.ERROR &&
      (payload as ErrorPayload)?.code === "forbidden"
    ) {
      if (isReauthorizingRef.current) return;
      isReauthorizingRef.current = true;
      reauthorize(serverRef.current)
        .then(() => {
          const freshToken =
            jotaiStore.get(serverTokensAtom).get(serverRef.current.id) ?? "";
          rawSendRef.current(
            JSON.stringify({
              type: WS_MSG.AUTH,
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

    // All other messages are forwarded to registered consumer handlers.
    dispatch(server.id, type, payload);
  }, [lastMessage, server.id]);

  const sendMessage = useCallback(
    (type: string, payload: unknown = {}) => {
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

  return { sendMessage, readyState };
}

export type { ReadyState };
