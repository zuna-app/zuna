import { useAtomValue, useSetAtom } from "jotai";
import {
  jotaiStore,
  selectedChatAtom,
  lastMessagesAtom,
} from "../../store/atoms";
import { decrypt } from "../../crypto/x25519";
import { useChatList } from "../chat/useChatList";
import { useSharedSecrets } from "./useSharedSecret";
import { useWsHandler } from "./useWsHandler";
import { WS_MSG, type MessageReceivePayload } from "./wsTypes";
import type { Server } from "../../types/serverTypes";

/**
 * Handles incoming messages for chats that are NOT currently open.
 * Updates unread counts and last-message previews in the background.
 * Must be mounted for the duration of a server session.
 */
export function useBackgroundMessages(server: Server) {
  const { data: members } = useChatList(server);
  const sharedSecrets = useSharedSecrets(members ?? null);
  const setLastMessages = useSetAtom(lastMessagesAtom, { store: jotaiStore });

  useWsHandler<MessageReceivePayload>(
    server,
    WS_MSG.MESSAGE_RECEIVE,
    (payload) => {
      const {
        chat_id,
        created_at,
        sender_id,
        cipher_text,
        iv,
        auth_tag,
        attachment_id,
      } = payload;

      if (jotaiStore.get(selectedChatAtom)?.chatId === chat_id) return;

      const secret = sharedSecrets?.[sender_id];
      if (!secret) return;

      try {
        const plaintext = decrypt(secret, {
          ciphertext: cipher_text,
          iv,
          authTag: auth_tag,
        });
        setLastMessages((prev) => ({
          ...prev,
          [chat_id]: {
            chatId: chat_id,
            senderId: sender_id,
            content: attachment_id ? "\uD83D\uDCCE Attachment" : plaintext,
            unreadMessages: prev[chat_id]
              ? prev[chat_id].unreadMessages + 1
              : 1,
            lastActivityAt: created_at,
          },
        }));
      } catch (err) {
        console.error("[ws] Failed to decrypt background message:", err);
      }
    },
  );
}
