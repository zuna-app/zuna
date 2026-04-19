import {
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useState,
} from "react";
import { ChatMember } from "@/types/serverTypes";
import { Message } from "@/hooks/chat/useMessages";
import { cn } from "@/lib/utils";
import { Check, CheckCheck, Loader2 } from "lucide-react";
import { DelayedSpinner } from "../ui/delayed-spinner";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { MessageOgPreview } from "./og-preview";
import { extractFirstUrl } from "@/hooks/ui/useOgPreview";

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
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(false);

  const [decrypted, setDecrypted] = useState<Map<string, string>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  const lastSharedSecretRef = useRef<string | null>(null);

  useEffect(() => {
    setDecrypted(new Map());
    inFlightRef.current.clear();
    lastSharedSecretRef.current = null;
  }, [member.id]);

  useEffect(() => {
    if (!sharedSecret) return;

    const secretChanged = sharedSecret !== lastSharedSecretRef.current;
    if (secretChanged) {
      lastSharedSecretRef.current = sharedSecret;
      inFlightRef.current.clear();
      setDecrypted(new Map());
    }

    const toDecrypt = messages.filter((m) => {
      if (m.plaintext) return false;
      const key = messageKey(m);
      if (inFlightRef.current.has(key)) return false;
      if (!secretChanged && decrypted.has(key)) return false;
      return true;
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

      const container = scrollContainerRef.current;
      const isNearBottom = container
        ? container.scrollHeight -
            container.scrollTop -
            container.clientHeight <
          100
        : false;

      setDecrypted((prev) => {
        const next = new Map(prev);
        for (const [key, text] of results) next.set(key, text);
        return next;
      });

      if (isNearBottom) {
        requestAnimationFrame(() => {
          const c = scrollContainerRef.current;
          if (c) c.scrollTop = c.scrollHeight;
        });
      }
    });
  }, [messages, sharedSecret]);

  // caly ten handler od scrollowania trzeba wywalic i przepisac bo to jest tragedia jakas
  // i zreszta ledwo to dziala
  const needsInitialScrollRef = useRef(true);
  useEffect(() => {
    needsInitialScrollRef.current = true;
    pinnedToBottomRef.current = false;
  }, [member.id]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      pinnedToBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        50;
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) {
        const container = scrollContainerRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const prevLastKeyRef = useRef<string | null>(null);
  const prevLengthRef = useRef(0);

  useLayoutEffect(() => {
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
      pinnedToBottomRef.current = true;
      return;
    }

    if (
      oldLastKey !== null &&
      newLastKey !== oldLastKey &&
      newLength > oldLength
    ) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
      pinnedToBottomRef.current = true;
    }
  }, [messages, loading]);

  const scrollToBottomIfPinned = useCallback(() => {
    if (!pinnedToBottomRef.current) return;
    const c = scrollContainerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, []);

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

  const { emoteMap } = useEmotes();

  const URL_SPLIT_RE = /(https?:\/\/[^\s<>"']+)/i;

  const renderMessage = (text: string) => {
    // Split on URLs first, then on emote tokens within non-URL segments
    const urlParts = text.split(URL_SPLIT_RE);

    return urlParts.map((part, i) => {
      if (URL_SPLIT_RE.test(part)) {
        const clean = part.replace(/[.,;:!?)'"\]]+$/, "");
        const trailing = part.slice(clean.length);
        return (
          <span key={i}>
            <button
              type="button"
              onClick={() => window.shell.openExternal(clean)}
              className="underline underline-offset-2 opacity-90 hover:opacity-100 cursor-pointer break-all"
            >
              {clean}
            </button>
            {trailing}
          </span>
        );
      }

      // Non-URL: split further for emotes
      const emoteParts = part.split(/(\b[a-zA-Z0-9_]+\b)/g);
      return emoteParts.map((ep, j) => {
        const src = emoteMap.get(ep);
        if (src) {
          return (
            <img
              key={`${i}-${j}`}
              src={src}
              alt={ep}
              className="inline-block align-middle h-[2em]"
            />
          );
        }
        return <span key={`${i}-${j}`}>{ep}</span>;
      });
    });
  };

  const getText = (msg: Message): React.ReactNode => {
    const message = !msg.plaintext
      ? (decrypted.get(messageKey(msg)) ?? "…")
      : msg.plaintext;

    return <>{renderMessage(message)}</>;
  };

  const getStatus = (msg: Message): MessageStatus => {
    if (msg.pending) return "pending";
    if (msg.readAt) return "read";
    return "sent";
  };

  const getPlaintextStr = (msg: Message): string => {
    if (msg.plaintext) return msg.plaintext;
    return decrypted.get(messageKey(msg)) ?? "";
  };

  const grouped = groupMessages(messages);

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]"
    >
      <div ref={contentRef} className="px-4 py-4 space-y-0.5">
        <div ref={topSentinelRef} />

        {loading && (
          <div className="flex justify-center py-4">
            <DelayedSpinner />
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
                "flex flex-col",
                msg.isOwn ? "items-end" : "items-start",
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
              {(() => {
                const plaintext = getPlaintextStr(msg);
                const url = plaintext ? extractFirstUrl(plaintext) : null;
                return url ? (
                  <div className="max-w-[75%] lg:max-w-[45%] w-full">
                    <MessageOgPreview
                      url={url}
                      isOwn={msg.isOwn}
                      onLoad={scrollToBottomIfPinned}
                    />
                  </div>
                ) : null;
              })()}
            </div>
          </div>
        ))}

        <div ref={bottomRef} className="pt-1" />
      </div>
    </div>
  );
}
