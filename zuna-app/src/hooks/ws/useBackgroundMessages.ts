import { Server } from "@/types/serverTypes";
import { useChatList } from "@/hooks/chat/useChatList";
import { useSharedSecrets } from "@/hooks/ws/useSharedSecret";
import {
  useLastMessagesUpdater,
  lastMessagesAtom,
} from "@/hooks/chat/useLastChatMessages";
import { selectedChatAtom } from "@/hooks/chat/useSelectedChat";
import { jotaiStore } from "@/hooks/auth/useAuthorizer";
import { useWsHandler } from "./useWsHandler";
import { WS_MSG, MessageReceivePayload } from "./wsTypes";

/**
 * Handles incoming messages for chats that are not currently open.
 * Updates unread counts and last-message previews for background chats.
 * Must be mounted for the duration of a server session (e.g. in AppServer).
 */
export function useBackgroundMessages(server: Server) {
  const { data: members } = useChatList(server);
  const sharedSecrets = useSharedSecrets(members ?? null);
  const { updateLastMessage } = useLastMessagesUpdater();

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
        attachment_metadata,
        attachment_metadata_auth_tag,
        attachment_metadata_iv,
      } = payload;

      if (jotaiStore.get(selectedChatAtom) === chat_id) return;

      const secret = sharedSecrets?.[sender_id];
      if (!secret) return;

      window.security
        .decrypt(secret, { ciphertext: cipher_text, iv, authTag: auth_tag })
        .then((plaintext) => {
          const currentLastMessages = jotaiStore.get(lastMessagesAtom);
          updateLastMessage({
            chatId: chat_id,
            senderId: sender_id,
            content: attachment_id ? "\uD83D\uDCCE Attachment" : plaintext,
            unreadMessages: currentLastMessages[chat_id]
              ? currentLastMessages[chat_id].unreadMessages + 1
              : 1,
            lastActivityAt: created_at,
          });
        })
        .catch((err) => {
          console.error("[ws] Failed to decrypt background message:", err);
        });
    },
  );
}
