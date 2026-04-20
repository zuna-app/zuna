import { formatTime } from "./types";

interface MessageDividerProps {
  sentAt: number;
}

export function MessageDivider({ sentAt }: MessageDividerProps) {
  return (
    <div className="flex items-center gap-3 py-3 mt-2">
      <div className="flex-1 h-px bg-border/40" />
      <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
        {formatTime(sentAt)}
      </span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  );
}
