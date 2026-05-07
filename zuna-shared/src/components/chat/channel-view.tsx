import { useRef, useEffect, useCallback, useState } from "react";
import { useAtomValue } from "jotai";
import {
  Hash,
  Users,
  ArrowLeft,
  Loader2,
  Shield,
  Settings,
} from "lucide-react";
import {
  channelWritingAtom,
  channelMembersAtom,
  serverMetaAtom,
  jotaiStore,
} from "@/store/atoms";
import { useChannelMessages } from "@/hooks/channel/useChannelMessages";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { ChannelMessageItem } from "./channel-message-item";
import { ChannelInput } from "./channel-input";
import { ChannelSettingsModal } from "./channel-settings-modal";
import { Button } from "@/components/ui/button";
import type { Channel, Server } from "@/types/serverTypes";
import { Badge } from "../ui/badge";

interface ChannelViewProps {
  server: Server;
  channel: Channel;
  selfId: string;
  selfUsername: string;
  selfAvatar: string;
  onBack?: () => void;
}

export function ChannelView({
  server,
  channel,
  selfId,
  selfUsername,
  selfAvatar,
  onBack,
}: ChannelViewProps) {
  const {
    messages,
    loading,
    hasMore,
    fetchMore,
    sendChannelMessage,
    sendWriteIndicator,
  } = useChannelMessages(server, channel);

  const writing = useAtomValue(channelWritingAtom, { store: jotaiStore });
  const members = useAtomValue(channelMembersAtom, { store: jotaiStore });
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });
  const channelWriters = writing.get(channel.id);
  const channelMembers = members.get(channel.id) ?? [];
  const sevenTvEnabled = serverMeta.get(server.id)?.sevenTvEnabled ?? true;
  const sevenTvEmotesSet = serverMeta.get(server.id)?.sevenTvEmotesSet ?? null;
  const { emoteMap, emoteDataMap } = useEmotes(
    sevenTvEmotesSet,
    sevenTvEnabled,
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;

    if (el.scrollTop < 200 && hasMore && !loading) {
      const prevHeight = el.scrollHeight;
      fetchMore().then(() => {
        el.scrollTop = el.scrollHeight - prevHeight;
      });
    }
  }, [hasMore, loading, fetchMore]);

  const handleSend = useCallback(
    (text: string) => {
      sendChannelMessage(text);
    },
    [sendChannelMessage],
  );

  const handleWrite = useCallback(
    (writing: boolean) => {
      sendWriteIndicator(writing);
    },
    [sendWriteIndicator],
  );

  const writingText = buildTypingText(channelWriters);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border/50 shrink-0 bg-background/60">
        {onBack && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground -ml-1 mr-0.5"
          >
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <div className="flex items-center gap-1.5 min-w-0">
          <Hash className="size-4 text-muted-foreground/70 shrink-0" />
          <span className="font-semibold text-sm truncate">{channel.name}</span>
        </div>
        <Badge
          variant="outline"
          className="text-muted-foreground/70 border-muted-foreground/30"
        >
          {channel.isPublic ? "Public" : "Restricted"}
        </Badge>
        <Badge variant="secondary">
          <Shield />
          Encrypted
        </Badge>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
            <Users className="size-3.5" />
            <span>{channelMembers.length}</span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSettingsOpen(true)}
            className="text-muted-foreground hover:text-foreground"
            title="Channel settings"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </div>

      <ChannelSettingsModal
        server={server}
        channel={channel}
        members={channelMembers}
        selfId={selfId}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      {/* Messages area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]"
      >
        {loading && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <div className="size-14 rounded-2xl bg-muted flex items-center justify-center">
              <Hash className="size-7 text-muted-foreground/50" />
            </div>
            <div>
              <p className="text-sm font-semibold">
                Welcome to #{channel.name}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                This is the start of the channel. Say hello!
              </p>
            </div>
          </div>
        )}

        {messages.length > 0 && (
          <>
            {/* Top of history */}
            {!hasMore && (
              <div className="px-4 pt-4 pb-4 flex flex-col gap-1">
                <p className="text-base font-bold">#{channel.name}</p>
                <p className="text-xs text-muted-foreground">
                  This is the beginning of the #{channel.name} channel.
                </p>
              </div>
            )}

            {hasMore && (
              <div className="flex justify-center py-3">
                {loading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <button
                    onClick={() => fetchMore()}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1 rounded-md hover:bg-muted/60"
                  >
                    Load earlier messages
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-col pb-2">
              {messages.map((msg, i) => (
                <ChannelMessageItem
                  key={msg.clientMessageId || msg.id}
                  message={msg}
                  prevMessage={i > 0 ? messages[i - 1] : null}
                  selfId={selfId}
                  selfUsername={selfUsername}
                  selfAvatar={selfAvatar}
                  emoteMap={emoteMap}
                  emoteDataMap={emoteDataMap}
                />
              ))}
            </div>
          </>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Typing indicator */}
      <div className="px-4 h-5 shrink-0 flex items-center">
        {writingText && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">{writingText}</span>
          </p>
        )}
      </div>

      {/* Input */}
      <ChannelInput
        channelName={channel.name}
        onSend={handleSend}
        onWrite={handleWrite}
        sevenTvEnabled={sevenTvEnabled}
        sevenTvEmotesSet={sevenTvEmotesSet}
      />
    </div>
  );
}

function buildTypingText(
  writers: Map<string, { username: string }> | undefined,
): string {
  if (!writers || writers.size === 0) return "";
  const names = Array.from(writers.values()).map((w) => w.username);
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more are typing…`;
}
