import { useState, useCallback } from "react";
import { useSetAtom } from "jotai";
import { channelsAtom, jotaiStore } from "../../store/atoms";
import { useAuthorizedServerFetch } from "../server/useServerFetch";
import { generateChannelKey, wrapChannelKey } from "../../crypto/channel";
import { usePlatform } from "../../platform/PlatformContext";
import type { Channel, ChannelMember, Server } from "../../types/serverTypes";

export interface CreateChannelOptions {
  name: string;
  isPublic: boolean;
  channelType?: "text" | "voice";
  /** For restricted channels — the selected member IDs (not needed for public). */
  memberIds?: string[];
}

export function useCreateChannel(server: Server) {
  const platform = usePlatform();
  const { authorizedFetch } = useAuthorizedServerFetch(server);
  const setChannels = useSetAtom(channelsAtom, { store: jotaiStore });
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createChannel = useCallback(
    async (opts: CreateChannelOptions): Promise<Channel | null> => {
      setIsCreating(true);
      setError(null);

      try {
        const ownPrivateKey = (await platform.vault.get(
          "encPrivateKey",
        )) as string | null;
        if (!ownPrivateKey) throw new Error("Private key not found in vault");

        // Fetch all server users (with identity keys) so we can encrypt for each
        const usersRes = await authorizedFetch("/api/chat/users");
        const usersJson = await usersRes.json();
        const allUsers: Array<{ id: string; identity_key?: string }> =
          usersJson?.users ?? [];

        // For public channels, use all users; for restricted, filter to selected
        const targetUsers = opts.isPublic
          ? allUsers
          : allUsers.filter(
              (u) => opts.memberIds?.includes(u.id) ?? false,
            );

        // Generate a fresh symmetric channel key
        const channelKey = generateChannelKey();

        // Encrypt channel key for every target member
        const encryptedKeys = targetUsers
          .filter((u) => u.identity_key)
          .map((u) => {
            const wrapped = wrapChannelKey(
              ownPrivateKey,
              u.identity_key!,
              channelKey,
            );
            return {
              user_id: u.id,
              encrypted_key: wrapped.ciphertext,
              iv: wrapped.iv,
              auth_tag: wrapped.authTag,
            };
          });

        const res = await authorizedFetch("/api/channel/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: opts.name,
            is_public: opts.isPublic,
            channel_type: opts.channelType ?? "text",
            member_ids: opts.isPublic ? [] : targetUsers.map((u) => u.id),
            encrypted_keys: encryptedKeys,
          }),
        });

        const json = await res.json();

        // Store our own channel key in vault
        await platform.vault.set(`channel_key_${json.id}`, channelKey);

        const channel: Channel = {
          id: json.id,
          name: json.name,
          isPublic: opts.isPublic,
          channelType: (json.channel_type as "text" | "voice") ?? opts.channelType ?? "text",
          ownerId: json.owner_id,
          createdAt: Date.now(),
        };

        setChannels((prev) => [channel, ...prev]);
        return channel;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create channel";
        setError(msg);
        return null;
      } finally {
        setIsCreating(false);
      }
    },
    [platform.vault, authorizedFetch, setChannels],
  );

  return { createChannel, isCreating, error };
}
