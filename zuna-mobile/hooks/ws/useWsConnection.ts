import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { jotaiStore, serverTokensAtom, serverAuthErrorsAtom } from '@/store/atoms';
import { presenceAtom, writingAtom } from './usePresence';
import { dispatch } from './wsRegistry';
import {
  WS_MSG,
  PresenceUpdatePayload,
  PresenceResponsePayload,
  ErrorPayload,
  WriteReceivePayload,
} from './wsTypes';
import { Server } from '@/types/serverTypes';
import { reauthorize } from '@/hooks/auth/useAuthorizer';

export enum ReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

const MAX_RECONNECT = 10;
const RECONNECT_INTERVAL_MS = 3000;

// Module-level sockets shared across all hook instances for the same server
const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectCounts = new Map<string, number>();

export function useWsConnection(server: Server) {
  const tokens = useAtomValue(serverTokensAtom, { store: jotaiStore });
  const token = tokens.get(server.id) ?? null;

  const tokenRef = useRef(token);
  tokenRef.current = token;
  const serverRef = useRef(server);
  serverRef.current = server;
  const isReauthorizingRef = useRef(false);

  const [readyState, setReadyState] = useState<ReadyState>(ReadyState.CLOSED);

  const sendRaw = useCallback(
    (data: string) => {
      const ws = sockets.get(server.id);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
    [server.id]
  );

  const sendAuth = useCallback(() => {
    sendRaw(
      JSON.stringify({
        type: WS_MSG.AUTH,
        token: tokenRef.current ?? '',
        payload: {},
      })
    );
  }, [sendRaw]);

  const connect = useCallback(() => {
    if (!tokenRef.current) return;
    const existing = sockets.get(server.id);
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      setReadyState(
        existing.readyState === WebSocket.OPEN ? ReadyState.OPEN : ReadyState.CONNECTING
      );
      return;
    }

    const ws = new WebSocket(`wss://${server.address}/ws`);
    sockets.set(server.id, ws);
    setReadyState(ReadyState.CONNECTING);

    ws.onopen = () => {
      reconnectCounts.set(server.id, 0);
      setReadyState(ReadyState.OPEN);
      sendRaw(
        JSON.stringify({
          type: WS_MSG.AUTH,
          token: tokenRef.current ?? '',
          payload: {},
        })
      );
    };

    ws.onmessage = (event: MessageEvent) => {
      let envelope: { type: string; payload: unknown };
      try {
        envelope = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const { type, payload } = envelope;

      if (type === WS_MSG.AUTH_CONFIRMATION) {
        sendRaw(
          JSON.stringify({
            type: WS_MSG.PRESENCE_REQUEST,
            token: tokenRef.current ?? '',
            payload: {},
          })
        );
        return;
      }

      if (type === WS_MSG.PRESENCE_UPDATE) {
        const { user_id, active, last_seen } = (payload as PresenceUpdatePayload).presence;
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
              next.set(p.user_id, { userId: p.user_id, active: p.active, lastSeen: p.last_seen });
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

      if (type === WS_MSG.ERROR && (payload as ErrorPayload)?.code === 'forbidden') {
        if (isReauthorizingRef.current) return;
        isReauthorizingRef.current = true;
        reauthorize(serverRef.current)
          .then(() => {
            const freshToken = jotaiStore.get(serverTokensAtom).get(serverRef.current.id) ?? '';
            sendRaw(JSON.stringify({ type: WS_MSG.AUTH, token: freshToken, payload: {} }));
          })
          .catch((err) => console.error('[ws] reauthorize failed:', err))
          .finally(() => {
            isReauthorizingRef.current = false;
          });
        return;
      }

      dispatch(server.id, type, payload);
    };

    ws.onclose = () => {
      setReadyState(ReadyState.CLOSED);
      const count = reconnectCounts.get(server.id) ?? 0;
      if (count < MAX_RECONNECT && tokenRef.current) {
        reconnectCounts.set(server.id, count + 1);
        const timer = setTimeout(() => {
          reconnectTimers.delete(server.id);
          connect();
        }, RECONNECT_INTERVAL_MS);
        reconnectTimers.set(server.id, timer);
      }
    };

    ws.onerror = () => {
      // onclose fires after onerror; reconnect is handled there
    };
  }, [server.id, server.address, sendRaw]);

  useEffect(() => {
    if (!token) return;
    connect();
    return () => {
      // Don't close on unmount — socket is shared and persists while app is open
    };
  }, [token, connect]);

  const sendMessage = useCallback(
    (type: string, payload: unknown = {}) => {
      sendRaw(
        JSON.stringify({
          type,
          token: tokenRef.current ?? '',
          payload,
        })
      );
    },
    [sendRaw]
  );

  return { sendMessage, readyState };
}
