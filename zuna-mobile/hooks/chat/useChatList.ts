import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuthorizedServerFetch } from '@/hooks/server/useServerFetch';
import { useWsHandler } from '@/hooks/ws/useWsHandler';
import { WS_MSG } from '@/hooks/ws/wsTypes';
import { Server, ChatMember } from '@/types/serverTypes';

interface ChatListResponse {
  chats: Array<{
    id: string;
    chat_id: string;
    username: string;
    avatar: string;
    identity_key: string;
    last_message_sender_id: string;
    cipher_text: string;
    iv: string;
    auth_tag: string;
    unread_messages: number;
    last_chat_activity: number;
  }>;
}

export function useChatList(server: Server) {
  const { authorizedFetch, token } = useAuthorizedServerFetch(server);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['chat-list', server.id],
    queryFn: async (): Promise<ChatMember[]> => {
      const res = await authorizedFetch('/api/chat/list');
      if (!res.ok) throw new Error(`chat/list failed (${res.status})`);
      const json: ChatListResponse = await res.json();
      return (json.chats ?? []).map((u) => ({
        id: u.id,
        chatId: u.chat_id,
        username: u.username,
        avatar: u.avatar,
        identityKey: u.identity_key,
        senderId: u.last_message_sender_id,
        ciphertext: u.cipher_text,
        iv: u.iv,
        authTag: u.auth_tag,
        unreadMessages: u.unread_messages ?? 0,
        lastActivityAt: u.last_chat_activity ?? 0,
      }));
    },
    staleTime: 30_000,
    enabled: !!token,
  });

  useWsHandler(server, WS_MSG.USER_JOINED, () => {
    queryClient.invalidateQueries({ queryKey: ['chat-list', server.id] });
  });

  return query;
}
