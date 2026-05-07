import { useState, useRef, useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { EmoteSuggestionList } from "./input/emote-suggestion-list";
import { EmotePickerButton } from "./input/emote-picker-button";
import { SendButton } from "./input/send-button";
import { useWritingIndicator } from "./input/use-writing-indicator";
import { useAutoFocus } from "./input/use-auto-focus";
import { useEmoteSuggestion } from "./input/use-emote-suggestion";

const WRITE_IDLE_MS = 4000;

interface ChannelInputProps {
  channelName: string;
  onSend: (text: string) => void;
  onWrite?: (writing: boolean) => void;
  sevenTvEnabled?: boolean;
  sevenTvEmotesSet?: string | null;
}

export function ChannelInput({
  channelName,
  onSend,
  onWrite,
  sevenTvEnabled = true,
  sevenTvEmotesSet = null,
}: ChannelInputProps) {
  const [value, setValue] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const pickerOpenRef = useRef(false);

  const { setWriting, writeTimeoutRef } = useWritingIndicator(onWrite);
  const { emoteMap } = useEmotes(sevenTvEmotesSet, sevenTvEnabled);

  const {
    suggestion,
    setSuggestion,
    suggestionRef,
    updateSuggestion,
    commitSuggestion,
    insertEmote,
  } = useEmoteSuggestion(
    emoteMap,
    value,
    setValue,
    textareaRef,
    suggestionListRef,
  );

  useAutoFocus(textareaRef, pickerOpenRef, true);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setValue("");
    if (writeTimeoutRef.current) clearTimeout(writeTimeoutRef.current);
    setWriting(false);
    onSend(trimmed);
  }, [value, onSend, setWriting, writeTimeoutRef]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);

      if (newValue.trim()) {
        setWriting(true);
        if (writeTimeoutRef.current) clearTimeout(writeTimeoutRef.current);
        writeTimeoutRef.current = setTimeout(
          () => setWriting(false),
          WRITE_IDLE_MS,
        );
      } else {
        if (writeTimeoutRef.current) clearTimeout(writeTimeoutRef.current);
        setWriting(false);
      }

      updateSuggestion(newValue, e.target.selectionStart ?? newValue.length);
    },
    [setWriting, updateSuggestion, writeTimeoutRef],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const s = suggestionRef.current;

      if (s) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSuggestion((prev) =>
            prev
              ? {
                  ...prev,
                  selectedIdx: (prev.selectedIdx + 1) % prev.results.length,
                }
              : prev,
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSuggestion((prev) =>
            prev
              ? {
                  ...prev,
                  selectedIdx:
                    (prev.selectedIdx - 1 + prev.results.length) %
                    prev.results.length,
                }
              : prev,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const [name] = s.results[s.selectedIdx];
          commitSuggestion(name, s.start);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSuggestion(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, commitSuggestion, setSuggestion, suggestionRef],
  );

  const canSendNow = !!value.trim();

  return (
    <div className="shrink-0 bg-background px-2 md:px-4 py-3">
      <div
        className="flex w-full min-w-0 items-end gap-1 md:gap-1.5"
        onMouseDown={(e) => {
          if (e.target !== textareaRef.current) e.preventDefault();
        }}
      >
        <div
          className={cn(
            "relative min-w-0 flex-1 rounded-2xl bg-muted/40 dark:bg-muted/20 border border-transparent",
            "transition-[background-color,border-color,box-shadow] duration-150",
            "focus-within:bg-background focus-within:border-border focus-within:shadow-sm",
          )}
        >
          {suggestion && suggestion.results.length > 0 && (
            <EmoteSuggestionList
              suggestion={suggestion}
              listRef={suggestionListRef}
              onCommit={commitSuggestion}
            />
          )}

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={`Message #${channelName}`}
            rows={1}
            className={cn(
              "w-full bg-transparent border-none shadow-none resize-none",
              "px-4 py-2 text-base md:text-sm",
              "placeholder:text-muted-foreground/40",
              "focus-visible:ring-0 focus-visible:border-none",
              "min-h-0 max-h-40 field-sizing-content",
            )}
          />
        </div>

        <EmotePickerButton
          disabled={false}
          open={pickerOpen}
          sevenTvEnabled={sevenTvEnabled}
          sevenTvEmotesSet={sevenTvEmotesSet}
          onOpenChange={(open) => {
            pickerOpenRef.current = open;
            setPickerOpen(open);
            if (!open) {
              setTimeout(() => textareaRef.current?.focus(), 0);
            }
          }}
          onSelect={(name) => {
            insertEmote(name);
            setPickerOpen(false);
            pickerOpenRef.current = false;
          }}
        />

        <SendButton
          canSend={true}
          canSendNow={canSendNow}
          onClick={handleSend}
        />
      </div>
    </div>
  );
}
