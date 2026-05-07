import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWsHandler } from "../ws/useWsHandler";
import { WS_MSG } from "../ws/wsTypes";
import { unwrapChannelKey, wrapChannelKey } from "../../crypto/channel";
import { usePlatform } from "../../platform/PlatformContext";
import type { Server } from "../../types/serverTypes";
import type {
  GroupKeyPayload,
  ChannelKeyRequest,
} from "../../types/serverTypes";
import type { ChannelKeyRequestsPayload } from "../ws/wsTypes";
import { useWsConnection } from "../ws/useWsConnection";

export function useChannelKeyManager(server: Server) {
  const platform = usePlatform();
  const { sendMessage } = useWsConnection(server);
  const queryClient = useQueryClient();

  const handleKeyReceive = useCallback(
    async (payload: GroupKeyPayload) => {
      try {
        const ownPrivateKey = (await platform.vault.get("encPrivateKey")) as
          | string
          | null;
        if (!ownPrivateKey) return;

        const channelKey = unwrapChannelKey(
          ownPrivateKey,
          payload.sender_identity_key,
          {
            ciphertext: payload.encrypted_key,
            iv: payload.iv,
            authTag: payload.auth_tag,
          },
        );

        await platform.vault.set(
          `channel_key_${payload.channel_id}`,
          channelKey,
        );
        queryClient.invalidateQueries({ queryKey: ["channels", server.id] });
      } catch (err) {
        console.error("[channel] failed to unwrap channel key", err);
      }
    },
    [platform.vault, queryClient, server.id],
  );

  const handleKeyRequests = useCallback(
    async (payload: ChannelKeyRequestsPayload) => {
      if (!payload?.requests?.length) return;

      const ownPrivateKey = (await platform.vault.get("encPrivateKey")) as
        | string
        | null;
      if (!ownPrivateKey) return;

      const keysToProvide: Array<{
        channel_id: string;
        recipient_user_id: string;
        encrypted_key: string;
        iv: string;
        auth_tag: string;
      }> = [];

      for (const req of payload.requests) {
        const channelKey = (await platform.vault.get(
          `channel_key_${req.channel_id}`,
        )) as string | null;
        if (!channelKey) continue;

        try {
          const wrapped = wrapChannelKey(
            ownPrivateKey,
            req.recipient_identity_key,
            channelKey,
          );
          keysToProvide.push({
            channel_id: req.channel_id,
            recipient_user_id: req.recipient_user_id,
            encrypted_key: wrapped.ciphertext,
            iv: wrapped.iv,
            auth_tag: wrapped.authTag,
          });
        } catch (err) {
          console.error(
            "[channel] failed to wrap channel key for redistribution",
            err,
          );
        }
      }

      if (keysToProvide.length > 0) {
        sendMessage(WS_MSG.CHANNEL_KEY_PROVIDE, { keys: keysToProvide });
      }
    },
    [platform.vault, sendMessage],
  );

  useWsHandler<GroupKeyPayload>(
    server,
    WS_MSG.CHANNEL_KEY_RECEIVE,
    handleKeyReceive,
  );
  useWsHandler<ChannelKeyRequestsPayload>(
    server,
    WS_MSG.CHANNEL_KEY_REQUESTS,
    handleKeyRequests,
  );
}
