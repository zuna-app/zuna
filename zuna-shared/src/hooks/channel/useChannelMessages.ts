import { useState, useEffect, useCallback, useRef } from "react";
import { useSetAtom, useAtomValue } from "jotai";
import {
  channelMessagesAtom,
  channelMembersAtom,
  serverTokensAtom,
  jotaiStore,
} from "../../store/atoms";
import { useAuthorizedServerFetch } from "../server/useServerFetch";
import { useWsHandler } from "../ws/useWsHandler";
import { WS_MSG } from "../ws/wsTypes";
import {
  decryptWithChannelKey,
  encryptWithChannelKey,
} from "../../crypto/channel";
import { usePlatform } from "../../platform/PlatformContext";
import { useCurrentUser } from "../auth/useCurrentUser";
import { useSelfInfo } from "../server/useSelfInfo";
import type {
  Channel,
  ChannelMessage,
  ChannelMember,
  Server,
} from "../../types/serverTypes";
import type {
  ChannelMessageAckPayload,
  ChannelMessageReceivePayload,
  ChannelWriteReceivePayload,
} from "../ws/wsTypes";
import { channelWritingAtom } from "../../store/atoms";
import { useWsConnection } from "../ws/useWsConnection";

const MAX_INT64 = "9223372036854775807";

async function getChannelKey(
  vault: ReturnType<typeof usePlatform>["vault"],
  channelId: string,
): Promise<string | null> {
  return (await vault.get(`channel_key_${channelId}`)) as string | null;
}

function rawToChannelMessage(
  m: Record<string, unknown>,
  channelId: string,
  myUserId?: string,
): ChannelMessage {
  return {
    id: m.id as number,
    clientMessageId: (m.client_message_id as string) ?? "",
    channelId,
    senderId: (m.sender_id as string) ?? "",
    senderUsername: (m.sender_username as string) ?? "",
    senderAvatar: (m.sender_avatar as string) ?? "",
    cipherText: (m.cipher_text as string) ?? "",
    iv: (m.iv as string) ?? "",
    authTag: (m.auth_tag as string) ?? "",
    sentAt: (m.sent_at as number) ?? 0,
    pending: false,
  };
}

export function useChannelMessages(server: Server, channel: Channel | null) {
  const platform = usePlatform();
  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const { sendMessage } = useWsConnection(server);
  const setAllMessages = useSetAtom(channelMessagesAtom, { store: jotaiStore });
  const setChannelMembers = useSetAtom(channelMembersAtom, {
    store: jotaiStore,
  });
  const setChannelWriting = useSetAtom(channelWritingAtom, {
    store: jotaiStore,
  });
  const currentUser = useCurrentUser(server);
  const selfInfo = useSelfInfo(server);
  const selfInfoRef = useRef(selfInfo);
  useEffect(() => {
    selfInfoRef.current = selfInfo;
  }, [selfInfo]);

  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState(MAX_INT64);

  const channelId = channel?.id ?? null;
  const serverToken =
    useAtomValue(serverTokensAtom, { store: jotaiStore }).get(server.id) ??
    null;

  const messages = useAtomValue(channelMessagesAtom, { store: jotaiStore });
  const currentMessages = channelId ? (messages.get(channelId) ?? []) : [];

  const decryptMessage = useCallback(
    async (msg: ChannelMessage): Promise<ChannelMessage> => {
      if (!channelId || msg.plaintext !== undefined) return msg;
      const key = await getChannelKey(platform.vault, channelId);
      if (!key) return msg;
      try {
        const plaintext = decryptWithChannelKey(key, {
          ciphertext: msg.cipherText,
          iv: msg.iv,
          authTag: msg.authTag,
        });
        return { ...msg, plaintext };
      } catch {
        return msg;
      }
    },
    [platform.vault, channelId],
  );

  const prependMessages = useCallback(
    async (raw: ChannelMessage[]) => {
      const decrypted = await Promise.all(raw.map(decryptMessage));
      setAllMessages((prev) => {
        const next = new Map(prev);
        const existing = next.get(channelId!) ?? [];
        next.set(channelId!, [...existing, ...decrypted]);
        return next;
      });
    },
    [channelId, decryptMessage, setAllMessages],
  );

  // Initial load + members
  useEffect(() => {
    if (!channelId || !serverToken) return;

    // Reset state when channel changes
    setAllMessages((prev) => {
      const next = new Map(prev);
      next.set(channelId, []);
      return next;
    });
    setCursor(MAX_INT64);
    setHasMore(true);

    // Fetch members
    authorizedFetch(`/api/channel/members?channel_id=${channelId}`)
      .then((r) => r.json())
      .then((json) => {
        const raw: Array<Record<string, unknown>> = json?.members ?? [];
        const members: ChannelMember[] = raw.map((m) => ({
          userId: m.user_id as string,
          username: m.username as string,
          avatar: (m.avatar as string) ?? "",
          identityKey: (m.identity_key as string) ?? "",
        }));
        setChannelMembers((prev) => {
          const next = new Map(prev);
          next.set(channelId, members);
          return next;
        });
      })
      .catch(() => {});

    // Fetch initial messages
    setLoading(true);
    authorizedFetch(
      `/api/channel/messages?channel_id=${channelId}&limit=50&cursor=${MAX_INT64}`,
    )
      .then((r) => r.json())
      .then(async (json) => {
        const raw: Array<Record<string, unknown>> = json?.messages ?? [];
        const msgs = raw.map((m) => rawToChannelMessage(m, channelId));
        const decrypted = await Promise.all(msgs.map(decryptMessage));
        setAllMessages((prev) => {
          const next = new Map(prev);
          next.set(channelId, decrypted.reverse());
          return next;
        });
        if (raw.length > 0) {
          const minId = Math.min(...raw.map((m) => m.id as number));
          setCursor(String(minId));
        }
        setHasMore(raw.length === 50);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channelId, serverToken]);

  const fetchMore = useCallback(async () => {
    if (!channelId || !hasMore || loading) return;
    setLoading(true);
    try {
      const r = await authorizedFetch(
        `/api/channel/messages?channel_id=${channelId}&limit=50&cursor=${cursor}`,
      );
      const json = await r.json();
      const raw: Array<Record<string, unknown>> = json?.messages ?? [];
      const msgs = raw.map((m) => rawToChannelMessage(m, channelId));
      await prependMessages(msgs.reverse());
      if (raw.length > 0) {
        const minId = Math.min(...raw.map((m) => m.id as number));
        setCursor(String(minId));
      }
      setHasMore(raw.length === 50);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [channelId, hasMore, loading, cursor, authorizedFetch, prependMessages]);

  // WS: incoming message
  useWsHandler<ChannelMessageReceivePayload>(
    server,
    WS_MSG.CHANNEL_MESSAGE_RECEIVE,
    useCallback(
      async (payload) => {
        if (payload.channel_id !== channelId) return;
        let msg: ChannelMessage = {
          id: payload.id,
          clientMessageId: payload.client_message_id,
          channelId: payload.channel_id,
          senderId: payload.sender_id,
          senderUsername: payload.sender_username,
          senderAvatar: payload.sender_avatar,
          cipherText: payload.cipher_text,
          iv: payload.iv,
          authTag: payload.auth_tag,
          sentAt: payload.sent_at,
          pending: false,
        };
        msg = await decryptMessage(msg);
        setAllMessages((prev) => {
          const next = new Map(prev);
          const existing = next.get(channelId!) ?? [];
          // Avoid duplicates (e.g. if we receive our own message)
          if (existing.some((m) => m.id === msg.id)) return prev;
          next.set(channelId!, [...existing, msg]);
          return next;
        });
      },
      [channelId, decryptMessage, setAllMessages],
    ),
  );

  // WS: our message ack
  useWsHandler<ChannelMessageAckPayload>(
    server,
    WS_MSG.CHANNEL_MESSAGE_ACK,
    useCallback(
      (payload) => {
        if (payload.channel_id !== channelId) return;
        setAllMessages((prev) => {
          const next = new Map(prev);
          const existing = next.get(channelId!) ?? [];
          next.set(
            channelId!,
            existing.map((m) =>
              m.clientMessageId === payload.client_message_id
                ? {
                    ...m,
                    id: payload.id,
                    sentAt: payload.sent_at,
                    pending: false,
                  }
                : m,
            ),
          );
          return next;
        });
      },
      [channelId, setAllMessages],
    ),
  );

  // WS: typing indicator
  useWsHandler<ChannelWriteReceivePayload>(
    server,
    WS_MSG.CHANNEL_WRITE_RECEIVE,
    useCallback(
      (payload) => {
        setChannelWriting((prev) => {
          const next = new Map(prev);
          const channelMap = new Map(next.get(payload.channel_id) ?? []);
          if (payload.writing) {
            channelMap.set(payload.sender_id, {
              username: payload.sender_username,
            });
          } else {
            channelMap.delete(payload.sender_id);
          }
          next.set(payload.channel_id, channelMap);
          return next;
        });

        // Auto-clear after 4 seconds with no update
        if (payload.writing) {
          setTimeout(() => {
            setChannelWriting((prev) => {
              const next = new Map(prev);
              const channelMap = new Map(next.get(payload.channel_id) ?? []);
              channelMap.delete(payload.sender_id);
              next.set(payload.channel_id, channelMap);
              return next;
            });
          }, 4000);
        }
      },
      [setChannelWriting],
    ),
  );

  const sendChannelMessage = useCallback(
    async (text: string) => {
      if (!channelId || !channel) return;
      const key = await getChannelKey(platform.vault, channelId);
      if (!key) {
        console.error("[channel] no channel key, cannot send message");
        return;
      }

      const encrypted = encryptWithChannelKey(key, text);
      const clientMessageId = crypto.randomUUID();

      const { username: selfUsername, avatar: selfAvatar } =
        currentUser ?? selfInfoRef.current;

      const optimistic: ChannelMessage = {
        id: null,
        clientMessageId,
        channelId,
        senderId: "__self__",
        senderUsername: selfUsername,
        senderAvatar: selfAvatar,
        cipherText: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        sentAt: Date.now(),
        pending: true,
        plaintext: text,
      };

      setAllMessages((prev) => {
        const next = new Map(prev);
        const existing = next.get(channelId) ?? [];
        next.set(channelId, [...existing, optimistic]);
        return next;
      });

      sendMessage(WS_MSG.CHANNEL_MESSAGE, {
        channel_id: channelId,
        cipher_text: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        client_message_id: clientMessageId,
      });
    },
    [channelId, channel, platform.vault, sendMessage, setAllMessages],
  );

  const sendWriteIndicator = useCallback(
    (writing: boolean) => {
      if (!channelId) return;
      sendMessage(WS_MSG.CHANNEL_WRITE, { channel_id: channelId, writing });
    },
    [channelId, sendMessage],
  );

  return {
    messages: currentMessages,
    loading,
    hasMore,
    fetchMore,
    sendChannelMessage,
    sendWriteIndicator,
  };
}
