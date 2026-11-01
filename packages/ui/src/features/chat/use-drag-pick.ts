import type { MessageView } from "@zuna/core";
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { useApp } from "@/state/store";

/** How near the list's top or bottom edge a drag starts scrolling it. */
const EDGE_PX = 56;
/** How far it scrolls a frame at the edge, and up to three times that further out. */
const EDGE_STEP_PX = 12;

/** Whether a message is on the server and still there, so it can be replied to, forwarded or picked. */
export const canActOn = (message: MessageView) => message.seq !== null && message.deletedAt === null && message.status === "sent";

/** The message row at this height, held to the list's own top and bottom. */
function rowAt(scroller: HTMLElement, y: number): string | null {
  const view = scroller.getBoundingClientRect();
  const at = Math.min(Math.max(y, view.top + 1), view.bottom - 1);
  for (const row of scroller.querySelectorAll<HTMLElement>(".list-item[data-id]")) {
    const box = row.getBoundingClientRect();
    if (box.bottom <= at) continue;
    return box.top <= at ? row.dataset.id! : null;
  }
  return null;
}

const clearTextSelection = () => {
  const selection = window.getSelection();
  if (selection?.rangeCount) selection.removeAllRanges();
};

/**
 * Picks messages by dragging across them, as in Telegram's desktop app: a drag from
 * one message onto another picks those between them, and once picking, a drag that
 * starts on a picked message lets go of them instead. Within one message, a drag
 * still selects its text, until it reaches another message.
 */
export function useDragPick(listId: string, scroller: RefObject<HTMLElement | null>) {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), [listId]);

  return (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as Element;
    const element = scroller.current;
    const startId = target.closest<HTMLElement>(".list-item[data-id]")?.dataset.id;
    if (!element || !startId || target.closest("input, textarea, video, audio, [contenteditable], [role='slider']")) return;
    stop.current?.();
    const selection = useApp.getState().selection;
    const base = selection?.listId === listId ? selection.ids : [];
    const letGo = base.includes(startId);
    // While picking, a press picks rather than starts selecting text.
    if (base.length) event.preventDefault();

    let dragging = false;
    let y = event.clientY;
    let frame = 0;

    const pickTo = (id: string) => {
      const { lists, servers, activeServerId } = useApp.getState();
      const items = lists[listId]?.items ?? [];
      const from = items.findIndex((item) => item.id === startId);
      const to = items.findIndex((item) => item.id === id);
      if (from < 0 || to < 0) return;
      // Only what a click could pick: not a line about the chat, nor a hidden message from someone blocked.
      const blocked = servers[activeServerId ?? ""]?.prefs.blocked ?? [];
      const range = items
        .slice(Math.min(from, to), Math.max(from, to) + 1)
        .filter((item) => !item.system && canActOn(item) && !blocked.includes(item.senderId))
        .map((item) => item.id);
      const ids = letGo ? base.filter((item) => !range.includes(item)) : [...base, ...range.filter((item) => !base.includes(item))];
      useApp.getState().setSelected(listId, ids);
    };
    const update = () => {
      const id = rowAt(element, y);
      if (!id || (!dragging && id === startId)) return;
      if (!dragging) {
        dragging = true;
        element.classList.add("is-picking");
        frame = requestAnimationFrame(scroll);
      }
      clearTextSelection();
      pickTo(id);
    };
    // Held near the top or bottom, or past it, the list scrolls, faster the further out.
    const scroll = () => {
      const view = element.getBoundingClientRect();
      const over = y < view.top + EDGE_PX ? y - view.top - EDGE_PX : y > view.bottom - EDGE_PX ? y - view.bottom + EDGE_PX : 0;
      if (over) {
        element.scrollTop += Math.max(-3, Math.min(3, over / EDGE_PX)) * EDGE_STEP_PX;
        update();
      }
      frame = requestAnimationFrame(scroll);
    };
    const onMove = (move: MouseEvent) => {
      if (!(move.buttons & 1)) return end();
      y = move.clientY;
      update();
      if (dragging) move.preventDefault();
    };
    const onSelectionChange = () => dragging && clearTextSelection();
    const onUp = (up: MouseEvent) => end(up);
    const onBlur = () => end();
    const end = (up?: MouseEvent) => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("selectionchange", onSelectionChange);
      element.classList.remove("is-picking");
      stop.current = null;
      if (!dragging) return;
      // The browser goes on stretching the text selection a drag began with, however
      // each move is handled, so whatever it reached last goes as the drag ends.
      clearTextSelection();
      if (!up) return;
      // The click a drag ends with doesn't also pick, or open, what it lands on.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true));
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("selectionchange", onSelectionChange);
    stop.current = () => end();
  };
}
