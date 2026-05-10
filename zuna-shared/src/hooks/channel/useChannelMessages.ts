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
  encryptFileWithChannelKey,
} from "../../crypto/channel";
import { usePlatform } from "../../platform/PlatformContext";
import { useCurrentUser } from "../auth/useCurrentUser";
import { useSelfInfo } from "../server/useSelfInfo";
import { xhrUpload } from "../chat/xhrUpload";
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
    attachmentId: (m.attachment_id as string) || undefined,
    attachmentMetadata: (m.attachment_metadata as string) || undefined,
    attachmentMetadataIv: (m.attachment_metadata_iv as string) || undefined,
    attachmentMetadataAuthTag:
      (m.attachment_metadata_auth_tag as string) || undefined,
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
  const [channelKey, setChannelKey] = useState<string | null>(null);
  const [decryptedMeta, setDecryptedMeta] = useState<
    Map<string, { name: string; size: number; mimeType: string }>
  >(new Map());
  const metaInFlightRef = useRef<Set<string>>(new Set());
  const lastMarkedReadSentAtRef = useRef<number>(0);

  const channelId = channel?.id ?? null;
  const serverToken =
    useAtomValue(serverTokensAtom, { store: jotaiStore }).get(server.id) ??
    null;

  // Load channel key when channelId changes
  useEffect(() => {
    if (!channelId) {
      setChannelKey(null);
      lastMarkedReadSentAtRef.current = 0;
      return;
    }
    lastMarkedReadSentAtRef.current = 0;
    getChannelKey(platform.vault, channelId).then(setChannelKey);
  }, [channelId, platform.vault]);

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

  // Decrypt attachment metadata for all messages that have it
  useEffect(() => {
    if (!channelId) return;

    const toDecryptMeta = currentMessages.filter((m) => {
      if (
        !m.attachmentMetadata ||
        !m.attachmentMetadataIv ||
        !m.attachmentMetadataAuthTag
      )
        return false;
      if (m.attachmentFilename) return false;
      const key = m.clientMessageId;
      if (metaInFlightRef.current.has(key)) return false;
      if (decryptedMeta.has(key)) return false;
      return true;
    });

    if (!toDecryptMeta.length) return;

    toDecryptMeta.forEach((m) =>
      metaInFlightRef.current.add(m.clientMessageId),
    );

    getChannelKey(platform.vault, channelId).then((key) => {
      if (!key) {
        toDecryptMeta.forEach((m) =>
          metaInFlightRef.current.delete(m.clientMessageId),
        );
        return;
      }

      Promise.all(
        toDecryptMeta.map(async (m) => {
          const msgKey = m.clientMessageId;
          try {
            const json = decryptWithChannelKey(key, {
              ciphertext: m.attachmentMetadata!,
              iv: m.attachmentMetadataIv!,
              authTag: m.attachmentMetadataAuthTag!,
            });
            const meta = JSON.parse(json) as {
              name: string;
              size: number;
              mimeType: string;
            };
            return [msgKey, meta] as const;
          } catch {
            return [msgKey, null] as const;
          }
        }),
      ).then((results) => {
        results.forEach(([k]) => metaInFlightRef.current.delete(k));
        setDecryptedMeta((prev) => {
          const next = new Map(prev);
          for (const [k, meta] of results) {
            if (meta) next.set(k, meta);
          }
          return next;
        });
      });
    });
  }, [currentMessages, channelId, platform.vault]);

  const getChannelAttachmentMeta = useCallback(
    (msg: ChannelMessage) => {
      if (msg.attachmentFilename) {
        return { name: msg.attachmentFilename, size: 0, mimeType: "" };
      }
      return decryptedMeta.get(msg.clientMessageId) ?? null;
    },
    [decryptedMeta],
  );

  const sendChannelMarkRead = useCallback(
    (timestamp?: number) => {
      if (!channelId) return;
      const now = Date.now();
      const candidate = timestamp ?? now;
      const monotonicTs = Math.max(
        candidate,
        now,
        lastMarkedReadSentAtRef.current,
      );
      lastMarkedReadSentAtRef.current = monotonicTs;
      sendMessage(WS_MSG.CHANNEL_MARK_READ, {
        channel_id: channelId,
        timestamp: monotonicTs,
      });
    },
    [channelId, sendMessage],
  );

  // Mark channel as read when opened
  useEffect(() => {
    if (!channelId) return;
    sendChannelMarkRead();
  }, [channelId, sendChannelMarkRead]);

  // Re-mark with server message timestamp so backend read state is clock-skew safe.
  useEffect(() => {
    if (!channelId || currentMessages.length === 0) return;
    const lastSentAt = currentMessages.reduce((max, msg) => {
      const sentAt = typeof msg.sentAt === "number" ? msg.sentAt : 0;
      return sentAt > max ? sentAt : max;
    }, 0);
    if (lastSentAt > 0) {
      sendChannelMarkRead(lastSentAt);
    }
  }, [channelId, currentMessages, sendChannelMarkRead]);

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
      .catch(() => { });

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
      .catch(() => { })
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
        // Channel is currently open — send mark_read immediately
        sendChannelMarkRead(payload.sent_at);
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
          attachmentId: payload.attachment_id || undefined,
          attachmentMetadata: payload.attachment_metadata || undefined,
          attachmentMetadataIv: payload.attachment_metadata_iv || undefined,
          attachmentMetadataAuthTag:
            payload.attachment_metadata_auth_tag || undefined,
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
      [channelId, decryptMessage, setAllMessages, sendChannelMarkRead],
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
                  attachmentId: payload.attachment_id || m.attachmentId,
                  attachmentMetadata:
                    payload.attachment_metadata || m.attachmentMetadata,
                  attachmentMetadataIv:
                    payload.attachment_metadata_iv || m.attachmentMetadataIv,
                  attachmentMetadataAuthTag:
                    payload.attachment_metadata_auth_tag ||
                    m.attachmentMetadataAuthTag,
                  uploadProgress: undefined,
                  attachmentFilename: undefined,
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

  const sendChannelMessageWithAttachment = useCallback(
    async (file: File, plaintext: string) => {
      if (!channelId || !channel) return;
      const key = await getChannelKey(platform.vault, channelId);
      if (!key) {
        console.error("[channel] no channel key, cannot send attachment");
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const { username: selfUsername, avatar: selfAvatar } =
        currentUser ?? selfInfoRef.current;

      // Optimistic message with upload progress
      setAllMessages((prev) => {
        const next = new Map(prev);
        const existing = next.get(channelId) ?? [];
        next.set(channelId, [
          ...existing,
          {
            id: null,
            clientMessageId,
            channelId,
            senderId: "__self__",
            senderUsername: selfUsername,
            senderAvatar: selfAvatar,
            cipherText: "",
            iv: "",
            authTag: "",
            sentAt: Date.now(),
            pending: true,
            plaintext: plaintext.trim() || undefined,
            uploadProgress: 0,
            attachmentFilename: file.name,
          },
        ]);
        return next;
      });

      try {
        const arrayBuffer = await file.arrayBuffer();
        const fileBytes = new Uint8Array(arrayBuffer);

        // Encrypt the file bytes using the channel key
        const encryptedBytes = encryptFileWithChannelKey(fileBytes, key);

        // Encrypt metadata using the channel key
        const metadataJson = JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType: file.type,
        });
        const encryptedMetadata = encryptWithChannelKey(key, metadataJson);

        // Encrypt the caption text (or zero-width space if empty)
        const textToEncrypt = plaintext.trim() || "\u200b";
        const encryptedText = encryptWithChannelKey(key, textToEncrypt);

        const encryptedBlob = new Blob([
          encryptedBytes.buffer.slice(
            encryptedBytes.byteOffset,
            encryptedBytes.byteOffset + encryptedBytes.byteLength,
          ) as ArrayBuffer,
        ]);

        const formData = new FormData();
        formData.append("size", String(encryptedBlob.size));
        formData.append("metadata", encryptedMetadata.ciphertext);
        formData.append("metadata_iv", encryptedMetadata.iv);
        formData.append("metadata_auth_tag", encryptedMetadata.authTag);
        formData.append("file", encryptedBlob, file.name);

        const token = jotaiStore.get(serverTokensAtom).get(server.id) ?? "";

        const attachmentId = await xhrUpload(
          `https://${server.address}/api/attachment/upload`,
          token,
          formData,
          (pct) => {
            setAllMessages((prev) => {
              const next = new Map(prev);
              const existing = next.get(channelId) ?? [];
              next.set(
                channelId,
                existing.map((m) =>
                  m.clientMessageId === clientMessageId
                    ? { ...m, uploadProgress: pct }
                    : m,
                ),
              );
              return next;
            });
          },
        );

        setAllMessages((prev) => {
          const next = new Map(prev);
          const existing = next.get(channelId) ?? [];
          next.set(
            channelId,
            existing.map((m) =>
              m.clientMessageId === clientMessageId
                ? {
                  ...m,
                  uploadProgress: undefined,
                  cipherText: encryptedText.ciphertext,
                  iv: encryptedText.iv,
                  authTag: encryptedText.authTag,
                  plaintext: plaintext.trim() || undefined,
                  attachmentId,
                  attachmentFilename: undefined,
                  attachmentMetadata: encryptedMetadata.ciphertext,
                  attachmentMetadataIv: encryptedMetadata.iv,
                  attachmentMetadataAuthTag: encryptedMetadata.authTag,
                }
                : m,
            ),
          );
          return next;
        });

        sendMessage(WS_MSG.CHANNEL_MESSAGE, {
          channel_id: channelId,
          cipher_text: encryptedText.ciphertext,
          iv: encryptedText.iv,
          auth_tag: encryptedText.authTag,
          client_message_id: clientMessageId,
          attachment_id: attachmentId,
        });
      } catch (err) {
        console.error(
          "[useChannelMessages] sendChannelMessageWithAttachment failed:",
          err,
        );
        setAllMessages((prev) => {
          const next = new Map(prev);
          const existing = next.get(channelId) ?? [];
          next.set(
            channelId,
            existing.filter((m) => m.clientMessageId !== clientMessageId),
          );
          return next;
        });
      }
    },
    [
      channelId,
      channel,
      platform.vault,
      server,
      sendMessage,
      setAllMessages,
      currentUser,
    ],
  );

  return {
    messages: currentMessages,
    loading,
    hasMore,
    fetchMore,
    sendChannelMessage,
    sendChannelMessageWithAttachment,
    sendWriteIndicator,
    getChannelAttachmentMeta,
    channelKey,
  };
}
