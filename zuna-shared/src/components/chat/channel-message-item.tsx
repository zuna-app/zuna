import { memo } from "react";
import { cn } from "@/lib/utils";
import { getFirstLetters } from "@/utils/basicUtils";
import type { ChannelMessage, Server } from "@/types/serverTypes";
import type { EmoteDataMap } from "@/hooks/ui/useEmotes";
import { renderMessage } from "./messages/render-message";
import { usePlatform } from "../../platform";
import { ChannelAttachmentCard } from "./messages/channel-attachment-card";

const MESSAGE_GROUPED_THRESHOLD = 5 * 60 * 1000;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  if (isToday) return `Today at ${formatTime(ms)}`;

  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface ChannelMessageItemProps {
  message: ChannelMessage;
  prevMessage: ChannelMessage | null;
  selfId: string;
  selfUsername: string;
  selfAvatar: string;
  server: Server;
  channelKey: string | null;
  attachmentMeta: { name: string; size: number; mimeType: string } | null;
  emoteMap?: ReadonlyMap<string, string>;
  emoteDataMap?: EmoteDataMap;
}

export const ChannelMessageItem = memo(function ChannelMessageItem({
  message,
  prevMessage,
  selfId,
  selfUsername,
  selfAvatar,
  server,
  channelKey,
  attachmentMeta,
  emoteMap,
  emoteDataMap,
}: ChannelMessageItemProps) {
  const { shell } = usePlatform();
  const isSelf = message.senderId === "__self__" || message.senderId === selfId;
  const senderUsername = isSelf ? selfUsername : message.senderUsername;
  const senderAvatar = isSelf ? selfAvatar : message.senderAvatar;

  // Normalize "__self__" to the real selfId so optimistic messages group
  // correctly with already-confirmed messages from the same user.
  const effectiveSender = (msg: ChannelMessage) =>
    msg.senderId === "__self__" ? selfId : msg.senderId;

  const prevIsSelf =
    prevMessage !== null &&
    effectiveSender(prevMessage) === effectiveSender(message);

  const isGrouped =
    prevIsSelf &&
    message.sentAt - prevMessage!.sentAt < MESSAGE_GROUPED_THRESHOLD;

  const hasAttachment = !!message.attachmentId || !!message.attachmentFilename;

  const displayText =
    message.plaintext === "\u200b" ||
    message.plaintext === undefined ||
    message.plaintext === ""
      ? hasAttachment
        ? null
        : "[encrypted]"
      : message.plaintext;

  const renderedContent =
    displayText && emoteMap && emoteDataMap && emoteMap.size > 0
      ? renderMessage(displayText, emoteMap, emoteDataMap, shell)
      : displayText;

  // Compact variant — same sender within MESSAGE_GROUPED_THRESHOLD, no avatar/name repeat
  if (isGrouped) {
    return (
      <div className="group relative flex items-start pl-16 pr-4 py-0.5 hover:bg-muted/30">
        <span className="invisible group-hover:visible absolute left-4 top-0.5 text-[10px] leading-5 text-muted-foreground/40 tabular-nums select-none">
          {formatTime(message.sentAt)}
        </span>
        <div className={cn("min-w-0 w-full", message.pending && "opacity-50")}>
          {hasAttachment && (
            <ChannelAttachmentCard
              server={server}
              message={message}
              channelKey={channelKey}
              meta={attachmentMeta}
            />
          )}
          {renderedContent && (
            <p className="text-sm leading-relaxed wrap-break-word whitespace-pre-wrap min-w-0 w-full">
              {renderedContent}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Full variant — avatar + username + timestamp
  return (
    <div className="group flex items-start gap-3 px-4 pt-2 pb-0.5 hover:bg-muted/30">
      <div className="mt-0.5 shrink-0 size-9 rounded-full bg-muted flex items-center justify-center overflow-hidden ring-1 ring-border/20">
        {senderAvatar ? (
          <img
            src={senderAvatar}
            alt={senderUsername}
            className="size-full object-cover"
          />
        ) : (
          <span className="text-xs font-semibold text-muted-foreground">
            {getFirstLetters(senderUsername || "?")}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-sm font-semibold leading-none">
            {senderUsername || "Unknown"}
          </span>
          <span className="text-[10px] text-muted-foreground/70 tabular-nums">
            {formatDateTime(message.sentAt)}
          </span>
          {message.pending && !hasAttachment && (
            <span className="text-[10px] text-muted-foreground/50 italic">
              sending…
            </span>
          )}
        </div>
        <div className={cn("min-w-0", message.pending && "opacity-50")}>
          {hasAttachment && (
            <ChannelAttachmentCard
              server={server}
              message={message}
              channelKey={channelKey}
              meta={attachmentMeta}
            />
          )}
          {renderedContent && (
            <p className="text-sm leading-relaxed wrap-break-word whitespace-pre-wrap min-w-0">
              {renderedContent}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});
