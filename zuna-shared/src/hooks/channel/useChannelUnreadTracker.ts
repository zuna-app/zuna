import { useCallback, useEffect } from "react";
import { useSetAtom } from "jotai";
import { channelUnreadAtom, jotaiStore } from "../../store/atoms";
import { useWsHandler } from "../ws/useWsHandler";
import { WS_MSG } from "../ws/wsTypes";
import type { Server } from "../../types/serverTypes";
import type { ChannelMessageReceivePayload } from "../ws/wsTypes";

/**
 * Always-mounted hook that increments channelUnreadAtom for any
 * channel_message_receive that arrives while that channel is not open,
 * and resets the count to 0 when a channel is selected.
 */
export function useChannelUnreadTracker(server: Server, selectedChannelId: string | null) {
  const setChannelUnread = useSetAtom(channelUnreadAtom, { store: jotaiStore });

  useEffect(() => {
    if (!selectedChannelId) return;
    setChannelUnread((prev) => {
      const next = new Map(prev);
      next.set(selectedChannelId, 0);
      return next;
    });
  }, [selectedChannelId, setChannelUnread]);

  useWsHandler<ChannelMessageReceivePayload>(
    server,
    WS_MSG.CHANNEL_MESSAGE_RECEIVE,
    useCallback(
      (payload) => {
        if (payload.channel_id === selectedChannelId) return;
        setChannelUnread((prev) => {
          const next = new Map(prev);
          next.set(payload.channel_id, (prev.get(payload.channel_id) ?? 0) + 1);
          return next;
        });
      },
      [selectedChannelId, setChannelUnread],
    ),
  );
}
