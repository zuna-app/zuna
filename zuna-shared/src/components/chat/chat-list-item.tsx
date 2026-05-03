import { ChatMember, Server } from "@/types/serverTypes";
import { cn } from "@/lib/utils";
import { usePresence } from "@/hooks/ws/usePresence";
import { useLastChatMessages } from "@/hooks/chat/useLastChatMessages";
import { convertTimeToRelative } from "@/utils/basicUtils";
import { ZunaAvatar } from "../avatar";

interface ChatListItemProps {
  lastMessage:
    | ReturnType<typeof useLastChatMessages>["lastMessages"][string]
    | null;
  member: ChatMember;
  isSelected: boolean;
  onClick: () => void;
}

export function ChatListItem({
  lastMessage,
  member,
  isSelected,
  onClick,
}: ChatListItemProps) {
  const { getMemberPresence } = usePresence();
  const presence = getMemberPresence(member.id);
  const unreadCount = lastMessage?.unreadMessages ?? 0;

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        isSelected
          ? "bg-primary/10 dark:bg-primary/15"
          : "hover:bg-muted/60 dark:hover:bg-muted/30",
      )}
    >
      <div className="relative shrink-0">
        <ZunaAvatar
          username={member.username}
          src={member.avatar}
          isOnline={presence?.active ?? false}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "text-sm truncate",
              lastMessage?.unreadMessages ? "font-semibold" : "font-medium",
            )}
          >
            {member.username}
          </span>
          <span
            className={cn(
              "text-[10px] shrink-0 tabular-nums",
              lastMessage?.unreadMessages
                ? "text-primary font-semibold"
                : "text-muted-foreground",
            )}
          >
            {lastMessage && lastMessage.lastActivityAt > 0
              ? convertTimeToRelative(lastMessage.lastActivityAt)
              : ""}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p
            className={cn(
              "text-xs truncate",
              lastMessage?.unreadMessages
                ? "text-foreground/80 font-medium"
                : "text-muted-foreground",
            )}
          >
            {lastMessage ? lastMessage.content : "No messages yet"}
          </p>
          {unreadCount > 0 && (
            <span className="size-4 shrink-0 rounded-full bg-primary flex items-center justify-center">
              <span className="text-[9px] font-bold text-primary-foreground leading-none">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
