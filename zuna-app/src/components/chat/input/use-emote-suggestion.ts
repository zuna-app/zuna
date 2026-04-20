import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import type { Suggestion } from "./types";

function detectSuggestion(
  text: string,
  cursor: number,
): { query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const match = before.match(/:([a-zA-Z0-9_]+)$/);
  if (!match) return null;
  return { query: match[1], start: before.length - match[0].length };
}

export function useEmoteSuggestion(
  emoteMap: ReadonlyMap<string, string>,
  value: string,
  setValue: React.Dispatch<React.SetStateAction<string>>,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  suggestionListRef: React.RefObject<HTMLDivElement | null>,
) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const suggestionRef = useRef<Suggestion | null>(null);
  suggestionRef.current = suggestion;

  // Scroll the highlighted suggestion row into view
  useEffect(() => {
    if (!suggestion) return;
    const el = suggestionListRef.current?.querySelector<HTMLElement>(
      `[data-idx="${suggestion.selectedIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [suggestion?.selectedIdx]);

  const updateSuggestion = useCallback(
    (newValue: string, cursor: number) => {
      if (emoteMap.size === 0) {
        setSuggestion(null);
        return;
      }

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

  const previewTokens = useMemo(() => {
    if (!value.trim() || emoteMap.size === 0) return null;
    const parts = value.split(/(\b[a-zA-Z0-9_]+\b)/g);
    if (!parts.some((p) => emoteMap.has(p))) return null;
    return parts;
  }, [value, emoteMap]);

  return {
    suggestion,
    setSuggestion,
    suggestionRef,
    updateSuggestion,
    commitSuggestion,
    insertEmote,
    previewTokens,
  };
}
