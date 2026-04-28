import { useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { Message } from "@/types/serverTypes";

export function useScrollBehavior(
  messages: Message[],
  memberId: string,
  hasMore: boolean,
  loading: boolean,
  fetchMore: () => void,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const restoreScrollRef = useRef<(() => void) | null>(null);
  const pendingJumpIdRef = useRef<number | null>(null);

  // Keep fresh refs so callbacks always have current values
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const fetchMoreRef = useRef(fetchMore);
  fetchMoreRef.current = fetchMore;

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
  }, []);

  const scrollToBottomIfPinned = useCallback(() => {
    if (isPinnedRef.current) scrollToBottom(true);
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    isPinnedRef.current = true;
    prevMsgCountRef.current = 0;
  }, [memberId]);

  useEffect(() => {
    isPinnedRef.current = true;
    pendingJumpIdRef.current = null;
    scrollToBottom(false);
  }, [memberId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      isPinnedRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (isPinnedRef.current && pendingJumpIdRef.current === null)
        scrollToBottom(true);
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const prev = prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    const isInitial = prev === 0;
    if (isInitial) {
      scrollToBottom(false);
    } else if (
      messages.length > prev &&
      isPinnedRef.current &&
      pendingJumpIdRef.current === null
    ) {
      scrollToBottom(true);
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    // While a pending jump is in flight the jump effect owns the scroll position.
    if (pendingJumpIdRef.current !== null) return;
    if (restoreScrollRef.current) {
      restoreScrollRef.current();
      restoreScrollRef.current = null;
    }
  }, [messages.length]);

  // After each messages update, try to resolve a pending jump
  useEffect(() => {
    if (pendingJumpIdRef.current === null) return;
    const el = scrollRef.current;
    if (!el) return;
    const messageId = pendingJumpIdRef.current;
    const target = el.querySelector(
      `[data-message-id="${messageId}"]`,
    ) as HTMLElement | null;

    if (target) {
      pendingJumpIdRef.current = null;
      restoreScrollRef.current = null; // discard any queued restore
      // Mark as programmatic so the scroll event doesn't flip isPinnedRef.
      programmaticScrollRef.current = true;
      isPinnedRef.current = false;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("reply-highlight");
      setTimeout(() => target.classList.remove("reply-highlight"), 1500);
      return;
    }

    // Not in DOM yet — fetch another page if possible
    if (hasMoreRef.current && !loadingRef.current) {
      const prevScrollHeight = el.scrollHeight;
      const prevScrollTop = el.scrollTop;
      restoreScrollRef.current = () => {
        if (el) {
          el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop;
        }
      };
      fetchMoreRef.current();
    } else if (!hasMoreRef.current) {
      // No more pages — message not found, give up
      pendingJumpIdRef.current = null;
    }
  }, [messages]);

  const handleFetchMore = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || loading) return;

    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop = el.scrollTop;

    restoreScrollRef.current = () => {
      if (el) {
        el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop;
      }
    };

    fetchMore();
  }, [fetchMore, hasMore, loading]);

  const handleFetchMoreRef = useRef(handleFetchMore);
  useEffect(() => {
    handleFetchMoreRef.current = handleFetchMore;
  });

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) handleFetchMoreRef.current();
      },
      { root, rootMargin: "150px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const scrollToMessageById = useCallback((messageId: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector(
      `[data-message-id="${messageId}"]`,
    ) as HTMLElement | null;

    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("reply-highlight");
      setTimeout(() => target.classList.remove("reply-highlight"), 1500);
      return;
    }

    if (!hasMoreRef.current || loadingRef.current) return;
    isPinnedRef.current = false;
    pendingJumpIdRef.current = messageId;
    const prevScrollHeight = el.scrollHeight;
    const prevScrollTop = el.scrollTop;
    restoreScrollRef.current = () => {
      if (el) {
        el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop;
      }
    };
    fetchMoreRef.current();
  }, []);

  return {
    scrollRef,
    contentRef,
    topSentinelRef,
    scrollToBottomIfPinned,
    scrollToMessageById,
  };
}
