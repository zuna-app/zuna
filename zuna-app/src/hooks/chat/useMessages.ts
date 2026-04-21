import { useCallback, useEffect, useRef, useState } from "react";
import { ReadyState } from "react-use-websocket";
import { useWsConnection } from "@/hooks/ws/useWsConnection";
import { useWsHandler } from "@/hooks/ws/useWsHandler";
import {
  WS_MSG,
  MessageAckPayload,
  MessageReceivePayload,
  MessageReadInfoPayload,
} from "@/hooks/ws/wsTypes";
import { useAuthorizedServerFetch } from "@/hooks/server/useServerFetch";
import { jotaiStore, serverTokensAtom } from "@/hooks/auth/useAuthorizer";
import { Message, RawMessageDTO, Server } from "@/types/serverTypes";
import { useLastMessagesUpdater } from "./useLastChatMessages";

const MESSAGES_LIMIT = 50;
const MAX_CURSOR = "9223372036854775807";

function xhrUpload(
  url: string,
  token: string,
  formData: FormData,
  onProgress: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 201) {
        try {
          const response = JSON.parse(xhr.responseText) as {
            attachment_id: string;
          };
          resolve(response.attachment_id);
        } catch {
          reject(new Error("Invalid upload response"));
        }
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.send(formData);
  });
}

export function useMessages(
  server: Server,
  chatId: string,
  sharedSecret: string | null,
  identityKey: string,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const localIdCounter = useRef(0);
  const isFetchingRef = useRef(false);
  const wasOlderPaginationRef = useRef(false);
  const prevReadyStateRef = useRef<ReadyState | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const isFocusedRef = useRef(
    typeof document !== "undefined" ? document.hasFocus() : true,
  );
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInactiveRef = useRef(false);
  const lastPresenceRef = useRef<boolean | null>(null);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  // Stable refs so fetchMore doesn’t recreate on every message update.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;

  const { lastMessages, updateLastMessage } = useLastMessagesUpdater();
  const { authorizedFetch } = useAuthorizedServerFetch(server);

  const lastMessagesRef = useRef(lastMessages);
  lastMessagesRef.current = lastMessages;

  const sharedSecretRef = useRef(sharedSecret);
  sharedSecretRef.current = sharedSecret;

  const { sendMessage: wsSend, readyState } = useWsConnection(server);

  // ── Typed message handlers ─────────────────────────────────────────────────

  useWsHandler<MessageAckPayload>(server, WS_MSG.MESSAGE_ACK, (payload) => {
    if (payload.chat_id !== chatIdRef.current) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.localId === payload.local_id
          ? {
              ...m,
              id: payload.id,
              sentAt: payload.created_at,
              pending: false,
              isOwn: true,
              localId: null,
              uploadProgress: undefined,
              attachmentId: payload.attachment_id ?? m.attachmentId,
              attachmentMetadata:
                payload.attachment_metadata ?? m.attachmentMetadata,
              attachmentMetadataIv:
                payload.attachment_metadata_iv ?? m.attachmentMetadataIv,
              attachmentMetadataAuthTag:
                payload.attachment_metadata_auth_tag ??
                m.attachmentMetadataAuthTag,
            }
          : m,
      ),
    );
  });

  useWsHandler<MessageReceivePayload>(
    server,
    WS_MSG.MESSAGE_RECEIVE,
    (payload) => {
      if (payload.chat_id !== chatIdRef.current) return;

      setMessages((prev) => {
        if (prev.some((m) => m.id === payload.id)) return prev;
        return [
          ...prev,
          {
            id: payload.id,
            localId: null,
            chatId: chatIdRef.current,
            cipherText: payload.cipher_text,
            iv: payload.iv,
            authTag: payload.auth_tag,
            sentAt: payload.created_at,
            senderId: payload.sender_id,
            isOwn: false,
            pending: false,
            attachmentId: payload.attachment_id,
            attachmentMetadata: payload.attachment_metadata,
            attachmentMetadataIv: payload.attachment_metadata_iv,
            attachmentMetadataAuthTag: payload.attachment_metadata_auth_tag,
          },
        ];
      });

      if (isFocusedRef.current) {
        wsSend(WS_MSG.MARK_READ, {
          chat_id: chatIdRef.current,
          timestamp: Date.now(),
        });
      }

      if (sharedSecretRef.current) {
        window.security
          .decrypt(sharedSecretRef.current, {
            ciphertext: payload.cipher_text,
            iv: payload.iv,
            authTag: payload.auth_tag,
          })
          .then((plaintext) => {
            updateLastMessage({
              chatId: chatIdRef.current,
              senderId: payload.sender_id,
              content: payload.attachment_id
                ? "\uD83D\uDCCE Attachment"
                : plaintext,
              unreadMessages: isFocusedRef.current
                ? 0
                : (lastMessagesRef.current?.[chatIdRef.current]
                    ?.unreadMessages ?? 0) + 1,
              lastActivityAt: payload.created_at,
            });
          })
          .catch((err) => {
            console.error(
              "[useMessages] Failed to decrypt incoming message:",
              err,
            );
          });
      }
    },
  );

  useWsHandler<MessageReadInfoPayload>(
    server,
    WS_MSG.MESSAGE_READ_INFO,
    (payload) => {
      if (payload.chat_id !== chatIdRef.current) return;
      const now = Date.now();
      setMessages((prev) => {
        // Only rebuild objects that actually need the readAt timestamp.
        const needsUpdate = prev.some((m) => m.isOwn && !m.readAt);
        if (!needsUpdate) return prev;
        return prev.map((m) =>
          m.isOwn && !m.readAt ? { ...m, readAt: now } : m,
        );
      });
      updateLastMessage({
        chatId: chatIdRef.current,
        senderId: lastMessagesRef.current?.[chatIdRef.current]?.senderId ?? "",
        content: lastMessagesRef.current?.[chatIdRef.current]?.content ?? "",
        unreadMessages: 0,
        lastActivityAt:
          lastMessagesRef.current?.[chatIdRef.current]?.lastActivityAt ??
          Date.now(),
      });
    },
  );

  // ── Chat-open effect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!isFocusedRef.current) return;
    if (lastMessages) {
      const lastMsg = lastMessages[chatId];
      wsSend(WS_MSG.PRESENCE, { active: true });
      if (lastMsg) {
        updateLastMessage({
          chatId,
          senderId: lastMsg.senderId,
          content: lastMsg.content,
          unreadMessages: 0,
          lastActivityAt: lastMsg.lastActivityAt,
        });
      }
      wsSend(WS_MSG.MARK_READ, { chat_id: chatId, timestamp: Date.now() });
    }
  }, [chatId]);

  // ── Window focus / blur / minimize / inactivity ──────────────────────────

  useEffect(() => {
    const INACTIVITY_MS = 5 * 60 * 1000;

    const sendPresence = (active: boolean) => {
      if (lastPresenceRef.current === active) return;
      lastPresenceRef.current = active;
      wsSend(WS_MSG.PRESENCE, { active });
    };

    const clearInactivityTimer = () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };

    const startInactivityTimer = () => {
      clearInactivityTimer();
      inactivityTimerRef.current = setTimeout(() => {
        isInactiveRef.current = true;
        sendPresence(false);
      }, INACTIVITY_MS);
    };

    const onActivity = () => {
      if (!isFocusedRef.current) return;
      if (isInactiveRef.current) {
        isInactiveRef.current = false;
        sendPresence(true);
      }
      startInactivityTimer();
    };

    const onFocus = () => {
      isFocusedRef.current = true;
      isInactiveRef.current = false;
      sendPresence(true);
      startInactivityTimer();
      const msgs = lastMessagesRef.current;
      const cId = chatIdRef.current;
      if (msgs && cId) {
        const lastMsg = msgs[cId];
        if (lastMsg && lastMsg.unreadMessages > 0) {
          updateLastMessage({
            chatId: cId,
            senderId: lastMsg.senderId,
            content: lastMsg.content,
            unreadMessages: 0,
            lastActivityAt: lastMsg.lastActivityAt,
          });
        }
        wsSend(WS_MSG.MARK_READ, { chat_id: cId, timestamp: Date.now() });
      }
    };

    const onBlur = () => {
      isFocusedRef.current = false;
      isInactiveRef.current = false;
      clearInactivityTimer();
      sendPresence(false);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        isFocusedRef.current = false;
        isInactiveRef.current = false;
        clearInactivityTimer();
        sendPresence(false);
      } else if (
        document.visibilityState === "visible" &&
        document.hasFocus()
      ) {
        isFocusedRef.current = true;
        isInactiveRef.current = false;
        sendPresence(true);
        startInactivityTimer();
      }
    };

    const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown"] as const;
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity));
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    if (isFocusedRef.current) {
      startInactivityTimer();
    }

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInactivityTimer();
    };
  }, [wsSend]);

  // ── History fetch ──────────────────────────────────────────────────────────

  const fetchMessages = useCallback(
    async (cursor: string = MAX_CURSOR) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      setLoading(true);
      try {
        const res = await authorizedFetch(
          `/api/chat/messages?chat_id=${encodeURIComponent(chatId)}&limit=${MESSAGES_LIMIT}&cursor=${cursor}`,
        );
        const json: { messages: RawMessageDTO[] } = await res.json();
        const fetched: Message[] = (json.messages ?? []).reverse().map((m) => ({
          id: m.id,
          localId: null,
          chatId,
          cipherText: m.cipher_text,
          iv: m.iv,
          authTag: m.auth_tag,
          sentAt: m.sent_at,
          readAt: m.read_at > 0 ? m.read_at : undefined,
          senderId: m.sender_id,
          isOwn: m.sender_id === server.id,
          pending: false,
          attachmentId: m.attachment_id,
          attachmentMetadata: m.attachment_metadata,
          attachmentMetadataIv: m.attachment_metadata_iv,
          attachmentMetadataAuthTag: m.attachment_metadata_auth_tag,
        }));

        if (cursor === MAX_CURSOR) {
          setMessages((prev) => {
            const pending = prev.filter((m) => m.pending);
            const fetchedIds = new Set(fetched.map((m) => m.id));
            const uniquePending = pending.filter(
              (m) => m.id === null || !fetchedIds.has(m.id),
            );
            return [...fetched, ...uniquePending];
          });
        } else {
          wasOlderPaginationRef.current = true;
          setMessages((prev) => [...fetched, ...prev]);
        }

        setHasMore(fetched.length === MESSAGES_LIMIT);
      } catch (err) {
        console.error("[useMessages] failed to fetch messages:", err);
      } finally {
        setLoading(false);
        isFetchingRef.current = false;
      }
    },
    [authorizedFetch, chatId],
  );

  useEffect(() => {
    const chatChanged =
      prevChatIdRef.current !== null && prevChatIdRef.current !== chatId;
    const justConnected =
      readyState === ReadyState.OPEN &&
      prevReadyStateRef.current !== ReadyState.OPEN;

    if (chatChanged) {
      setMessages([]);
      setHasMore(true);
      isFetchingRef.current = false;
    }

    if (readyState === ReadyState.OPEN && (chatChanged || justConnected)) {
      fetchMessages(MAX_CURSOR);
    }

    prevReadyStateRef.current = readyState;
    prevChatIdRef.current = chatId;
  }, [readyState, chatId, fetchMessages]);

  useEffect(() => {
    if (wasOlderPaginationRef.current) {
      wasOlderPaginationRef.current = false;
      return;
    }
    if (messages.length > MESSAGES_LIMIT) {
      setHasMore(true);
      setMessages((prev) =>
        prev.length > MESSAGES_LIMIT
          ? prev.slice(prev.length - MESSAGES_LIMIT)
          : prev,
      );
    }
  }, [messages.length]);

  const sendChatMessage = useCallback(
    async (
      cipherText: string,
      iv: string,
      authTag: string,
      plaintext: string,
    ) => {
      const localId = ++localIdCounter.current;
      const optimistic: Message = {
        id: null,
        localId,
        chatId,
        cipherText,
        iv,
        authTag,
        sentAt: Date.now(),
        senderId: server.id,
        isOwn: true,
        pending: true,
        plaintext,
      };
      setMessages((prev) => [...prev, optimistic]);

      const previewContent =
        plaintext.length <= 100 ? plaintext : plaintext.slice(0, 100) + "...";
      const encryptedPreviewContent = await window.security.encrypt(
        sharedSecretRef.current!,
        previewContent,
      );

      wsSend(WS_MSG.MESSAGE, {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        local_id: localId,
        short_cipher_text: encryptedPreviewContent.ciphertext,
        short_iv: encryptedPreviewContent.iv,
        short_auth_tag: encryptedPreviewContent.authTag,
      });

      updateLastMessage({
        chatId,
        senderId: server.id,
        content: plaintext,
        unreadMessages: 0,
        lastActivityAt: optimistic.sentAt,
      });
    },
    [chatId, wsSend, updateLastMessage],
  );

  const fetchMore = useCallback(() => {
    const oldest = messagesRef.current.find((m) => m.id !== null);
    if (oldest?.id != null && !isFetchingRef.current && hasMoreRef.current) {
      fetchMessages(String(oldest.id));
    }
  }, [fetchMessages]);

  // ── Upload & send attachment ───────────────────────────────────────────────

  const uploadAndSend = useCallback(
    async (file: File, plaintext: string) => {
      const localId = ++localIdCounter.current;

      setMessages((prev) => [
        ...prev,
        {
          id: null,
          localId,
          chatId,
          cipherText: "",
          iv: "",
          authTag: "",
          sentAt: Date.now(),
          senderId: server.id,
          isOwn: true,
          pending: true,
          plaintext,
          uploadProgress: 0,
          attachmentFilename: file.name,
        },
      ]);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const fileUint8 = new Uint8Array(arrayBuffer);
        const encryptedBytes = await window.security.encryptFile(
          fileUint8,
          identityKey,
        );

        const metadataJson = JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType: file.type,
        });
        const secret = sharedSecretRef.current;
        if (!secret) throw new Error("No shared secret available");
        const encMeta = await window.security.encrypt(secret, metadataJson);

        const textToEncrypt = plaintext.trim() || "\u200b"; // zero-width space placeholder
        const encText = await window.security.encrypt(secret, textToEncrypt);

        const encryptedBlob = new Blob([
          encryptedBytes.buffer.slice(
            encryptedBytes.byteOffset,
            encryptedBytes.byteOffset + encryptedBytes.byteLength,
          ) as ArrayBuffer,
        ]);
        const formData = new FormData();
        formData.append("size", String(encryptedBlob.size));
        formData.append("metadata", encMeta.ciphertext);
        formData.append("metadata_iv", encMeta.iv);
        formData.append("metadata_auth_tag", encMeta.authTag);
        formData.append("file", encryptedBlob, file.name);

        const token = jotaiStore.get(serverTokensAtom).get(server.id) ?? "";

        const attachmentId = await xhrUpload(
          `http://${server.address}/api/attachment/upload`,
          token,
          formData,
          (pct) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.localId === localId ? { ...m, uploadProgress: pct } : m,
              ),
            );
          },
        );

        // Transition local message: remove progress indicator, fill in cipher fields.
        // Clear attachmentFilename so chat-messages.tsx uses the decrypted metadata
        // (which carries the real size and mimeType) instead of a stub with size: 0.
        setMessages((prev) =>
          prev.map((m) =>
            m.localId === localId
              ? {
                  ...m,
                  uploadProgress: undefined,
                  cipherText: encText.ciphertext,
                  iv: encText.iv,
                  authTag: encText.authTag,
                  plaintext: plaintext.trim() || undefined,
                  attachmentId,
                  attachmentFilename: undefined,
                  attachmentMetadata: encMeta.ciphertext,
                  attachmentMetadataIv: encMeta.iv,
                  attachmentMetadataAuthTag: encMeta.authTag,
                }
              : m,
          ),
        );

        wsSend(WS_MSG.MESSAGE, {
          chat_id: chatId,
          cipher_text: encText.ciphertext,
          iv: encText.iv,
          auth_tag: encText.authTag,
          local_id: localId,
          attachment_id: attachmentId,
        });

        updateLastMessage({
          chatId,
          senderId: server.id,
          content: plaintext.trim() || `📎 ${file.name}`,
          unreadMessages: 0,
          lastActivityAt: Date.now(),
        });
      } catch (err) {
        console.error("[useMessages] uploadAndSend failed:", err);
        setMessages((prev) => prev.filter((m) => m.localId !== localId));
      }
    },
    [chatId, server, identityKey, wsSend, updateLastMessage],
  );

  return {
    messages,
    loading,
    hasMore,
    sendMessage: sendChatMessage,
    uploadAndSend,
    fetchMore,
    readyState,
  };
}
