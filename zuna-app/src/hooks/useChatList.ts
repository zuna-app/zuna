import { useQuery } from "@tanstack/react-query";
import { useAuthorizedServerFetch } from "@/hooks/useServerFetch";
import { ChatMember, Server } from "@/types/serverTypes";

export function useChatList(server: Server) {
  const { authorizedFetch } = useAuthorizedServerFetch(server);

  return useQuery<ChatMember[]>({
    queryKey: ["chats", server.id],
    queryFn: async () => {
      const res = await authorizedFetch(`/api/chat/list`);
      const data: ChatMember[] = await res.json();
      return data ?? [];
    },
  });
}
