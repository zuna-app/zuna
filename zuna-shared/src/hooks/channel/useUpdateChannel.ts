import { useState, useCallback } from "react";
import { useSetAtom } from "jotai";
import {
  channelsAtom,
  channelMembersAtom,
  jotaiStore,
} from "../../store/atoms";
import { useAuthorizedServerFetch } from "../server/useServerFetch";
import { wrapChannelKey } from "../../crypto/channel";
import { usePlatform } from "../../platform/PlatformContext";
import type { Channel, ChannelMember, Server } from "../../types/serverTypes";
import { useQueryClient } from "@tanstack/react-query";

export function useUpdateChannel(server: Server) {
  const platform = usePlatform();
  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const setChannels = useSetAtom(channelsAtom, { store: jotaiStore });
  const setChannelMembers = useSetAtom(channelMembersAtom, {
    store: jotaiStore,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const renameChannel = useCallback(
    async (channelId: string, name: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await authorizedFetch("/api/channel/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel_id: channelId, name }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j?.error ?? "Failed to rename channel");
        }
        queryClient.invalidateQueries({ queryKey: ["channels", server.id] });
        return true;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to rename channel",
        );
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [authorizedFetch, setChannels],
  );

  const addMember = useCallback(
    async (
      channelId: string,
      newMembers: Array<{ id: string; identity_key: string }>,
    ): Promise<boolean> => {
      setIsLoading(true);
      setError(null);
      try {
        const ownPrivateKey = (await platform.vault.get("encPrivateKey")) as
          | string
          | null;
        if (!ownPrivateKey) throw new Error("Private key not found in vault");
        const channelKey = (await platform.vault.get(
          `channel_key_${channelId}`,
        )) as string | null;
        if (!channelKey) throw new Error("Channel key not found in vault");

        const encryptedKeys = newMembers.map((m) => {
          const wrapped = wrapChannelKey(
            ownPrivateKey,
            m.identity_key,
            channelKey,
          );
          return {
            user_id: m.id,
            encrypted_key: wrapped.ciphertext,
            iv: wrapped.iv,
            auth_tag: wrapped.authTag,
          };
        });

        const res = await authorizedFetch("/api/channel/members/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel_id: channelId,
            encrypted_keys: encryptedKeys,
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j?.error ?? "Failed to add member");
        }
        const json = await res.json();
        const addedDTOs: Array<{
          user_id: string;
          username: string;
          avatar: string;
          identity_key: string;
        }> = json?.added ?? [];
        const added: ChannelMember[] = addedDTOs.map((m) => ({
          userId: m.user_id,
          username: m.username,
          avatar: m.avatar,
          identityKey: m.identity_key,
        }));

        setChannelMembers((prev) => {
          const next = new Map(prev);
          const existing = next.get(channelId) ?? [];
          const existingIds = new Set(existing.map((m) => m.userId));
          next.set(channelId, [
            ...existing,
            ...added.filter((m) => !existingIds.has(m.userId)),
          ]);
          return next;
        });
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add member");
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [platform.vault, authorizedFetch, setChannelMembers],
  );

  const removeMember = useCallback(
    async (channelId: string, userId: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await authorizedFetch("/api/channel/members/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel_id: channelId, user_id: userId }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j?.error ?? "Failed to remove member");
        }
        setChannelMembers((prev) => {
          const next = new Map(prev);
          const existing = next.get(channelId) ?? [];
          next.set(
            channelId,
            existing.filter((m) => m.userId !== userId),
          );
          return next;
        });
        return true;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to remove member",
        );
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [authorizedFetch, setChannelMembers],
  );

  return { renameChannel, addMember, removeMember, isLoading, error };
}
