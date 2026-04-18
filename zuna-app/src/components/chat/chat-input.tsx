import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { Paperclip, Smile, Send, ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEmotes } from "@/hooks/useEmotes";
import { ActionButton } from "./action-button";
import { EmotePicker } from "./emote-picker";
import { OgPreviewCard } from "./og-preview";
import { extractFirstUrl, useOgPreview } from "@/hooks/useOgPreview";

export interface ChatInputProps {
  sharedSecret: string | null;
  onSend: (
    cipherText: string,
    iv: string,
    authTag: string,
    plaintext: string,
  ) => void;
}

type Suggestion = {
  query: string;
  start: number;
  results: [string, string][];
  selectedIdx: number;
};

function detectSuggestion(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const match = before.match(/:([a-zA-Z0-9_]+)$/);
  if (!match) return null;
  return { query: match[1], start: before.length - match[0].length };
}

export function ChatInput({ sharedSecret, onSend }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [ogDismissed, setOgDismissed] = useState<string | null>(null);

  const detectedUrl = extractFirstUrl(value);
  const ogUrl = detectedUrl && detectedUrl !== ogDismissed ? detectedUrl : null;
  const { data: ogData, loading: ogLoading } = useOgPreview(ogUrl, 600);

  const pickerOpenRef = useRef(false);
  const suggestionRef = useRef<Suggestion | null>(null);
  suggestionRef.current = suggestion;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const { emoteMap } = useEmotes();

  const canSend = !!sharedSecret && !isSending;
  useEffect(() => {
    if (!suggestion) return;
    const el = suggestionListRef.current?.querySelector<HTMLElement>(
      `[data-idx="${suggestion.selectedIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [suggestion?.selectedIdx]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setValue(newValue);

      if (emoteMap.size === 0) return;

      const cursor = e.target.selectionStart ?? newValue.length;
      const detected = detectSuggestion(newValue, cursor);

      if (!detected) {
        setSuggestion(null);
        return;
      }

      const q = detected.query.toLowerCase();
      const results = Array.from(emoteMap.entries()).filter(([name]) =>
        name.toLowerCase().startsWith(q),
      );

      if (results.length === 0) {
        setSuggestion(null);
        return;
      }

      setSuggestion((prev) => ({
        query: detected.query,
        start: detected.start,
        results,
        selectedIdx: prev?.query === detected.query ? prev.selectedIdx : 0,
      }));
    },
    [emoteMap],
  );

  const commitSuggestion = useCallback(
    (name: string, start: number) => {
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? value.length;
      const before = value.slice(0, start);
      const after = value.slice(cursor);
      const suffix = after.length > 0 && !after.startsWith(" ") ? " " : " ";
      const next = before + name + suffix + after;
      setValue(next);
      setSuggestion(null);
      const newCursor = before.length + name.length + suffix.length;
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(newCursor, newCursor);
      });
    },
    [value],
  );

  const previewTokens = useMemo(() => {
    if (!value.trim() || emoteMap.size === 0) return null;
    const parts = value.split(/(\b[a-zA-Z0-9_]+\b)/g);
    if (!parts.some((p) => emoteMap.has(p))) return null;
    return parts;
  }, [value, emoteMap]);

  const insertEmote = useCallback((name: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setValue((v) => (v === "" || v.endsWith(" ") ? v : v + " ") + name + " ");
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const prefix = before.length > 0 && !before.endsWith(" ") ? " " : "";
    const suffix = after.length > 0 && !after.startsWith(" ") ? " " : "";
    const next = before + prefix + name + suffix + after;
    setValue(next);
    const cursor = before.length + prefix.length + name.length + suffix.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(cursor, cursor);
    });
  }, []);

  const handleSend = useCallback(async () => {
    const text = value.trim();
    if (!text || !sharedSecret || isSending) return;

    setIsSending(true);
    setValue("");
    setOgDismissed(null);

    try {
      const encrypted = await window.security.encrypt(sharedSecret, text);
      onSend(encrypted.ciphertext, encrypted.iv, encrypted.authTag, text);
    } catch (err) {
      console.error("[ChatInput] encryption failed:", err);
      setValue(text);
    } finally {
      setIsSending(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [value, sharedSecret, isSending, onSend]);

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
    [handleSend, commitSuggestion],
  );

  return (
    <div className="shrink-0 bg-background px-4 py-3">
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
        />

        <div
          className={cn(
            "relative flex-1 rounded-2xl bg-muted/40 dark:bg-muted/20 border border-transparent",
            "transition-all duration-150",
            "focus-within:bg-background focus-within:border-border focus-within:shadow-sm",
          )}
        >
          {suggestion && suggestion.results.length > 0 && (
            <div
              ref={suggestionListRef}
              className={cn(
                "absolute bottom-full left-0 right-0 mb-1.5 z-50",
                "bg-popover border border-border rounded-xl shadow-lg",
                "max-h-52 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]",
                "py-1",
              )}
            >
              {suggestion.results.slice(0, 24).map(([name, url], idx) => (
                <button
                  key={name}
                  data-idx={idx}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitSuggestion(name, suggestion.start);
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors",
                    idx === suggestion.selectedIdx
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60 text-foreground",
                  )}
                >
                  <img
                    src={url}
                    alt={name}
                    className="h-6 w-6 shrink-0 object-contain"
                  />
                  <span className="truncate">
                    <span className="text-muted-foreground">:</span>
                    <span className="font-medium">{name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (!pickerOpenRef.current) {
                setTimeout(() => textareaRef.current?.focus(), 0);
              }
            }}
            placeholder={
              sharedSecret ? "Message…" : "Establishing secure channel…"
            }
            disabled={!canSend && value === ""}
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
            <div className="flex flex-wrap items-center gap-x-0 px-4 pb-2 text-sm leading-relaxed pointer-events-none select-none text-foreground/70 border-t border-border/30 pt-1.5">
              {previewTokens.map((part, i) => {
                const url = emoteMap.get(part);
                if (url) {
                  return (
                    <img
                      key={i}
                      src={url}
                      alt={part}
                      className="inline-block align-middle h-[1.6em] mx-px"
                    />
                  );
                }
                return <span key={i}>{part}</span>;
              })}
            </div>
          )}
        </div>

        <ActionButton icon={ImagePlus} label="Send image" disabled={!canSend} />

        <Tooltip>
          <Popover
            open={pickerOpen}
            onOpenChange={(open) => {
              pickerOpenRef.current = open;
              setPickerOpen(open);
              if (!open) {
                setTimeout(() => textareaRef.current?.focus(), 0);
              }
            }}
          >
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={!canSend}
                  className="size-9 shrink-0 rounded-xl text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <Smile className="size-4.25" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <PopoverContent side="top" align="end" className="w-72 p-3">
              <EmotePicker
                onSelect={(name) => {
                  insertEmote(name);
                  setPickerOpen(false);
                  pickerOpenRef.current = false;
                }}
              />
            </PopoverContent>
          </Popover>
          <TooltipContent side="top" className="text-xs">
            Insert emote
          </TooltipContent>
        </Tooltip>

        {value.trim() && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                disabled={!canSend}
                onClick={handleSend}
                className="size-9 shrink-0 rounded-xl"
              >
                <Send className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Send
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
