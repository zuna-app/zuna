import { Dispatch, MutableRefObject, SetStateAction, useCallback } from "react";
import { WS_MSG } from "../../ws/wsTypes";
import { jotaiStore, serverTokensAtom } from "../../../store/atoms";
import { Message, LastMessage, Server } from "../../../types/serverTypes";
import { encrypt } from "../../../crypto/x25519";
import { encryptFile } from "../../../crypto/file";
import { xhrUpload } from "../xhrUpload";
import type { IVaultAdapter } from "../../../platform";

type WsSend = (type: string, payload?: unknown) => void;
type UpdateLastMessage = (msg: LastMessage) => void;

interface MessageActionsParams {
  server: Server;
  chatId: string;
  sharedSecretRef: MutableRefObject<string | null>;
  messagesRef: MutableRefObject<Message[]>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  wsSend: WsSend;
  updateLastMessage: UpdateLastMessage;
  identityKey: string;
  vault: IVaultAdapter;
}

export function useMessageActions({
  server,
  chatId,
  sharedSecretRef,
  messagesRef,
  setMessages,
  wsSend,
  updateLastMessage,
  identityKey,
  vault,
}: MessageActionsParams) {
  // ── Send text message ──────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (
      cipherText: string,
      iv: string,
      authTag: string,
      plaintext: string,
    ) => {
      const clientMessageId = crypto.randomUUID();
      const optimistic: Message = {
        id: null,
        clientMessageId,
        chatId,
        cipherText,
        iv,
        authTag,
        sentAt: Date.now(),
        senderId: server.id,
        isOwn: true,
        pending: true,
        plaintext,
        modified: false,
        pinned: false,
        isReply: false,
      };
      setMessages((prev) => [...prev, optimistic]);

      const previewContent =
        plaintext.length <= 100 ? plaintext : plaintext.slice(0, 100) + "...";
      const encryptedPreview = encrypt(
        sharedSecretRef.current!,
        previewContent,
      );

      wsSend(WS_MSG.MESSAGE, {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        client_message_id: clientMessageId,
        short_cipher_text: encryptedPreview.ciphertext,
        short_iv: encryptedPreview.iv,
        short_auth_tag: encryptedPreview.authTag,
        reply_to: 0,
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

  // ── Send reply message ─────────────────────────────────────────────────────

  const sendReplyMessage = useCallback(
    async (
      cipherText: string,
      iv: string,
      authTag: string,
      plaintext: string,
      replyTo: number,
    ) => {
      const replyMessage = messagesRef.current.find((m) => m.id === replyTo);
      if (!replyMessage) {
        console.error(
          "[useConversationMessages] Reply message not found for id:",
          replyTo,
        );
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const optimistic: Message = {
        id: null,
        clientMessageId,
        chatId,
        cipherText,
        iv,
        authTag,
        sentAt: Date.now(),
        senderId: server.id,
        isOwn: true,
        pending: true,
        plaintext,
        modified: false,
        pinned: false,
        isReply: true,
        replyInfo: {
          id: replyTo,
          cipher_text: replyMessage.cipherText,
          iv: replyMessage.iv,
          auth_tag: replyMessage.authTag,
          has_attachment: !!replyMessage.attachmentId,
        },
      };
      setMessages((prev) => [...prev, optimistic]);

      const previewContent =
        plaintext.length <= 100 ? plaintext : plaintext.slice(0, 100) + "...";
      const encryptedPreview = encrypt(
        sharedSecretRef.current!,
        previewContent,
      );

      wsSend(WS_MSG.MESSAGE, {
        chat_id: chatId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
        client_message_id: clientMessageId,
        short_cipher_text: encryptedPreview.ciphertext,
        short_iv: encryptedPreview.iv,
        short_auth_tag: encryptedPreview.authTag,
        reply_to: replyTo,
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

  // ── Edit message ───────────────────────────────────────────────────────────

  const editMessage = useCallback(
    async (
      messageId: number,
      cipherText: string,
      iv: string,
      authTag: string,
      plaintext: string,
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, cipherText, iv, authTag, plaintext, modified: true }
            : m,
        ),
      );
      wsSend(WS_MSG.MESSAGE_MODIFY, {
        id: messageId,
        cipher_text: cipherText,
        iv,
        auth_tag: authTag,
      });
    },
    [wsSend],
  );

  // ── Toggle pin ─────────────────────────────────────────────────────────────

  const togglePinMessage = useCallback(
    (messageId: number) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, pinned: !m.pinned } : m)),
      );
      wsSend(WS_MSG.MESSAGE_PIN, { id: messageId });
    },
    [wsSend],
  );

  // ── Upload & send file attachment ──────────────────────────────────────────

  const uploadAndSend = useCallback(
    async (file: File, plaintext: string) => {
      const clientMessageId = crypto.randomUUID();

      setMessages((prev) => [
        ...prev,
        {
          id: null,
          clientMessageId,
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
          modified: false,
          pinned: false,
          isReply: false,
          replyInfo: undefined,
        },
      ]);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const fileBytes = new Uint8Array(arrayBuffer);

        const ownPrivateKey = await vault.get("encPrivateKey");
        if (!ownPrivateKey) throw new Error("No private key in vault");
        const encryptedBytes = encryptFile(
          fileBytes,
          identityKey,
          ownPrivateKey,
        );

        const metadataJson = JSON.stringify({
          name: file.name,
          size: file.size,
          mimeType: file.type,
        });
        const secret = sharedSecretRef.current;
        if (!secret) throw new Error("No shared secret available");
        const encryptedMetadata = encrypt(secret, metadataJson);

        const textToEncrypt = plaintext.trim() || "\u200b";
        const encryptedText = encrypt(secret, textToEncrypt);

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
            setMessages((prev) =>
              prev.map((m) =>
                m.clientMessageId === clientMessageId
                  ? { ...m, uploadProgress: pct }
                  : m,
              ),
            );
          },
        );

        setMessages((prev) =>
          prev.map((m) =>
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
                  modified: false,
                  pinned: false,
                }
              : m,
          ),
        );

        wsSend(WS_MSG.MESSAGE, {
          chat_id: chatId,
          cipher_text: encryptedText.ciphertext,
          iv: encryptedText.iv,
          auth_tag: encryptedText.authTag,
          client_message_id: clientMessageId,
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
        console.error("[useConversationMessages] uploadAndSend failed:", err);
        setMessages((prev) =>
          prev.filter((m) => m.clientMessageId !== clientMessageId),
        );
      }
    },
    [chatId, server, identityKey, wsSend, updateLastMessage, vault],
  );

  return {
    sendMessage,
    sendReplyMessage,
    editMessage,
    togglePinMessage,
    uploadAndSend,
  };
}
