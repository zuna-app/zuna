import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Smile } from "lucide-react";
import { EmotePicker } from "../emote-picker";

interface EmotePickerButtonProps {
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (name: string) => void;
}

export function EmotePickerButton({
  disabled,
  open,
  onOpenChange,
  onSelect,
}: EmotePickerButtonProps) {
  return (
    <Tooltip>
      <Popover open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              className="size-9 shrink-0 rounded-xl text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <Smile className="size-4.25" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <PopoverContent side="top" align="end" className="w-72 p-3">
          <EmotePicker onSelect={onSelect} />
        </PopoverContent>
      </Popover>
      <TooltipContent side="top" className="text-xs">
        Insert emote
      </TooltipContent>
    </Tooltip>
  );
}
