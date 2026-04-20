import { useState, useRef, useCallback } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Paperclip, ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { ActionButton } from "./action-button";
import { OgPreviewCard } from "./og-preview";
import { extractFirstUrl, useOgPreview } from "@/hooks/ui/useOgPreview";
import { EmoteSuggestionList } from "./input/emote-suggestion-list";
import { PendingFilePreview } from "./input/pending-file-preview";
import { EmotePreview } from "./input/emote-preview";
import { EmotePickerButton } from "./input/emote-picker-button";
import { SendButton } from "./input/send-button";
import { useWritingIndicator } from "./input/use-writing-indicator";
import { useAutoFocus } from "./input/use-auto-focus";
import { useEmoteSuggestion } from "./input/use-emote-suggestion";
import { useSendMessage } from "./input/use-send-message";

const WRITE_IDLE_MS = 5000;

export interface ChatInputProps {
  sharedSecret: string | null;
  onSend: (
    cipherText: string,
    iv: string,
    authTag: string,
    plaintext: string,
  ) => void;
  onWrite?: (writing: boolean) => void;
  onSendFile?: (file: File, plaintext: string) => void;
  pendingFile: File | null;
  onPendingFileChange: (file: File | null) => void;
}

export function ChatInput({
  sharedSecret,
  onSend,
  onWrite,
  onSendFile,
  pendingFile,
  onPendingFileChange,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ogDismissed, setOgDismissed] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const pickerOpenRef = useRef(false);

  const { setWriting, writeTimeoutRef } = useWritingIndicator(onWrite);
  const { emoteMap } = useEmotes();

  const {
    suggestion,
    setSuggestion,
    suggestionRef,
    updateSuggestion,
    commitSuggestion,
    insertEmote,
    previewTokens,
  } = useEmoteSuggestion(
    emoteMap,
    value,
    setValue,
    textareaRef,
    suggestionListRef,
  );

  const { isSending, handleSend } = useSendMessage({
    sharedSecret,
    value,
    setValue,
    pendingFile,
    onPendingFileChange,
    onSend,
    onSendFile,
    setWriting,
    writeTimeoutRef,
    setOgDismissed,
    textareaRef,
  });

  const canSend = !!sharedSecret && !isSending;
  const canSendNow = canSend && (!!value.trim() || !!pendingFile);

  useAutoFocus(textareaRef, pickerOpenRef, canSend);

  const detectedUrl = extractFirstUrl(value);
  const ogUrl = detectedUrl && detectedUrl !== ogDismissed ? detectedUrl : null;
  const { loading: ogLoading } = useOgPreview(ogUrl, 600);

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
    [setWriting, updateSuggestion],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onPendingFileChange(file);
      e.target.value = "";
    },
    [onPendingFileChange],
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

  return (
    <div className="shrink-0 bg-background px-4 py-3">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileInputChange}
      />

      <div
        className="flex items-end gap-1.5"
        onMouseDown={(e) => {
          if (e.target !== textareaRef.current) e.preventDefault();
        }}
      >
        <ActionButton
          icon={Paperclip}
          label="Attach file"
          disabled={!canSend}
          onClick={() => fileInputRef.current?.click()}
        />

        <div
          className={cn(
            "relative flex-1 rounded-2xl bg-muted/40 dark:bg-muted/20 border border-transparent",
            "transition-all duration-150",
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

          {pendingFile && (
            <PendingFilePreview
              file={pendingFile}
              onDismiss={() => onPendingFileChange(null)}
            />
          )}

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              pendingFile
                ? "Add a message… (optional)"
                : sharedSecret
                  ? "Message…"
                  : "Establishing secure channel…"
            }
            disabled={!canSend && value === "" && !pendingFile}
            rows={1}
            className={cn(
              "w-full bg-transparent border-none shadow-none resize-none",
              "px-4 py-2 text-sm",
              "placeholder:text-muted-foreground/40",
              "focus-visible:ring-0 focus-visible:border-none",
              "min-h-0 max-h-40 field-sizing-content",
            )}
          />
          {(ogUrl || ogLoading) && (
            <div className="px-2 pb-2">
              {ogUrl && (
                <OgPreviewCard
                  url={ogUrl}
                  variant="input"
                  onDismiss={() => setOgDismissed(ogUrl)}
                />
              )}
            </div>
          )}
          {previewTokens && (
            <EmotePreview tokens={previewTokens} emoteMap={emoteMap} />
          )}
        </div>

        <ActionButton
          icon={ImagePlus}
          label="Send image"
          disabled={!canSend}
          onClick={() => imageInputRef.current?.click()}
        />

        <EmotePickerButton
          disabled={!canSend}
          open={pickerOpen}
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
          canSend={canSend}
          canSendNow={canSendNow}
          onClick={handleSend}
        />
      </div>
    </div>
  );
}
