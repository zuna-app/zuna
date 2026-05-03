import { useState, useRef, useCallback, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Paperclip, ImagePlus, Code2, X, Reply } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  sevenTvEnabled?: boolean;
  sevenTvEmotesSet?: string | null;
  editingMessage?: {
    id: number;
    originalText: string;
  } | null;
  onCancelEdit?: () => void;
  onEditLastMessage?: () => void;
  replyingTo?: {
    id: number;
    rawText: string;
  } | null;
  onCancelReply?: () => void;
}

export function ChatInput({
  sharedSecret,
  onSend,
  onWrite,
  onSendFile,
  pendingFile,
  onPendingFileChange,
  sevenTvEnabled = true,
  sevenTvEmotesSet = null,
  editingMessage = null,
  onCancelEdit,
  onEditLastMessage,
  replyingTo = null,
  onCancelReply,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ogDismissed, setOgDismissed] = useState<string | null>(null);
  const [codeMode, setCodeMode] = useState(false);
  const [codeLang, setCodeLang] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
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
    codeMode,
    codeLang,
    setCodeMode,
  });

  const canSend = !!sharedSecret && !isSending;
  const isEditing = !!editingMessage;
  const canSendNow =
    canSend && (!!value.trim() || (!!pendingFile && !isEditing));

  useAutoFocus(textareaRef, pickerOpenRef, canSend);

  useEffect(() => {
    if (!editingMessage) return;
    setValue(editingMessage.originalText);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [editingMessage]);

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

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (isEditing) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            onPendingFileChange(file);
            return;
          }
        }
      }
    },
    [onPendingFileChange, isEditing],
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
        return;
      }

      if (
        e.key === "ArrowUp" &&
        !isEditing &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        value.length === 0 &&
        e.currentTarget.selectionStart === 0 &&
        e.currentTarget.selectionEnd === 0
      ) {
        e.preventDefault();
        onEditLastMessage?.();
      }
    },
    [
      handleSend,
      commitSuggestion,
      isEditing,
      onEditLastMessage,
      setSuggestion,
      suggestionRef,
      value.length,
    ],
  );

  return (
    <div className="shrink-0 bg-background px-2 md:px-4 py-3">
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

      {replyingTo && (
        <div className="mb-2 rounded-md border border-muted-foreground/20 bg-muted/30 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex items-center gap-2">
              <Reply className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  Replying to message
                </p>
                <p className="text-xs text-muted-foreground/70 truncate">
                  {replyingTo.rawText || "(attachment)"}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={onCancelReply}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {isEditing && (
        <div className="mb-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-primary">
                Editing message
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {editingMessage.originalText || "(empty message)"}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={onCancelEdit}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      <div
        className="flex w-full min-w-0 items-end gap-1 md:gap-1.5"
        onMouseDown={(e) => {
          if (e.target !== textareaRef.current) e.preventDefault();
        }}
      >
        <ActionButton
          icon={Paperclip}
          label="Attach file"
          disabled={!canSend || isEditing}
          onClick={() => fileInputRef.current?.click()}
        />

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
            onPaste={handlePaste}
            placeholder={
              codeMode
                ? "Paste or type your code…"
                : pendingFile
                  ? "Add a message… (optional)"
                  : isEditing
                    ? "Edit message…"
                    : sharedSecret
                      ? "Message…"
                      : "Establishing secure channel…"
            }
            rows={1}
            className={cn(
              "w-full bg-transparent border-none shadow-none resize-none",
              "px-4 py-2 text-base md:text-sm",
              "placeholder:text-muted-foreground/40",
              "focus-visible:ring-0 focus-visible:border-none",
              "min-h-0 max-h-40 field-sizing-content",
              codeMode && "font-mono text-[16px] md:text-xs",
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
          {/* {previewTokens && (
            <EmotePreview tokens={previewTokens} emoteMap={emoteMap} />
          )} */}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!canSend || isEditing}
              onClick={() => {
                setCodeMode((v) => !v);
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              className={cn(
                "size-8 md:size-9 shrink-0 rounded-xl text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors",
                codeMode
                  ? "bg-primary/15 text-primary hover:bg-primary/20"
                  : "",
              )}
            >
              <Code2 className="size-3.25 md:size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {codeMode ? "Exit code mode" : "Code mode"}
          </TooltipContent>
        </Tooltip>

        {/* <ActionButton
          icon={ImagePlus}
          label="Send image"
          disabled={!canSend}
          onClick={() => imageInputRef.current?.click()}
        /> */}

        <EmotePickerButton
          disabled={!canSend || isEditing}
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
          canSend={canSend}
          canSendNow={canSendNow}
          onClick={handleSend}
        />
      </div>
    </div>
  );
}
