import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Paperclip, Smile, Send, ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";

function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          className="size-9 shrink-0 rounded-xl text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <Icon className="size-4.25" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ChatInput() {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (value.trim()) {
          setValue("");
          textareaRef.current?.focus();
        }
      }
    },
    [value],
  );

  return (
    <div className="shrink-0 bg-background px-4 py-3">
      <div className="flex items-end gap-1.5">
        <ActionButton icon={Paperclip} label="Attach file" />

        <div
          className={cn(
            "relative flex-1 rounded-2xl bg-muted/40 dark:bg-muted/20 border border-transparent",
            "transition-all duration-150",
            "focus-within:bg-background focus-within:border-border focus-within:shadow-sm",
          )}
        >
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message…"
            rows={1}
            className={cn(
              "w-full bg-transparent border-none shadow-none resize-none",
              "px-4 py-2 text-sm",
              "placeholder:text-muted-foreground/40",
              "focus-visible:ring-0 focus-visible:border-none",
              "min-h-0 max-h-40 field-sizing-content",
            )}
          />
        </div>

        <ActionButton icon={ImagePlus} label="Send image" />
        <ActionButton icon={Smile} label="Insert emoji" />
      </div>
    </div>
  );
}
