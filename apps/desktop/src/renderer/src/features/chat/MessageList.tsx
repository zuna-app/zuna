import type { ConversationView, MessageView } from "@zuna/core";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Spinner } from "@/components/ui";
import { formatDaySeparator, sameDay } from "@/lib/format";
import { useApp } from "@/state/store";
import { MessageItem } from "./MessageItem";

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Where each chat was scrolled to, when it wasn't at the newest message. */
const savedPositions = new Map<string, number>();

function continues(a: MessageView | undefined, b: MessageView | undefined): boolean {
  return (
    !!a &&
    !!b &&
    !a.system &&
    !b.system &&
    a.senderId === b.senderId &&
    b.createdAt - a.createdAt < GROUP_WINDOW_MS &&
    sameDay(a.createdAt, b.createdAt)
  );
}

const Header = ({ context }: { context?: { loading: boolean } }) =>
  context?.loading ? (
    <div className="list-loading">
      <Spinner size={15} delayed />
    </div>
  ) : (
    <div style={{ height: 8 }} />
  );

const ListFooter = () => <div style={{ height: 10 }} />;

export function MessageList({ conversation, listId, emptyState }: { conversation: ConversationView; listId: string; emptyState: ReactNode }) {
  const list = useApp((state) => state.lists[listId]);
  const loadOlder = useApp((state) => state.loadOlder);
  const returnToLatest = useApp((state) => state.returnToLatest);
  const jumpTarget = useApp((state) => state.jumpTarget);
  const windowFocused = useApp((state) => state.windowFocused);
  const session = useApp((state) => state.session);
  const selfId = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId]?.self?.userId : undefined)) ?? "";
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const topIndex = useRef(0);

  const items = list?.items ?? [];
  const isGroup = conversation.kind === "group";
  const isAdmin = conversation.members.find((member) => member.userId === selfId)?.role === "admin";
  const readUpTo = useMemo(
    () => Object.entries(conversation.readBy).reduce((highest, [id, seq]) => (id === selfId ? highest : Math.max(highest, seq)), 0),
    [conversation.readBy, selfId],
  );

  // Only messages arriving while the chat is open animate in, so scrolling back
  // through history never replays anything.
  const seen = useRef(new Set<string>());
  const fresh = useRef(new Set<string>());
  const primed = useRef(false);
  useMemo(() => {
    for (const item of items) {
      if (!seen.current.has(item.id)) {
        seen.current.add(item.id);
        if (primed.current) {
          fresh.current.add(item.id);
          setTimeout(() => fresh.current.delete(item.id), 400);
        }
      }
    }
    if (list?.loaded) primed.current = true;
  }, [items, list?.loaded]);

  // Sending always brings you to the newest message.
  const lastItem = items[items.length - 1];
  const lastItemId = lastItem?.id;
  useEffect(() => {
    if (lastItem && lastItem.senderId === selfId && fresh.current.has(lastItem.id)) {
      virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    }
  }, [lastItemId]);

  // Remember the position when leaving a chat that's scrolled up.
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  useLayoutEffect(
    () => () => {
      if (atBottomRef.current) savedPositions.delete(listId);
      else savedPositions.set(listId, topIndex.current);
    },
    [listId],
  );

  // Mark as read while the newest messages are on screen in a focused window.
  const newestSeq = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.seq !== null && !item.id.startsWith("sys-")) return item.seq;
    }
    return 0;
  }, [items]);
  useEffect(() => {
    if (!atBottom || !windowFocused || !conversation.groupId || list?.detached) return;
    if (newestSeq > conversation.ownRead) {
      void session().markRead(conversation.groupId, newestSeq).catch(() => undefined);
    }
  }, [atBottom, windowFocused, newestSeq, conversation.ownRead, conversation.groupId, list?.detached, session]);

  // When the message box grows or a reply bar opens, the bottom edge of the list
  // stays put, so the newest message never slides behind them.
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const watchScroller = useCallback((element: HTMLElement | Window | null) => {
    resizeObserver.current?.disconnect();
    if (!(element instanceof HTMLElement)) return;
    let height = element.clientHeight;
    resizeObserver.current = new ResizeObserver(() => {
      element.scrollTop += height - element.clientHeight;
      height = element.clientHeight;
    });
    resizeObserver.current.observe(element);
  }, []);
  useEffect(() => () => resizeObserver.current?.disconnect(), []);

  // Jump to a reply, a pin or a search result.
  useEffect(() => {
    if (!jumpTarget || jumpTarget.groupId !== listId) return;
    const index = items.findIndex((item) => item.id === jumpTarget.messageId);
    if (index < 0) return;
    const timer = setTimeout(() => {
      virtuoso.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
      setHighlightId(jumpTarget.messageId);
      setTimeout(() => setHighlightId(null), 1200);
    }, 30);
    return () => clearTimeout(timer);
  }, [jumpTarget?.nonce]);

  const scrollToBottom = useCallback(() => {
    if (list?.detached) {
      void returnToLatest(listId);
      return;
    }
    virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [list?.detached, listId, returnToLatest]);

  const firstIndex = list?.firstIndex ?? 0;
  const itemContent = useCallback(
    (index: number, message: MessageView) => {
      const position = index - firstIndex;
      const previous = items[position - 1];
      const next = items[position + 1];
      const showDay = !previous || !sameDay(previous.createdAt, message.createdAt);
      return (
        <div className="list-item">
          {showDay && (
            <div className="day-sep">
              <span>{formatDaySeparator(message.createdAt)}</span>
            </div>
          )}
          <MessageItem
            message={message}
            listId={listId}
            isGroup={isGroup}
            isGroupAdmin={isAdmin}
            readUpTo={readUpTo}
            grouped={!showDay && continues(previous, message)}
            lastInGroup={!continues(message, next)}
            fresh={fresh.current.has(message.id)}
            highlighted={highlightId === message.id}
            own={message.senderId === selfId}
          />
        </div>
      );
    },
    [items, firstIndex, listId, isGroup, isAdmin, readUpTo, highlightId, selfId],
  );

  if (!list?.loaded && items.length === 0) {
    return (
      <div className="list-center">
        <Spinner delayed />
      </div>
    );
  }
  if (items.length === 0 || !list) {
    return <div className="list-center">{emptyState}</div>;
  }

  const unreadBelow = !atBottom ? conversation.unread : 0;
  const saved = savedPositions.get(listId);

  return (
    <div className="message-list">
      <Virtuoso
        key={list.detached ? `${listId}:detached` : listId}
        ref={virtuoso}
        scrollerRef={watchScroller}
        data={items}
        firstItemIndex={list.firstIndex}
        initialTopMostItemIndex={saved !== undefined && !list.detached ? { index: Math.min(saved, items.length - 1), align: "start" } : { index: "LAST", align: "end" }}
        computeItemKey={(_index, message) => message.id}
        followOutput={(bottom) => (bottom ? "auto" : false)}
        alignToBottom
        atBottomThreshold={64}
        atBottomStateChange={setAtBottom}
        rangeChanged={(range) => {
          topIndex.current = range.startIndex - list.firstIndex;
        }}
        startReached={() => {
          if (list.hasMore && !list.detached) void loadOlder(listId);
        }}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        itemContent={itemContent}
        context={{ loading: list.loading }}
        components={{ Header, Footer: ListFooter }}
        className="virtuoso"
      />
      {(!atBottom || list.detached) && (
        <button className="to-bottom" onClick={scrollToBottom} aria-label="Go to the newest messages">
          <ArrowDown size={18} />
          {unreadBelow > 0 && <span className="to-bottom-badge">{unreadBelow > 99 ? "99+" : unreadBelow}</span>}
        </button>
      )}
    </div>
  );
}
