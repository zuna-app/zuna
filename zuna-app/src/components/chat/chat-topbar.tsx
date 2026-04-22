import { ChatMember, Server } from "@/types/serverTypes";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Phone,
  Video,
  Search,
  MoreHorizontal,
  BellOff,
  UserRound,
} from "lucide-react";
import { usePresence } from "@/hooks/ws/usePresence";
import { useWriting } from "@/hooks/ws/usePresence";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "../ui/avatar";
import { convertTimeToRelative, getFirstLetters } from "@/utils/basicUtils";
import { ZunaAvatar } from "../avatar";
import { PulseLoader } from "react-spinners";
import { PinnedMessagesPanel } from "./pinned-messages-panel";

interface ChatTopbarProps {
  member: ChatMember;
  server: Server;
  sharedSecret: string | null;
}

function TopbarAction({
  icon: Icon,
  label,
}: {
  icon: React.ElementType;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{label}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ChatTopbar({ member, server, sharedSecret }: ChatTopbarProps) {
  const { getMemberPresence } = usePresence();
  const { isMemberTyping } = useWriting();
  const presence = getMemberPresence(member.id);
  const isTyping = presence?.active && isMemberTyping(member.id, member.chatId);

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border/40 bg-background shrink-0 z-10">
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative shrink-0">
          <ZunaAvatar
            username={member.username}
            src={member.avatar}
            isOnline={presence?.active ?? false}
          />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">
            {member.username}
          </p>
          <p
            className={`text-[11px] leading-tight font-medium ${
              isTyping
                ? "text-emerald-500"
                : presence?.active
                  ? "text-emerald-500"
                  : "text-gray-500"
            }`}
          >
            {isTyping ? (
              <span className="flex flex-row items-center gap-0.5">
                <PulseLoader
                  color="currentColor"
                  size={3}
                  className="mt-0.5"
                  speedMultiplier={0.85}
                />
                typing
              </span>
            ) : presence?.active ? (
              "Online"
            ) : (
              "Last seen " +
              (presence?.lastSeen
                ? convertTimeToRelative(presence.lastSeen)
                : "sometimes ago")
            )}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <TopbarAction icon={Phone} label="Voice call" />
        <TopbarAction icon={Search} label="Search in conversation" />
        <PinnedMessagesPanel
          server={server}
          member={member}
          sharedSecret={sharedSecret}
        />
        <TopbarAction icon={BellOff} label="Mute notifications" />
        <TopbarAction icon={MoreHorizontal} label="More options" />
      </div>
    </div>
  );
}
