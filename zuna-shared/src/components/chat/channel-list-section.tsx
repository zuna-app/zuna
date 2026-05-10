import { useState } from "react";
import { useAtomValue } from "jotai";
import { Hash, Plus, Loader2, Volume2, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  channelsAtom,
  channelUnreadAtom,
  voiceChannelParticipantsAtom,
  activeVoiceChannelAtom,
  voiceSpeakingAtom,
  voiceMutedParticipantsAtom,
  jotaiStore,
} from "@/store/atoms";
import { Button } from "@/components/ui/button";
import { CreateChannelModal } from "./create-channel-modal";
import { useChannelUnreadTracker } from "@/hooks/channel/useChannelUnreadTracker";
import type { Channel, Server, VoiceParticipant } from "@/types/serverTypes";

interface ChannelListSectionProps {
  server: Server;
  selectedChannel: Channel | null;
  onSelect: (channel: Channel) => void;
  onVoiceJoin: (channel: Channel) => void;
  isLoading?: boolean;
}

export function ChannelListSection({
  server,
  selectedChannel,
  onSelect,
  onVoiceJoin,
  isLoading,
}: ChannelListSectionProps) {
  const channels = useAtomValue(channelsAtom, { store: jotaiStore });
  const channelUnread = useAtomValue(channelUnreadAtom, { store: jotaiStore });
  const voiceParticipants = useAtomValue(voiceChannelParticipantsAtom, {
    store: jotaiStore,
  });
  const activeVoiceChannelId = useAtomValue(activeVoiceChannelAtom, {
    store: jotaiStore,
  });
  const speaking = useAtomValue(voiceSpeakingAtom, { store: jotaiStore });
  const mutedParticipants = useAtomValue(voiceMutedParticipantsAtom, { store: jotaiStore });
  const [createOpen, setCreateOpen] = useState(false);
  useChannelUnreadTracker(server, selectedChannel?.id ?? null);

  const textChannels = channels.filter((c) => c.channelType !== "voice");
  const voiceChannels = channels.filter((c) => c.channelType === "voice");

  return (
    <div className="flex flex-col">
      {/* Text Channels */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Text Channels
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setCreateOpen(true)}
          aria-label="Create channel"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="flex flex-col gap-px px-2">
        {isLoading ? (
          <div className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            <span className="text-xs">Loading…</span>
          </div>
        ) : textChannels.length === 0 ? (
          <p className="px-3 py-1.5 text-xs text-muted-foreground/60">
            No text channels yet
          </p>
        ) : (
          textChannels.map((ch) => (
            <TextChannelItem
              key={ch.id}
              channel={ch}
              isSelected={selectedChannel?.id === ch.id}
              unread={channelUnread.get(ch.id) ?? 0}
              onClick={() => onSelect(ch)}
            />
          ))
        )}
      </div>

      {/* Voice Channels */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Voice Channels
        </span>
      </div>

      <div className="flex flex-col gap-px px-2">
        {!isLoading && voiceChannels.length === 0 && (
          <p className="px-3 py-1.5 text-xs text-muted-foreground/60">
            No voice channels yet
          </p>
        )}
        {voiceChannels.map((ch) => (
          <VoiceChannelItem
            key={ch.id}
            channel={ch}
            isActive={activeVoiceChannelId?.id === ch.id}
            participants={voiceParticipants.get(ch.id) ?? []}
            speaking={speaking}
            mutedParticipants={mutedParticipants}
            onClick={() => onVoiceJoin(ch)}
          />
        ))}
      </div>

      <CreateChannelModal
        server={server}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(ch) => {
          if (ch.channelType === "voice") {
            onVoiceJoin(ch);
          } else {
            onSelect(ch);
          }
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function TextChannelItem({
  channel,
  isSelected,
  unread,
  onClick,
}: {
  channel: Channel;
  isSelected: boolean;
  unread: number;
  onClick: () => void;
}) {
  const hasUnread = unread > 0 && !isSelected;
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors focus:outline-none",
        isSelected
          ? "bg-accent text-accent-foreground font-medium"
          : hasUnread
            ? "text-foreground hover:bg-muted/60"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Hash className="size-3.5 shrink-0" />
      <span className={cn("truncate flex-1", hasUnread && "font-semibold")}>
        {channel.name}
      </span>
      {hasUnread && (
        <span className="size-4 rounded-full bg-primary flex items-center justify-center shrink-0">
          <span className="text-[9px] font-bold text-primary-foreground leading-none">
            {unread > 99 ? "99+" : unread}
          </span>
        </span>
      )}
    </button>
  );
}

function VoiceChannelItem({
  channel,
  isActive,
  participants,
  speaking,
  mutedParticipants,
  onClick,
}: {
  channel: Channel;
  isActive: boolean;
  participants: VoiceParticipant[];
  speaking: Set<string>;
  mutedParticipants: Set<string>;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors focus:outline-none",
          isActive
            ? "bg-accent text-accent-foreground font-medium"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <Volume2 className="size-3.5 shrink-0" />
        <span className="truncate flex-1">{channel.name}</span>
        {participants.length > 0 && (
          <span className="text-xs text-muted-foreground shrink-0">
            {participants.length}
          </span>
        )}
      </button>
      {participants.length > 0 && (
        <div className="flex flex-col pl-6 pb-0.5">
          {participants.map((p) => (
            <div key={p.userId} className="flex items-center gap-2 px-2 py-1">
              <div className={cn(
                "rounded-full shrink-0 p-0.5 transition-colors",
                speaking.has(p.userId) ? "ring-2 ring-green-500" : "",
              )}>
                {p.avatar ? (
                  <img
                    src={p.avatar}
                    alt={p.username}
                    className="size-5 rounded-full object-cover"
                  />
                ) : (
                  <span className="size-5 rounded-full bg-muted block" />
                )}
              </div>
              <span className="text-xs text-muted-foreground truncate flex-1">
                {p.username}
              </span>
              {mutedParticipants.has(p.userId) && (
                <MicOff className="size-3 text-muted-foreground/60 shrink-0" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
