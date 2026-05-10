import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useAuthorizedServerFetch } from "../server/useServerFetch";
import { channelsAtom, channelUnreadAtom, jotaiStore } from "../../store/atoms";
import type { Channel, Server } from "../../types/serverTypes";

function rawToChannel(m: Record<string, unknown>): Channel {
  const lastRaw = m.last_message as Record<string, unknown> | undefined;
  return {
    id: m.id as string,
    name: m.name as string,
    isPublic: (m.is_public as boolean) ?? false,
    channelType: ((m.channel_type as string) === "voice" ? "voice" : "text") as "text" | "voice",
    ownerId: (m.owner_id as string) ?? "",
    createdAt: (m.created_at as number) ?? 0,
    unreadMessages: (m.unread_messages as number) ?? 0,
    lastMessage: lastRaw
      ? {
          senderId: (lastRaw.sender_id as string) ?? "",
          cipherText: (lastRaw.cipher_text as string) ?? "",
          iv: (lastRaw.iv as string) ?? "",
          authTag: (lastRaw.auth_tag as string) ?? "",
          sentAt: (lastRaw.sent_at as number) ?? 0,
        }
      : undefined,
  };
}

export function useChannelList(server: Server) {
  const { authorizedFetch, hasToken } = useAuthorizedServerFetch(server);
  const setChannels = useSetAtom(channelsAtom, { store: jotaiStore });
  const setChannelUnread = useSetAtom(channelUnreadAtom, { store: jotaiStore });

  return useQuery<Channel[]>({
    queryKey: ["channels", server.id],
    enabled: hasToken,
    queryFn: async () => {
      const res = await authorizedFetch("/api/channel/list");
      const json = await res.json();
      const raw: Array<Record<string, unknown>> = json?.channels ?? json ?? [];
      if (!Array.isArray(raw)) return [];
      const channels = raw.map(rawToChannel);
      setChannels(channels);
      setChannelUnread((prev) => {
        const next = new Map(prev);
        for (const ch of channels) {
          next.set(ch.id, ch.unreadMessages ?? 0);
        }
        return next;
      });
      return channels;
    },
    staleTime: 30_000,
  });
}
