import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthorizedServerFetch } from "@/hooks/server/useServerFetch";
import { useWsHandler } from "@/hooks/ws/useWsHandler";
import { WS_MSG } from "@/hooks/ws/wsTypes";
import { ChatMember, Server } from "@/types/serverTypes";

export function useChatList(server: Server) {
  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const queryClient = useQueryClient();

  useWsHandler(server, WS_MSG.USER_JOINED, () => {
    queryClient.invalidateQueries({ queryKey: ["chats", server.id] });
  });

  return useQuery<ChatMember[]>({
    queryKey: ["chats", server.id],
    queryFn: async () => {
      const res = await authorizedFetch(`/api/chat/list`);
      const json = await res.json();
      const raw: Array<any> = json?.chats ?? json ?? [];
      if (!Array.isArray(raw)) return [];
      return raw.map((m) => ({
        id: m.id,
        chatId: m.chat_id,
        username: m.username,
        avatar: m.avatar ?? "",
        identityKey: m.identity_key ?? "",
        senderId: m.last_message_sender_id ?? "",
        ciphertext: m.cipher_text ?? "",
        iv: m.iv ?? "",
        authTag: m.auth_tag ?? "",
        unreadMessages: m.unread_messages ?? 0,
        lastActivityAt: m.last_chat_activity ?? 0,
      }));
    },
    staleTime: 30_000,
  });
}
