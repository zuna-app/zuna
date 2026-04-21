import { useMemo } from "react";
import { ChatMember, Server } from "@/types/serverTypes";
import { DelayedSpinner } from "../ui/delayed-spinner";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { groupMessages, messageKey } from "./messages/types";
import { MessageBubble } from "./messages/message-bubble";
import { MessageDivider } from "./messages/message-divider";
import { useMessageDecryption } from "./messages/use-decryption";
import { useScrollBehavior } from "./messages/use-scroll";
import type { Message } from "@/types/serverTypes";

interface ChatMessagesProps {
  server: Server;
  member: ChatMember;
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  sharedSecret: string | null;
  sevenTvEnabled?: boolean;
  sevenTvEmotesSet?: string | null;
}

export function ChatMessages({
  server,
  member,
  messages,
  loading,
  hasMore,
  fetchMore,
  sharedSecret,
  sevenTvEnabled,
  sevenTvEmotesSet,
}: ChatMessagesProps) {
  const { getRawText, getAttachmentMeta } = useMessageDecryption(
    messages,
    sharedSecret,
    member.id,
  );
  const { scrollRef, contentRef, topSentinelRef, scrollToBottomIfPinned } =
    useScrollBehavior(messages, member.id, hasMore, loading, fetchMore);
  const { emoteMap } = useEmotes(sevenTvEmotesSet, sevenTvEnabled);

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]"
    >
      <div ref={contentRef} className="px-4 py-4 space-y-0.5">
        <div ref={topSentinelRef} />

        {loading && (
          <div className="flex justify-center py-4">
            <DelayedSpinner />
          </div>
        )}

        {messages.length > 0 && (
          <div className="flex items-center gap-3 py-3">
            <div className="flex-1 h-px bg-border/40" />
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
              {new Date(messages[0].sentAt).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
              })}
            </span>
            <div className="flex-1 h-px bg-border/40" />
          </div>
        )}

        {grouped.map((msg) => (
          <div key={messageKey(msg)}>
            {msg.showDivider && <MessageDivider sentAt={msg.sentAt} />}
            <MessageBubble
              msg={msg}
              server={server}
              senderIdentityKey={member.identityKey}
              rawText={getRawText(msg)}
              attachmentMeta={getAttachmentMeta(msg)}
              emoteMap={emoteMap}
              onLoad={scrollToBottomIfPinned}
            />
          </div>
        ))}

        <div className="pt-1" />
      </div>
    </div>
  );
}
