import React, { useRef, useEffect } from "react";

export function useAutoFocus(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  pickerOpenRef: React.RefObject<boolean>,
  canSend: boolean,
) {
  const prevCanSendRef = useRef(false);

  // Focus on canSend false→true transition (channel open, secret established, post-send)
  useEffect(() => {
    if (!prevCanSendRef.current && canSend) {
      textareaRef.current?.focus();
    }
    prevCanSendRef.current = canSend;
  }, [canSend]);

  // Refocus textarea on any non-interactive click
  useEffect(() => {
    const handleMouseUp = () => {
      if (pickerOpenRef.current) return;
      if (textareaRef.current?.disabled) return;

      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;

      const active = document.activeElement;
      const tag = active?.tagName ?? "";
      const isInteractive =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "BUTTON" ||
        tag === "SELECT" ||
        tag === "A" ||
        !!(active as HTMLElement | null)?.isContentEditable;

      if (!isInteractive) textareaRef.current?.focus();
    };
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  // Redirect printable key presses to the textarea when nothing else is focused
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pickerOpenRef.current) return;
      if (textareaRef.current?.disabled) return;
      if (e.key.length !== 1) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const active = document.activeElement;
      const tag = active?.tagName ?? "";
      const isInputFocused =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        !!(active as HTMLElement | null)?.isContentEditable;

      if (!isInputFocused) textareaRef.current?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
