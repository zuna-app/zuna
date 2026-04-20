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

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  const scrollToBottomIfPinned = useCallback(() => {
    if (isPinnedRef.current) scrollToBottom();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    isPinnedRef.current = true;
    prevMsgCountRef.current = 0;
  }, [memberId]);

  useEffect(() => {
    isPinnedRef.current = true;
    scrollToBottom();
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
      if (isPinnedRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const prev = prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    const isInitial = prev === 0;
    if (isInitial || (messages.length > prev && isPinnedRef.current)) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (restoreScrollRef.current) {
      restoreScrollRef.current();
      restoreScrollRef.current = null;
    }
  }, [messages.length]);

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

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) handleFetchMore();
      },
      { root, rootMargin: "150px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleFetchMore]);

  return { scrollRef, contentRef, topSentinelRef, scrollToBottomIfPinned };
}
