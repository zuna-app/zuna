import { atom, useAtomValue } from "jotai";
import { useCallback, useRef } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import {
  jotaiStore,
  reauthorize,
  serverTokensAtom,
} from "@/hooks/useAuthorizer";
import { Server } from "@/types/serverTypes";
import { useChatList } from "./useChatList";
import { useSharedSecrets } from "./useSharedSecret";
import {
  lastMessagesAtom,
  useLastMessagesUpdater,
} from "./useLastChatMessages";
import { selectedChatAtom } from "./useSelectedChat";

export type ZunaResponse = {
  type: string;
  payload: any;
};

export interface MemberPresence {
  userId: string;
  active: boolean;
  lastSeen: number;
}

const presenceAtom = atom<Map<string, MemberPresence>>(new Map());

export const usePresence = () => {
  const presence = useAtomValue(presenceAtom, { store: jotaiStore });
  return {
    getMemberPresence: (userId: string): MemberPresence | null => {
      return presence.get(userId) ?? null;
    },
  };
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

  const { updateLastMessage } = useLastMessagesUpdater();
  const { data } = useChatList(server);
  const sharedSecrets = useSharedSecrets(data || null);

  const rawSendRef = useRef<(data: string) => void>(() => {});

  const sharedSecretsRef = useRef(sharedSecrets);
  sharedSecretsRef.current = sharedSecrets;

  const updateLastMessageRef = useRef(updateLastMessage);
  updateLastMessageRef.current = updateLastMessage;

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
      if (data.type === "presence_update") {
        const { user_id, active, last_seen } = data.payload.presence;
        jotaiStore.set(presenceAtom, (prev) => {
          const next = new Map(prev);
          next.set(user_id, {
            userId: user_id,
            active,
            lastSeen: last_seen,
          });
          return next;
        });
        return;
      }
      if (
        data.type === "presence_response" &&
        Array.isArray(data.payload.presence)
      ) {
        jotaiStore.set(presenceAtom, (prev) => {
          const next = new Map(prev);
          for (const p of data.payload.presence) {
            next.set(p.user_id, {
              userId: p.user_id,
              active: p.active,
              lastSeen: p.last_seen,
            });
          }
          return next;
        });
        return;
      }

      if (data.type === "auth_confirmation") {
        rawSendRef.current(
          JSON.stringify({
            type: "presence_request",
            token: tokenRef.current ?? "",
            payload: {},
          }),
        );
      }

      if (data.type === "message_receive") {
        const {
          id,
          chat_id,
          created_at,
          sender_id,
          cipher_text,
          iv,
          auth_tag,
        } = data.payload;

        if (jotaiStore.get(selectedChatAtom) !== chat_id) {
          const secret = sharedSecretsRef.current?.[sender_id];
          if (secret) {
            window.security
              .decrypt(secret, {
                ciphertext: cipher_text,
                iv,
                authTag: auth_tag,
              })
              .then((plaintext) => {
                const currentLastMessages = jotaiStore.get(lastMessagesAtom);
                updateLastMessageRef.current({
                  chatId: chat_id,
                  senderId: sender_id,
                  content: plaintext,
                  unreadMessages: currentLastMessages[chat_id]
                    ? currentLastMessages[chat_id].unreadMessages + 1
                    : 1,
                  lastActivityAt: created_at,
                });
              })
              .catch((err) => {
                console.error(
                  "Failed to decrypt message for presence update:",
                  err,
                );
              });
          }
        }
      }

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
