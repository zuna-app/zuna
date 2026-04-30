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

function wsDebug(serverId: string, event: string, details?: Record<string, unknown>) {
  if (!__DEV__) return;
  if (details) {
    console.debug(`[ws:${serverId}] ${event}`, details);
    return;
  }
  console.debug(`[ws:${serverId}] ${event}`);
}

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
      } else {
        wsDebug(server.id, 'sendRaw skipped; socket not open', {
          readyState: ws?.readyState ?? 'missing',
        });
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
    if (!tokenRef.current) {
      wsDebug(server.id, 'connect skipped; missing token');
      return;
    }
    const existing = sockets.get(server.id);
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      wsDebug(server.id, 'reusing existing socket', { readyState: existing.readyState });
      setReadyState(
        existing.readyState === WebSocket.OPEN ? ReadyState.OPEN : ReadyState.CONNECTING
      );
      return;
    }

    wsDebug(server.id, 'creating websocket connection', { address: server.address });
    const ws = new WebSocket(`wss://${server.address}/ws`);
    sockets.set(server.id, ws);
    setReadyState(ReadyState.CONNECTING);

    ws.onopen = () => {
      reconnectCounts.set(server.id, 0);
      setReadyState(ReadyState.OPEN);
      wsDebug(server.id, 'socket opened; sending auth');
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
        wsDebug(server.id, 'failed to parse incoming message');
        return;
      }

      const { type, payload } = envelope;
      wsDebug(server.id, 'incoming message', { type });

      if (type === WS_MSG.AUTH_CONFIRMATION) {
        wsDebug(server.id, 'auth confirmed; requesting presence');
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
        wsDebug(server.id, 'presence update', { userId: user_id, active });
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
          wsDebug(server.id, 'presence response', { count: list.length });
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
        if (!presence.get(sender_id)?.active) {
          wsDebug(server.id, 'write_receive ignored; sender offline', { senderId: sender_id });
          return;
        }
        wsDebug(server.id, 'write_receive', { chatId: chat_id, senderId: sender_id, writing });
        jotaiStore.set(writingAtom, (prev) => {
          const next = new Map(prev);
          next.set(sender_id, { chatId: chat_id, writing });
          return next;
        });
        return;
      }

      if (type === WS_MSG.ERROR && (payload as ErrorPayload)?.code === 'forbidden') {
        if (isReauthorizingRef.current) {
          wsDebug(server.id, 'forbidden received while reauthorizing; skipping');
          return;
        }
        wsDebug(server.id, 'forbidden received; reauthorizing');
        isReauthorizingRef.current = true;
        reauthorize(serverRef.current)
          .then(() => {
            const freshToken = jotaiStore.get(serverTokensAtom).get(serverRef.current.id) ?? '';
            wsDebug(server.id, 'reauthorize succeeded; sending auth');
            sendRaw(JSON.stringify({ type: WS_MSG.AUTH, token: freshToken, payload: {} }));
          })
          .catch((err) => console.error('[ws] reauthorize failed:', err))
          .finally(() => {
            isReauthorizingRef.current = false;
          });
        return;
      }

      wsDebug(server.id, 'dispatching message to handlers', { type });
      dispatch(server.id, type, payload);
    };

    ws.onclose = (event: CloseEvent) => {
      setReadyState(ReadyState.CLOSED);
      const count = reconnectCounts.get(server.id) ?? 0;
      wsDebug(server.id, 'socket closed', {
        code: event.code,
        reason: event.reason,
        reconnectAttempt: count + 1,
      });
      if (count < MAX_RECONNECT && tokenRef.current) {
        reconnectCounts.set(server.id, count + 1);
        const timer = setTimeout(() => {
          reconnectTimers.delete(server.id);
          wsDebug(server.id, 'running reconnect timer callback', {
            attempt: (reconnectCounts.get(server.id) ?? 0) + 1,
          });
          connect();
        }, RECONNECT_INTERVAL_MS);
        reconnectTimers.set(server.id, timer);
      } else {
        wsDebug(server.id, 'reconnect skipped', {
          maxReached: count >= MAX_RECONNECT,
          hasToken: !!tokenRef.current,
        });
      }
    };

    ws.onerror = () => {
      wsDebug(server.id, 'socket error event emitted');
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
      wsDebug(server.id, 'sending message', { type });
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
