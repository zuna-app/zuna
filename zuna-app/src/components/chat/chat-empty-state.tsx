import { MessageSquareDot } from "lucide-react";

export function ChatEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center select-none">
      <div className="relative">
        <div className="size-16 rounded-2xl bg-muted flex items-center justify-center">
          <MessageSquareDot className="size-8 text-muted-foreground/60" />
        </div>
        <span className="absolute -bottom-1 -right-1 size-5 rounded-full bg-emerald-500 ring-2 ring-background flex items-center justify-center">
          <span className="text-[9px] font-bold text-white leading-none">
            ✓
          </span>
        </span>
      </div>
      <div className="space-y-1.5 max-w-50">
        <h3 className="text-sm font-semibold">Your messages</h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Select a conversation from the left to start chatting
        </p>
      </div>
    </div>
  );
}
