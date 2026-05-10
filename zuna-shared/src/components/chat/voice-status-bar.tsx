import { Mic, MicOff, Headphones, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VoiceStatusBarProps {
  channelName: string;
  muted: boolean;
  deafened: boolean;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
}

export function VoiceStatusBar({
  channelName,
  muted,
  deafened,
  onToggleMute,
  onToggleDeafen,
  onLeave,
}: VoiceStatusBarProps) {
  return (
    <div className="px-2 py-2 border-t border-border/50 shrink-0">
      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-green-500/10">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="size-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
          <span className="text-xs font-medium text-green-600 dark:text-green-400 shrink-0">
            Voice
          </span>
          <span className="text-xs text-muted-foreground truncate">
            #{channelName}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleMute}
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            muted && "text-destructive hover:text-destructive",
          )}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <MicOff className="size-3.5" />
          ) : (
            <Mic className="size-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleDeafen}
          className={cn(
            "shrink-0 text-muted-foreground hover:text-foreground",
            deafened && "text-destructive hover:text-destructive",
          )}
          title={deafened ? "Undeafen" : "Deafen"}
        >
          <Headphones className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onLeave}
          className="shrink-0 text-muted-foreground hover:text-destructive"
          title="Disconnect"
        >
          <PhoneOff className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
