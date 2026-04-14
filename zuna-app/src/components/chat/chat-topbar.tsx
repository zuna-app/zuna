import { ChatMember } from "@/types/serverTypes";
import { PseudoAvatar } from "@/components/ui/pseudo-avatar";
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

interface ChatTopbarProps {
  member: ChatMember;
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

export function ChatTopbar({ member }: ChatTopbarProps) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border/40 bg-background shrink-0 z-10">
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative shrink-0">
          <PseudoAvatar name={member.username} size={34} />
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full bg-emerald-500 ring-[1.5px] ring-background" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">
            {member.username}
          </p>
          <p className="text-[11px] text-emerald-500 leading-tight font-medium">
            Online
          </p>
        </div>
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <TopbarAction icon={Phone} label="Voice call" />
        <TopbarAction icon={Search} label="Search in conversation" />
        <TopbarAction icon={BellOff} label="Mute notifications" />
        <TopbarAction icon={MoreHorizontal} label="More options" />
      </div>
    </div>
  );
}
