import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthorizedServerFetch } from "../server/useServerFetch";
import { useWsHandler } from "../ws/useWsHandler";
import { WS_MSG } from "../ws/wsTypes";
import type { ChatMember, Server } from "../../types/serverTypes";

export function useChatList(server: Server) {
  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const queryClient = useQueryClient();

  useWsHandler(server, WS_MSG.USER_JOINED, () => {
    queryClient.invalidateQueries({ queryKey: ["chats", server.id] });
  });

  return useQuery<ChatMember[]>({
    queryKey: ["chats", server.id],
    queryFn: async () => {
      const res = await authorizedFetch("/api/chat/list");
      const json = await res.json();
      const raw: Array<Record<string, unknown>> = json?.chats ?? json ?? [];
      if (!Array.isArray(raw)) return [];
      return raw.map((m) => ({
        id: m.id as string,
        chatId: m.chat_id as string,
        username: m.username as string,
        avatar: (m.avatar as string) ?? "",
        identityKey: (m.identity_key as string) ?? "",
        senderId: (m.last_message_sender_id as string) ?? "",
        ciphertext: (m.cipher_text as string) ?? "",
        iv: (m.iv as string) ?? "",
        authTag: (m.auth_tag as string) ?? "",
        unreadMessages: (m.unread_messages as number) ?? 0,
        lastActivityAt: (m.last_chat_activity as number) ?? 0,
      }));
    },
    staleTime: 30_000,
  });
}
