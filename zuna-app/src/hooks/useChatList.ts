import { useQuery } from "@tanstack/react-query";
import { useAuthorizedServerFetch } from "@/hooks/useServerFetch";
import { ChatMember, Server } from "@/types/serverTypes";

export function useChatList(server: Server) {
  const { authorizedFetch } = useAuthorizedServerFetch(server);

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
        avatarIv: m.avatar_iv ?? "",
        avatarAuthTag: m.avatar_auth_tag ?? "",
        identityKey: m.identity_key ?? "",
      })) as ChatMember[];
    },
  });
}
