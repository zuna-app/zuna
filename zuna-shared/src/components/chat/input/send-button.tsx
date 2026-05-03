import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Send } from "lucide-react";

interface SendButtonProps {
  canSend: boolean;
  canSendNow: boolean;
  onClick: () => void;
}

export function SendButton({ canSend, canSendNow, onClick }: SendButtonProps) {
  if (!canSendNow) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          disabled={!canSend}
          onClick={onClick}
          className="size-8 md:size-9 shrink-0 rounded-xl"
        >
          <Send className="size-3.75 md:size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Send
      </TooltipContent>
    </Tooltip>
  );
}
