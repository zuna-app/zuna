import { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useWsHandler } from "../../ws/useWsHandler";
import {
  WS_MSG,
  MessageAckPayload,
  MessageDeleteReceivePayload,
  MessageModifyReceivePayload,
  MessagePinReceivePayload,
  MessageReadInfoPayload,
  MessageReceivePayload,
} from "../../ws/wsTypes";
import { Message, Server } from "../../../types/serverTypes";
import { LastMessage } from "../../../types/serverTypes";
import { decrypt } from "../../../crypto/x25519";

type WsSend = (type: string, payload?: unknown) => void;
type UpdateLastMessage = (msg: LastMessage) => void;

interface ConversationWsHandlersParams {
  server: Server;
  chatIdRef: MutableRefObject<string>;
  sharedSecretRef: MutableRefObject<string | null>;
  isFocused: boolean;
  lastMessagesRef: MutableRefObject<Record<string, LastMessage> | null>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  wsSend: WsSend;
  updateLastMessage: UpdateLastMessage;
}

export function useConversationWsHandlers({
  server,
  chatIdRef,
  sharedSecretRef,
  isFocused,
  lastMessagesRef,
  setMessages,
  wsSend,
  updateLastMessage,
}: ConversationWsHandlersParams) {
  useWsHandler<MessageAckPayload>(server, WS_MSG.MESSAGE_ACK, (payload) => {
    if (payload.chat_id !== chatIdRef.current) return;

    setMessages((prev) =>
      prev.map((m) =>
        m.clientMessageId === payload.client_message_id
          ? {
              ...m,
              id: payload.id,
              sentAt: payload.created_at,
              pending: false,
              isOwn: true,
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
        const existing = prev.find(
          (m) => m.clientMessageId === payload.client_message_id,
        );

        if (existing) {
          return prev.map((m) =>
            m.clientMessageId === payload.client_message_id
              ? {
                  ...m,
                  id: payload.id,
                  sentAt: payload.created_at,
                  pending: false,
                  attachmentId: payload.attachment_id ?? m.attachmentId,
                  attachmentMetadata:
                    payload.attachment_metadata ?? m.attachmentMetadata,
                  attachmentMetadataIv:
                    payload.attachment_metadata_iv ?? m.attachmentMetadataIv,
                  attachmentMetadataAuthTag:
                    payload.attachment_metadata_auth_tag ??
                    m.attachmentMetadataAuthTag,
                  modified: payload.modified ?? m.modified,
                  pinned: payload.pinned ?? m.pinned,
                  isReply: payload.is_reply ?? m.isReply,
                  replyInfo: payload.reply_info ?? m.replyInfo,
                }
              : m,
          );
        }

        return [
          ...prev,
          {
            id: payload.id,
            clientMessageId: payload.client_message_id,
            chatId: chatIdRef.current,
            cipherText: payload.cipher_text,
            iv: payload.iv,
            authTag: payload.auth_tag,
            sentAt: payload.created_at,
            senderId: payload.sender_id,
            isOwn: payload.sender_id === server.id,
            pending: false,
            attachmentId: payload.attachment_id,
            attachmentMetadata: payload.attachment_metadata,
            attachmentMetadataIv: payload.attachment_metadata_iv,
            attachmentMetadataAuthTag: payload.attachment_metadata_auth_tag,
            modified: payload.modified ?? false,
            pinned: payload.pinned ?? false,
            isReply: payload.is_reply,
            replyInfo: payload.reply_info,
          },
        ];
      });

      if (isFocused && payload.sender_id !== server.id) {
        wsSend(WS_MSG.MARK_READ, {
          chat_id: chatIdRef.current,
          timestamp: Date.now(),
        });
      }

      if (sharedSecretRef.current) {
        try {
          const plaintext = decrypt(sharedSecretRef.current, {
            ciphertext: payload.cipher_text,
            iv: payload.iv,
            authTag: payload.auth_tag,
          });

          updateLastMessage({
            chatId: chatIdRef.current,
            senderId: payload.sender_id,
            content: payload.attachment_id ? "📎 Attachment" : plaintext,
            unreadMessages: isFocused
              ? 0
              : (lastMessagesRef.current?.[chatIdRef.current]?.unreadMessages ??
                  0) + 1,
            lastActivityAt: payload.created_at,
          });
        } catch (err) {
          console.error(
            "[useConversationMessages] Failed to decrypt incoming message:",
            err,
          );
        }
      }
    },
  );

  useWsHandler<MessageDeleteReceivePayload>(
    server,
    WS_MSG.MESSAGE_DELETE_RECEIVE,
    (payload) => {
      setMessages((prev) => prev.filter((m) => m.id !== payload.id));
    },
  );

  useWsHandler<MessageModifyReceivePayload>(
    server,
    WS_MSG.MESSAGE_MODIFY_RECEIVE,
    (payload) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.id
            ? {
                ...m,
                cipherText: payload.cipher_text,
                iv: payload.iv,
                authTag: payload.auth_tag,
                plaintext: undefined,
                modified: true,
              }
            : m,
        ),
      );
    },
  );

  useWsHandler<MessagePinReceivePayload>(
    server,
    WS_MSG.MESSAGE_PIN_RECEIVE,
    (payload) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.id ? { ...m, pinned: payload.pinned } : m,
        ),
      );
    },
  );

  useWsHandler<MessageReadInfoPayload>(
    server,
    WS_MSG.MESSAGE_READ_INFO,
    (payload) => {
      if (payload.chat_id !== chatIdRef.current) return;

      const now = Date.now();
      setMessages((prev) => {
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
}
