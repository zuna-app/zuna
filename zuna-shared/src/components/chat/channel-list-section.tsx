import { useState } from "react";
import { useAtomValue } from "jotai";
import { Hash, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { channelsAtom, channelUnreadAtom, jotaiStore } from "@/store/atoms";
import { Button } from "@/components/ui/button";
import { CreateChannelModal } from "./create-channel-modal";
import type { Channel, Server } from "@/types/serverTypes";

interface ChannelListSectionProps {
  server: Server;
  selectedChannel: Channel | null;
  onSelect: (channel: Channel) => void;
  isLoading?: boolean;
}

export function ChannelListSection({
  server,
  selectedChannel,
  onSelect,
  isLoading,
}: ChannelListSectionProps) {
  const channels = useAtomValue(channelsAtom, { store: jotaiStore });
  const channelUnread = useAtomValue(channelUnreadAtom, { store: jotaiStore });
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Channels
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
        ) : channels.length === 0 ? (
          <p className="px-3 py-1.5 text-xs text-muted-foreground/60">
            No channels yet
          </p>
        ) : (
          channels.map((ch) => (
            <ChannelItem
              key={ch.id}
              channel={ch}
              isSelected={selectedChannel?.id === ch.id}
              unread={channelUnread.get(ch.id) ?? 0}
              onClick={() => onSelect(ch)}
            />
          ))
        )}
      </div>

      <CreateChannelModal
        server={server}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(ch) => {
          onSelect(ch);
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function ChannelItem({
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
