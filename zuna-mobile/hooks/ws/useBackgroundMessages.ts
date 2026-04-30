import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { jotaiStore, vaultAtom, lastMessagesAtom, selectedChatAtom } from '@/store/atoms';
import { useWsHandler } from './useWsHandler';
import { WS_MSG, MessageReceivePayload } from './wsTypes';
import { computeSharedSecretFromVault } from './useSharedSecret';
import { decrypt } from '@/lib/crypto/x25519';
import { Server, ChatMember } from '@/types/serverTypes';

export function useBackgroundMessages(server: Server, members: ChatMember[]) {
  const vault = useAtomValue(vaultAtom, { store: jotaiStore });
  const selectedChat = useAtomValue(selectedChatAtom, { store: jotaiStore });
  const setLastMessages = useSetAtom(lastMessagesAtom, { store: jotaiStore });

  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const selectedChatRef = useRef(selectedChat);
  selectedChatRef.current = selectedChat;
  const membersRef = useRef(members);
  membersRef.current = members;

  useWsHandler<MessageReceivePayload>(server, WS_MSG.MESSAGE_RECEIVE, (payload) => {
    // Only handle messages for chats that are NOT currently open
    if (selectedChatRef.current?.chatId === payload.chat_id) return;
    if (!vaultRef.current) return;

    const member = membersRef.current.find((m) => m.chatId === payload.chat_id);
    if (!member) return;

    const secret = computeSharedSecretFromVault(vaultRef.current, member.identityKey);
    if (!secret) return;

    const isAttachment = !!payload.attachment_id;
    if (isAttachment) {
      setLastMessages((prev) => ({
        ...prev,
        [payload.chat_id]: {
          chatId: payload.chat_id,
          senderId: payload.sender_id,
          content: '📎 Attachment',
          unreadMessages: (prev[payload.chat_id]?.unreadMessages ?? 0) + 1,
          lastActivityAt: payload.created_at,
        },
      }));
      return;
    }

    try {
      const plaintext = decrypt(secret, {
        ciphertext: payload.cipher_text,
        iv: payload.iv,
        authTag: payload.auth_tag,
      });
      setLastMessages((prev) => ({
        ...prev,
        [payload.chat_id]: {
          chatId: payload.chat_id,
          senderId: payload.sender_id,
          content: plaintext,
          unreadMessages: (prev[payload.chat_id]?.unreadMessages ?? 0) + 1,
          lastActivityAt: payload.created_at,
        },
      }));
    } catch {}
  });
}