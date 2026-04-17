import { useEffect, useRef, useCallback, useState } from "react";
import { ChatMember } from "@/types/serverTypes";
import { Message } from "@/hooks/useMessages";
import { cn } from "@/lib/utils";
import { Check, CheckCheck, Loader2 } from "lucide-react";

type MessageStatus = "pending" | "sent" | "read";

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function messageKey(msg: Message): string {
  return msg.id != null ? String(msg.id) : `local-${msg.localId}`;
}

function sameGroup(a: Message, b: Message): boolean {
  return a.senderId === b.senderId && b.sentAt - a.sentAt < 5 * 60 * 1000;
}

function groupMessages(messages: Message[]) {
  return messages.map((msg, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    return {
      ...msg,
      isFirst: !prev || !sameGroup(prev, msg),
      isLast: !next || !sameGroup(msg, next),
      showDivider: i > 0 && (!prev || msg.sentAt - prev.sentAt > 5 * 60 * 1000),
    };
  });
}

interface ChatMessagesProps {
  member: ChatMember;
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  sharedSecret: string | null;
}

export function ChatMessages({
  member,
  messages,
  loading,
  hasMore,
  fetchMore,
  sharedSecret,
}: ChatMessagesProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);

  const [decrypted, setDecrypted] = useState<Map<string, string>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setDecrypted(new Map());
    inFlightRef.current.clear();
  }, [member.id]);

  useEffect(() => {
    if (!sharedSecret) return;

    const toDecrypt = messages.filter((m) => {
      if (m.plaintext) return false;
      const key = messageKey(m);
      return !decrypted.has(key) && !inFlightRef.current.has(key);
    });

    if (!toDecrypt.length) return;

    toDecrypt.forEach((m) => inFlightRef.current.add(messageKey(m)));

    Promise.all(
      toDecrypt.map(async (m) => {
        try {
          const text = await window.security.decrypt(sharedSecret, {
            ciphertext: m.cipherText,
            iv: m.iv,
            authTag: m.authTag,
          });
          return [messageKey(m), text] as const;
        } catch {
          return [messageKey(m), "[decryption failed]"] as const;
        }
      }),
    ).then((results) => {
      results.forEach(([key]) => inFlightRef.current.delete(key));
      setDecrypted((prev) => {
        const next = new Map(prev);
        for (const [key, text] of results) next.set(key, text);
        return next;
      });
    });
  }, [messages, sharedSecret]);

  const needsInitialScrollRef = useRef(true);
  useEffect(() => {
    needsInitialScrollRef.current = true;
  }, [member.id]);

  const prevLastKeyRef = useRef<string | null>(null);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (messages.length === 0) {
      prevLastKeyRef.current = null;
      prevLengthRef.current = 0;
      return;
    }

    const newLastKey = messageKey(messages[messages.length - 1]);
    const newLength = messages.length;
    const oldLastKey = prevLastKeyRef.current;
    const oldLength = prevLengthRef.current;

    prevLastKeyRef.current = newLastKey;
    prevLengthRef.current = newLength;

    if (needsInitialScrollRef.current && !loading) {
      needsInitialScrollRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      return;
    }

    if (
      oldLastKey !== null &&
      newLastKey !== oldLastKey &&
      newLength > oldLength
    ) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages, loading]);

  const restoreScrollRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (restoreScrollRef.current) {
      restoreScrollRef.current();
      restoreScrollRef.current = null;
    }
  }, [messages.length]);

  const handleFetchMore = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || !hasMore || loading) return;

    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;

    restoreScrollRef.current = () => {
      if (container) {
        container.scrollTop =
          container.scrollHeight - prevScrollHeight + prevScrollTop;
      }
    };

    fetchMore();
  }, [fetchMore, hasMore, loading]);

  useEffect(() => {
    const root = scrollContainerRef.current;
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

  const getText = (msg: Message): string => {
    if (msg.plaintext) return msg.plaintext;
    return decrypted.get(messageKey(msg)) ?? "…";
  };

  const getStatus = (msg: Message): MessageStatus => {
    if (msg.pending) return "pending";
    if (msg.readAt) return "read";
    return "sent";
  };

  const grouped = groupMessages(messages);

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]"
    >
      <div className="px-4 py-4 space-y-0.5">
        <div ref={topSentinelRef} />

        {loading && (
          <div className="flex justify-center py-4">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {messages.length > 0 && (
          <div className="flex items-center gap-3 py-3">
            <div className="flex-1 h-px bg-border/40" />
            <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
              {new Date(messages[0].sentAt).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
              })}
            </span>
            <div className="flex-1 h-px bg-border/40" />
          </div>
        )}

        {grouped.map((msg) => (
          <div key={messageKey(msg)}>
            {msg.showDivider && (
              <div className="flex items-center gap-3 py-3 mt-2">
                <div className="flex-1 h-px bg-border/40" />
                <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                  {formatTime(msg.sentAt)}
                </span>
                <div className="flex-1 h-px bg-border/40" />
              </div>
            )}
            <div
              className={cn(
                "flex",
                msg.isOwn ? "justify-end" : "justify-start",
                msg.isFirst ? "mt-3" : "mt-0.5",
              )}
            >
              <div
                className={cn(
                  "relative max-w-[95%] lg:max-w-[65%] px-3.5 py-2 text-sm leading-relaxed wrap-break-word",
                  msg.isOwn
                    ? cn(
                        "bg-primary text-primary-foreground",
                        msg.isFirst && msg.isLast && "rounded-2xl",
                        msg.isFirst &&
                          !msg.isLast &&
                          "rounded-t-2xl rounded-bl-2xl rounded-br-md",
                        !msg.isFirst &&
                          msg.isLast &&
                          "rounded-b-2xl rounded-tl-2xl rounded-tr-md",
                        !msg.isFirst &&
                          !msg.isLast &&
                          "rounded-l-2xl rounded-r-md",
                      )
                    : cn(
                        "bg-muted/70 dark:bg-muted/40 text-foreground",
                        msg.isFirst && msg.isLast && "rounded-2xl",
                        msg.isFirst &&
                          !msg.isLast &&
                          "rounded-t-2xl rounded-br-2xl rounded-bl-md",
                        !msg.isFirst &&
                          msg.isLast &&
                          "rounded-b-2xl rounded-tr-2xl rounded-tl-md",
                        !msg.isFirst &&
                          !msg.isLast &&
                          "rounded-r-2xl rounded-l-md",
                      ),
                )}
              >
                <span>{getText(msg)}</span>
                <span
                  aria-hidden
                  className="inline-block align-bottom ml-1.5 opacity-0 pointer-events-none select-none text-[10px]"
                >
                  {formatTime(msg.sentAt)}
                  {msg.isOwn && "\u00a0\u00a0\u2713"}
                </span>
                <span
                  className={cn(
                    "absolute bottom-2 right-3.5 flex items-center gap-0.5 text-[10px]",
                    msg.isOwn
                      ? "text-primary-foreground/60"
                      : "text-muted-foreground/50",
                  )}
                >
                  {formatTime(msg.sentAt)}
                  {msg.isOwn && getStatus(msg) === "pending" && (
                    <Loader2 className="size-3 shrink-0 animate-spin" />
                  )}
                  {msg.isOwn && getStatus(msg) === "sent" && (
                    <Check className="size-3 shrink-0" strokeWidth={2.5} />
                  )}
                  {msg.isOwn && getStatus(msg) === "read" && (
                    <CheckCheck className="size-3 shrink-0" strokeWidth={2.5} />
                  )}
                </span>
              </div>
            </div>
          </div>
        ))}

        <div ref={bottomRef} className="pt-1" />
      </div>
    </div>
  );
}
