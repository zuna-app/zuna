import React from "react";
import { cn } from "@/lib/utils";
import type { Suggestion } from "./types";

interface EmoteSuggestionListProps {
  suggestion: Suggestion;
  listRef: React.RefObject<HTMLDivElement | null>;
  onCommit: (name: string, start: number) => void;
}

export function EmoteSuggestionList({
  suggestion,
  listRef,
  onCommit,
}: EmoteSuggestionListProps) {
  return (
    <div
      ref={listRef}
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
            onCommit(name, suggestion.start);
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
  );
}
