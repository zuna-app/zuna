import { ChatMember } from "@/types/serverTypes";
import { PseudoAvatar } from "@/components/ui/pseudo-avatar";
import { cn } from "@/lib/utils";

const PREVIEW_MESSAGES = [
  "Hey, how's it going?",
  "Did you see the latest updates?",
  "Let's catch up soon!",
  "Sounds good to me 👍",
  "I'll check and get back to you",
  "Just sent you the files!",
  "Are you free this afternoon?",
  "Thanks, that was really helpful!",
];

const TIMES = ["just now", "2m", "15m", "1h", "3h", "Yesterday", "Mon"];

function deriveIndex(str: string, length: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return ((Math.abs(hash) % length) + length) % length;
}

interface ChatListItemProps {
  member: ChatMember;
  isSelected: boolean;
  onClick: () => void;
}

export function ChatListItem({
  member,
  isSelected,
  onClick,
}: ChatListItemProps) {
  const preview =
    PREVIEW_MESSAGES[deriveIndex(member.id, PREVIEW_MESSAGES.length)];
  const time = TIMES[deriveIndex(member.username, TIMES.length)];
  const isUnread = deriveIndex(member.id + "unread", 3) === 0;

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
        <PseudoAvatar name={member.username} size={42} />
        <span className="absolute bottom-0.5 right-0.5 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "text-sm truncate",
              isUnread ? "font-semibold" : "font-medium",
            )}
          >
            {member.username}
          </span>
          <span
            className={cn(
              "text-[10px] shrink-0 tabular-nums",
              isUnread ? "text-primary font-semibold" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p
            className={cn(
              "text-xs truncate",
              isUnread
                ? "text-foreground/80 font-medium"
                : "text-muted-foreground",
            )}
          >
            {preview}
          </p>
          {isUnread && (
            <span className="size-4 shrink-0 rounded-full bg-primary flex items-center justify-center">
              <span className="text-[9px] font-bold text-primary-foreground leading-none">
                {deriveIndex(member.id + "count", 5) + 1}
              </span>
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
