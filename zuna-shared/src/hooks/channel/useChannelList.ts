import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useAuthorizedServerFetch } from "../server/useServerFetch";
import {
  channelsAtom,
  channelUnreadAtom,
  voiceChannelParticipantsAtom,
  jotaiStore,
} from "../../store/atoms";
import type {
  Channel,
  Server,
  VoiceParticipant,
} from "../../types/serverTypes";

function rawToChannel(m: Record<string, unknown>): Channel {
  const lastRaw = m.last_message as Record<string, unknown> | undefined;
  return {
    id: m.id as string,
    name: m.name as string,
    isPublic: (m.is_public as boolean) ?? false,
    channelType: ((m.channel_type as string) === "voice" ? "voice" : "text") as
      | "text"
      | "voice",
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
  const setVoiceParticipants = useSetAtom(voiceChannelParticipantsAtom, {
    store: jotaiStore,
  });

  const query = useQuery<Channel[]>({
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
      setVoiceParticipants((prev) => {
        const next = new Map(prev);
        for (const m of raw) {
          if ((m.channel_type as string) !== "voice") continue;
          const rawParticipants =
            (m.voice_participants as Array<{
              user_id: string;
              username: string;
              avatar: string;
            }>) ?? [];
          next.set(
            m.id as string,
            rawParticipants.map(
              (p): VoiceParticipant => ({
                userId: p.user_id,
                username: p.username,
                avatar: p.avatar,
              }),
            ),
          );
        }
        return next;
      });
      return channels;
    },
    staleTime: 30_000,
  });

  // Sync atoms from cached data too - queryFn only runs on cache misses
  useEffect(() => {
    if (!query.data) return;
    setChannels(query.data);
    setChannelUnread((prev) => {
      const next = new Map(prev);
      for (const ch of query.data!) {
        next.set(ch.id, ch.unreadMessages ?? 0);
      }
      return next;
    });
  }, [query.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return query;
}
