import type { ConversationView, MessageView } from "@zuna/core";
import { AtSign, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Spinner } from "@/components/ui";
import { formatDaySeparator, sameDay } from "@/lib/format";
import { isUnread, useApp } from "@/state/store";
import { MessageItem } from "./MessageItem";

function UndisplayableMessage() {
  return (
    <div className="msg is-other">
      <div className="msg-stack">
        <div className="bubble">
          <span className="msg-placeholder">This message couldn't be displayed.</span>
        </div>
      </div>
    </div>
  );
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** How near the newest message still counts as being at it. */
const AT_BOTTOM_PX = 64;
/** How long rows wait before moving down as the message box shrinks, in case a sent message is on its way. */
const SEND_WAIT_MS = 50;
/** How far past the screen rows are drawn, above and below. */
const DRAWN_AHEAD_PX = 800;
/**
 * How far before the top of what's loaded the next older messages are fetched:
 * well before the oldest row is drawn, since the list doesn't keep its place
 * when that one's height turns out different, and it would jump.
 */
const LOAD_AHEAD_PX = DRAWN_AHEAD_PX * 3;
/** How long reading waits after the last read position was sent before sending a further one. */
const READ_EVERY_MS = 250;

/** The message at the top of the list, and how far into it the list starts. */
interface Place {
  id: string;
  offset: number;
}

/** Where each chat was scrolled to, when it wasn't at the newest message. */
const savedPositions = new Map<string, Place>();

function placeIn(scroller: HTMLElement): Place | null {
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>(".list-item")) {
    const box = row.getBoundingClientRect();
    if (box.bottom > top) return { id: row.dataset.id!, offset: top - box.top };
  }
  return null;
}

/** The newest message that's been on screen enough to count as read: all of it, or most of the screen. */
function seenIn(scroller: HTMLElement): number {
  const view = scroller.getBoundingClientRect();
  let seen = 0;
  for (const row of scroller.querySelectorAll<HTMLElement>(".list-item[data-seq]")) {
    const box = row.getBoundingClientRect();
    if (box.top >= view.bottom) break;
    if (box.bottom > view.top && (box.bottom <= view.bottom + 1 || box.top <= view.top + view.height / 2)) seen = Math.max(seen, Number(row.dataset.seq));
  }
  return seen;
}

/** How many rows can fill the window at the smallest they get, and a few more. */
const firstRows = () => Math.ceil(window.innerHeight / 30) + 4;

const motionReduced = () => document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far a list still is from its place while it glides. */
function glideOffset(list: HTMLElement, glide: Animation | null): number {
  return glide?.playState === "running" ? new DOMMatrixReadOnly(getComputedStyle(list).transform).m42 : 0;
}

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

/** Always the same height, so loading older messages doesn't push the ones on screen. */
const Header = ({ context }: { context?: { loading: boolean } }) => (
  <div className="list-top">
    {context?.loading && (
      <div className="list-loading">
        <Spinner size={15} delayed />
      </div>
    )}
  </div>
);

const ListFooter = () => <div style={{ height: 10 }} />;

/**
 * As Telegram's "@": goes to the oldest unread message here that mentions you or
 * replies to you, then the next. Those read by scrolling past them drop out, and it
 * goes at the newest message, where everything is read.
 */
function MentionButton({ conversation, groupId, hidden, raised }: { conversation: ConversationView; groupId: string; hidden: boolean; raised: boolean }) {
  const session = useApp((state) => state.session);
  const jumpToMessage = useApp((state) => state.jumpToMessage);
  const asked = useRef(0);
  const [mentions, setMentions] = useState<{ id: string; seq: number }[]>([]);

  useEffect(() => {
    const ask = ++asked.current;
    void session()
      .unreadMentions(groupId, conversation.ownRead)
      .then((found) => ask === asked.current && setMentions(found))
      .catch(() => undefined);
  }, [groupId, conversation.ownRead, conversation.unreadMentions, session]);

  const next = mentions[0];
  if (!next || hidden) return null;
  const go = () => {
    setMentions(mentions.slice(1));
    void session().markMentionSeen(groupId, next.id).catch(() => undefined);
    void jumpToMessage(groupId, next.id, next.seq);
  };
  return (
    <button className={`to-bottom to-mention${raised ? " is-raised" : ""}`} onClick={go} aria-label={`Go to the next message that mentions you, ${mentions.length} left`}>
      <AtSign size={21} strokeWidth={1.7} />
      <span className="to-bottom-badge">{mentions.length > 99 ? "99+" : mentions.length}</span>
    </button>
  );
}

export function MessageList({ conversation, listId, emptyState }: { conversation: ConversationView; listId: string; emptyState: ReactNode }) {
  const list = useApp((state) => state.lists[listId]);
  const loadOlder = useApp((state) => state.loadOlder);
  const returnToLatest = useApp((state) => state.returnToLatest);
  const jumpTarget = useApp((state) => state.jumpTarget);
  const windowFocused = useApp((state) => state.windowFocused);
  const session = useApp((state) => state.session);
  const selfId = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId]?.self?.userId : undefined)) ?? "";
  const virtuoso = useRef<VirtuosoHandle>(null);
  // Whether the list stays on the newest message. Only scrolling away lets go of it.
  const stuck = useRef(!savedPositions.has(listId));
  const scrolledByHand = useRef(false);
  const [atBottom, setAtBottom] = useState(stuck.current);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const anchor = useRef<Place | null>(null);
  const heldBack = useRef<number | null>(null);
  const [released, setReleased] = useState(false);

  const items = list?.items ?? [];
  const isGroup = conversation.kind === "group";
  const isAdmin = conversation.members.find((member) => member.userId === selfId)?.role === "admin";
  const readUpTo = useMemo(
    () => Object.entries(conversation.readBy).reduce((highest, [id, seq]) => (id === selfId ? highest : Math.max(highest, seq)), 0),
    [conversation.readBy, selfId],
  );

  // Only messages arriving at the end while the chat is open animate in, so older
  // pages, a jump or going back to the newest messages never replay anything.
  const seen = useRef(new Set<string>());
  const fresh = useRef(new Set<string>());
  const primed = useRef(false);
  useMemo(() => {
    const added: string[] = [];
    for (let i = items.length - 1; i >= 0 && !seen.current.has(items[i]!.id); i--) added.push(items[i]!.id);
    const replaced = seen.current.size > 0 && added.length === items.length;
    if (primed.current && !replaced) {
      for (const id of added) {
        fresh.current.add(id);
        setTimeout(() => fresh.current.delete(id), 400);
      }
    }
    for (const item of items) seen.current.add(item.id);
    primed.current = !!list && (primed.current || list.loaded);
  }, [items, list]);

  // A chat with unread messages opens at the first, as Telegram's does, under a line
  // that stays there until the chat is left. Decided once, from what's loaded then.
  const detached = !!list?.detached;
  const unreadLine = useRef<string | null | undefined>(undefined);
  const openAtUnread = useRef(false);
  if (unreadLine.current === undefined && (items.length > 0 || list?.loaded)) {
    const first = conversation.unread > 0 && !detached ? items.find((item) => isUnread(item, conversation.ownRead, selfId)) : undefined;
    unreadLine.current = first?.id ?? null;
    openAtUnread.current = !!first;
  }

  // A jump shows a window of older messages, and leaving one comes back at the newest.
  useLayoutEffect(() => {
    if (!detached) return;
    stuck.current = false;
    anchor.current = null;
    return () => {
      savedPositions.delete(listId);
      stuck.current = true;
      scrolledByHand.current = false;
      setAtBottom(true);
      heldBack.current = null;
      setReleased(false);
    };
  }, [detached, listId]);

  // A chat opens with only the rows that fit on screen, so they can be drawn in the
  // very first frame, where Virtuoso would hide the list while it finds its place.
  // The older ones join once someone scrolls towards them, as Virtuoso moving the
  // list to make room for them would otherwise compete with keeping it in place.
  if (heldBack.current === null && items.length > 0 && !detached) {
    // The first unread message goes at the top as a saved place would, with enough
    // before it to fill the screen when only a few come after it.
    const unreadIndex = openAtUnread.current ? items.findIndex((item) => item.id === unreadLine.current) : -1;
    openAtUnread.current = false;
    const place = unreadIndex >= 0 ? { id: unreadLine.current!, offset: 0 } : savedPositions.get(listId);
    const index = place ? items.findIndex((item) => item.id === place.id) : -1;
    const fill = Math.max(0, items.length - firstRows());
    heldBack.current = index < 0 ? fill : unreadIndex >= 0 ? Math.min(index, fill) : index;
    anchor.current = index >= 0 ? { ...place! } : null;
    if (unreadIndex >= 0 && stuck.current) {
      stuck.current = false;
      setAtBottom(false);
    }
    if (place && index < 0) {
      stuck.current = true;
      setAtBottom(true);
    }
  }
  const start = released || detached ? 0 : Math.min(heldBack.current ?? 0, Math.max(0, items.length - 1));
  const shown = useMemo(() => (start > 0 ? items.slice(start) : items), [items, start]);
  const loadMore = useRef<() => void>(() => undefined);
  loadMore.current = () => {
    if (start > 0) setReleased(true);
    else if (list?.hasMore && !list.detached) void loadOlder(listId);
  };

  // The list corrects itself on the way, which isn't anyone scrolling away again.
  const goToNewest = () => {
    stuck.current = true;
    scrolledByHand.current = false;
    setAtBottom(true);
    virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  };

  // The newest message glides in when the list is on it, and sending always brings you to it.
  const lastItem = items[items.length - 1];
  const lastItemId = lastItem?.id;
  const glideFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!lastItem || !fresh.current.has(lastItem.id)) return;
    if (stuck.current) {
      glideFor.current = lastItem.id;
    } else if (lastItem.senderId === selfId) {
      goToNewest();
    }
  }, [lastItemId]);

  // Remember the position when leaving a chat that's scrolled up.
  useLayoutEffect(
    () => () => {
      const place = stuck.current || !scroller.current ? null : placeIn(scroller.current);
      if (place) savedPositions.set(listId, place);
      else savedPositions.delete(listId);
    },
    [listId],
  );

  // Read as far as has been on screen in a focused window, which at the newest message is everything.
  const newestSeq = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.seq !== null && !item.id.startsWith("sys-")) return item.seq;
    }
    return 0;
  }, [items]);
  const [onScreen, setOnScreen] = useState(0);
  const reading = useRef({ want: 0, busy: false });
  useEffect(() => {
    const groupId = conversation.groupId;
    const upTo = atBottom && !detached ? newestSeq : onScreen;
    if (!windowFocused || !groupId || upTo <= conversation.ownRead) return;
    // One position at a time, as the server keeps the last it gets. While scrolling,
    // the furthest so far goes once the one before it is done.
    const state = reading.current;
    state.want = Math.max(state.want, upTo);
    if (state.busy) return;
    state.busy = true;
    const remote = session();
    const send = () => {
      const seq = state.want;
      void remote
        .markRead(groupId, seq)
        .catch(() => undefined)
        .finally(() => {
          if (state.want > seq) setTimeout(send, READ_EVERY_MS);
          else state.busy = false;
        });
    };
    send();
  }, [atBottom, detached, windowFocused, newestSeq, onScreen, conversation.ownRead, conversation.groupId, session]);

  // Whenever anything changes size (a new message, a picture loading, the message
  // box growing, a reply bar opening) this runs before the frame is painted. On the
  // newest message it stays exactly at the end, so nothing shows out of place and
  // the list can't stop short. Scrolled up, the bottom edge of the list stays put.
  const stopWatching = useRef<(() => void) | null>(null);
  const watchScroller = useCallback((element: HTMLElement | Window | null) => {
    stopWatching.current?.();
    stopWatching.current = null;
    scroller.current = element instanceof HTMLElement ? element : null;
    if (!(element instanceof HTMLElement)) return;
    const list = element.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
    let glide: Animation | null = null;
    let height = element.clientHeight;
    let windowHeight = window.innerHeight;
    let lastTop = element.scrollTop;
    // Where the list last left itself, by moving or by the browser cutting it short as
    // the list grew taller. That scroll event comes a frame later, when a new message
    // may already be below, and would otherwise look like scrolling away from it.
    let ownTop: number | null = null;

    // Rows stay where they were on screen and glide to their new place from there,
    // after `wait` milliseconds if asked.
    const startGlide = (travel: number, wait = 0) => {
      if (!list || travel === 0 || motionReduced()) return;
      const from = glideOffset(list, glide) + travel;
      glide?.cancel();
      glide = list.animate({ transform: [`translateY(${from}px)`, "none"] }, { duration: 180, delay: wait, fill: "backwards", easing: "cubic-bezier(0.2, 0, 0, 1)" });
    };
    // A glide counts towards the scroll height, so during one the end comes from the layout.
    const contentEnd = () => {
      const last = list?.parentElement?.lastElementChild;
      return glide?.playState === "running" && last instanceof HTMLElement ? last.offsetTop + last.offsetHeight : element.scrollHeight;
    };
    let seeing = 0;
    const noteSeen = () => {
      cancelAnimationFrame(seeing);
      setOnScreen(seenIn(element));
    };
    const settle = () => {
      const grownBy = element.clientHeight - height;
      const windowResized = window.innerHeight !== windowHeight;
      height = element.clientHeight;
      windowHeight = window.innerHeight;
      if (!stuck.current) {
        // Coming back to a chat, its place is restored before the first frame.
        const place = anchor.current;
        anchor.current = null;
        const row = place && element.querySelector(`[data-id="${CSS.escape(place.id)}"]`);
        // Only an actual change is written: setting the position, even to where it
        // is, stops a scroll that's still gliding, so the wheel would barely move it.
        const by = row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top + place.offset : -grownBy;
        if (by) element.scrollTop += by;
        ownTop = element.scrollTop;
        // With too little after it to reach the top, the place is at the newest message.
        if (row && contentEnd() - element.clientHeight - element.scrollTop <= 1) {
          stuck.current = true;
          setAtBottom(true);
        }
        noteSeen();
        return;
      }
      const end = contentEnd() - element.clientHeight;
      if (element.scrollTop !== end) element.scrollTop = end;
      ownTop = element.scrollTop;
      const added = glideFor.current && fresh.current.has(glideFor.current) ? (list?.lastElementChild?.getBoundingClientRect().height ?? 0) : 0;
      glideFor.current = null;
      const travel = added - (windowResized ? 0 : grownBy);
      // The message box empties a frame or two before the sent message comes from the
      // core. Waiting that long to move rows down lets the two meet, so rows only go up.
      startGlide(travel, travel < 0 && !added ? SEND_WAIT_MS : 0);
      // With no way to scroll towards them, older messages come in by themselves.
      if (element.scrollHeight <= element.clientHeight) loadMore.current();
    };
    const onScroll = () => {
      cancelAnimationFrame(seeing);
      seeing = requestAnimationFrame(noteSeen);
      const top = element.scrollTop;
      const own = ownTop !== null && Math.abs(top - ownTop) < 1;
      ownTop = null;
      if (scrolledByHand.current && !own) {
        const away = contentEnd() - element.clientHeight - top;
        if (away <= AT_BOTTOM_PX) stuck.current = true;
        else if (top < lastTop) stuck.current = false;
        setAtBottom(stuck.current);
        if (top < lastTop && top < LOAD_AHEAD_PX && (!stuck.current || top < 1)) loadMore.current();
      }
      lastTop = top;
    };
    const onHand = () => {
      scrolledByHand.current = true;
    };

    const observer = new ResizeObserver(settle);
    observer.observe(element);
    if (list) observer.observe(list);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
    element.addEventListener("scroll", onScroll, { passive: true });
    for (const input of inputs) element.addEventListener(input, onHand, { passive: true });
    stopWatching.current = () => {
      observer.disconnect();
      glide?.cancel();
      cancelAnimationFrame(seeing);
      element.removeEventListener("scroll", onScroll);
      for (const input of inputs) element.removeEventListener(input, onHand);
    };
  }, []);
  useEffect(() => () => stopWatching.current?.(), []);

  // Jump to a reply, a pin or a search result.
  useEffect(() => {
    if (!jumpTarget || jumpTarget.groupId !== listId) return;
    const index = items.findIndex((item) => item.id === jumpTarget.messageId);
    if (index < 0) return;
    setReleased(true);
    const timer = setTimeout(() => {
      // Only this once: coming back to the chat later isn't another jump.
      useApp.setState({ jumpTarget: null });
      scrolledByHand.current = true;
      virtuoso.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
      // Rows measured on the way there can move it, so it's put in the middle again once they're drawn.
      const id = jumpTarget.messageId;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const element = scroller.current;
          const row = element?.querySelector(`[data-id="${CSS.escape(id)}"]`);
          if (!element || !row) return;
          const view = element.getBoundingClientRect();
          const box = row.getBoundingClientRect();
          const by = Math.round(box.top + box.height / 2 - (view.top + view.height / 2));
          if (by) element.scrollTop += by;
        }),
      );
      setHighlightId(jumpTarget.messageId);
      setTimeout(() => setHighlightId(null), 1200);
    }, 30);
    return () => clearTimeout(timer);
  }, [jumpTarget?.nonce]);

  const scrollToBottom = () => {
    if (list?.detached) void returnToLatest(listId);
    else goToNewest();
  };

  const firstIndex = list?.firstIndex ?? 0;
  const hasMore = !!list?.hasMore;
  const itemContent = useCallback(
    (index: number, message: MessageView) => {
      const position = index - firstIndex;
      const previous = items[position - 1];
      const next = items[position + 1];
      // With older messages still to load, the day may well have started before this one.
      const showDay = previous ? !sameDay(previous.createdAt, message.createdAt) : !hasMore;
      // And it most likely follows on from them, so it keeps its size when they arrive.
      const grouped = !showDay && (previous ? continues(previous, message) : hasMore && !detached);
      return (
        <div className="list-item" data-id={message.id} data-seq={message.seq !== null && !message.id.startsWith("sys-") ? message.seq : undefined}>
          {message.id === unreadLine.current && (
            <div className="unread-sep">
              <span>Unread messages</span>
            </div>
          )}
          {showDay && (
            <div className="day-sep">
              <span>{formatDaySeparator(message.createdAt)}</span>
            </div>
          )}
          <ErrorBoundary key={message.id} fallback={<UndisplayableMessage />}>
            <MessageItem
              message={message}
              listId={listId}
              isGroup={isGroup}
              isGroupAdmin={isAdmin}
              readUpTo={readUpTo}
              grouped={grouped}
              lastInGroup={!continues(message, next)}
              fresh={fresh.current.has(message.id)}
              highlighted={highlightId === message.id}
              own={message.senderId === selfId}
            />
          </ErrorBoundary>
        </div>
      );
    },
    [items, firstIndex, hasMore, detached, listId, isGroup, isAdmin, readUpTo, highlightId, selfId],
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

  return (
    <div className="message-list">
      <Virtuoso
        // The list stays through a first message's move to its new group, as this is one chat.
        key={list.detached ? "detached" : "latest"}
        ref={virtuoso}
        scrollerRef={watchScroller}
        data={shown}
        firstItemIndex={list.firstIndex + start}
        initialItemCount={list.detached ? 0 : firstRows()}
        initialTopMostItemIndex={list.detached ? { index: "LAST", align: "end" } : undefined}
        computeItemKey={(_index, message) => message.id}
        alignToBottom
        increaseViewportBy={{ top: DRAWN_AHEAD_PX, bottom: DRAWN_AHEAD_PX / 2 }}
        // Rows measured above the screen while scrolling up are made up for before
        // the frame is drawn, rather than a frame later, which made the list jitter.
        skipAnimationFrameInResizeObserver
        itemContent={itemContent}
        context={{ loading: list.loading }}
        components={{ Header, Footer: ListFooter }}
        className="virtuoso"
      />
      {conversation.groupId && (
        <MentionButton key={listId} conversation={conversation} groupId={conversation.groupId} hidden={atBottom && !list.detached} raised={!atBottom || list.detached} />
      )}
      {(!atBottom || list.detached) && (
        <button className="to-bottom" onClick={scrollToBottom} aria-label="Go to the newest messages">
          <ChevronDown size={30} strokeWidth={1.5} />
          {unreadBelow > 0 && <span className="to-bottom-badge">{unreadBelow > 99 ? "99+" : unreadBelow}</span>}
        </button>
      )}
    </div>
  );
}
