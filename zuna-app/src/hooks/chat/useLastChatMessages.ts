import { atom, useAtom, useAtomValue } from "jotai";
import { jotaiStore } from "../auth/useAuthorizer";
import { ChatMember, LastMessage, Server } from "@/types/serverTypes";
import { useEffect } from "react";
import { useSharedSecrets } from "../ws/useSharedSecret";

export const lastMessagesAtom = atom<Record<string, LastMessage>>({});

export const useLastMessagesUpdater = () => {
  const [lastMessages, setLastMessages] = useAtom(lastMessagesAtom, {
    store: jotaiStore,
  });

  return {
    lastMessages,
    updateLastMessage: (message: LastMessage) => {
      setLastMessages((prev) => ({
        ...prev,
        [message.chatId]: message,
      }));
    },
  };
};

export const useLastChatMessages = (server: Server, members: ChatMember[]) => {
  const [lastMessages, setLastMessages] = useAtom(lastMessagesAtom);
  const sharedSecrets = useSharedSecrets(members);

  useEffect(() => {
    members.forEach(async (m) => {
      const secret = sharedSecrets ? sharedSecrets[m.id] : null;
      if (!secret) {
        return;
      }

      try {
        let content = m.ciphertext
          ? await window.security.decrypt(secret, {
              ciphertext: m.ciphertext,
              iv: m.iv,
              authTag: m.authTag,
            })
          : "No messages yet";
        // Zero-width space is the placeholder for attachment-only messages
        if (content === "\u200b") content = "\uD83D\uDCCE Attachment";

        setLastMessages((prev) => {
          if (prev[m.chatId]) return prev;

          return {
            ...prev,
            [m.chatId]: {
              chatId: m.chatId,
              senderId: m.senderId,
              content: content,
              unreadMessages: m.unreadMessages,
              lastActivityAt: m.lastActivityAt,
            },
          };
        });
      } catch (e) {
        console.error("Failed to decrypt message for chat " + m.chatId, e);
      }
    });
  }, [members, sharedSecrets]);

  return {
    lastMessages,
  };
};
