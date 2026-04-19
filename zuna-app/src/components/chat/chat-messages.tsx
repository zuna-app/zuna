import {
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useState,
} from "react";
import { ChatMember, Message } from "@/types/serverTypes";
import { Server } from "@/types/serverTypes";
import { cn } from "@/lib/utils";
import {
  Check,
  CheckCheck,
  Loader2,
  FileIcon,
  Download,
  ImageIcon,
} from "lucide-react";
import { DelayedSpinner } from "../ui/delayed-spinner";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { MessageOgPreview } from "./og-preview";
import { extractFirstUrl } from "@/hooks/ui/useOgPreview";
import { useAttachmentDownload } from "@/hooks/chat/useAttachmentDownload";

type MessageStatus = "pending" | "sent" | "read";

interface AttachmentMeta {
  name: string;
  size: number;
  mimeType: string;
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  server: Server;
  member: ChatMember;
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  sharedSecret: string | null;
}

function isImageMime(mime: string) {
  return mime.startsWith("image/");
}

interface AttachmentCardProps {
  server: Server;
  attachmentId: string;
  senderIdentityKey: string;
  meta: AttachmentMeta | null;
  isOwn: boolean;
  textContent: React.ReactNode;
  sentAt: number;
  status: MessageStatus;
}

function AttachmentCard({
  server,
  attachmentId,
  senderIdentityKey,
  meta,
  isOwn,
  textContent,
  sentAt,
  status,
}: AttachmentCardProps) {
  const mimeType = meta?.mimeType ?? "";
  const isImage = isImageMime(mimeType);

  const { url, loading, error, download, saveFile } = useAttachmentDownload(
    server,
    attachmentId,
    senderIdentityKey,
    mimeType,
    isImage, // auto-fetch images
  );

  return (
    <>
      {isImage ? (
        <div className="relative group">
          {url ? (
            <img
              src={url}
              alt={meta?.name ?? "Image"}
              className="w-full max-h-72 object-cover cursor-pointer block"
              onClick={() => window.shell.openExternal(url)}
            />
          ) : error ? (
            <div
              className={cn(
                "flex flex-col items-center gap-1.5 p-4 text-[11px] opacity-60 min-w-40 min-h-28 justify-center",
                isOwn ? "bg-primary-foreground/10" : "bg-muted-foreground/10",
              )}
            >
              <ImageIcon className="size-5" />
              <span>Failed to load</span>
              <button
                type="button"
                onClick={download}
                className="underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          ) : (
            <div
              className={cn(
                "flex flex-col items-center gap-2 p-6 opacity-50 min-h-28 justify-center",
                isOwn ? "bg-primary-foreground/10" : "bg-muted-foreground/10",
              )}
            >
              <Loader2 className="size-5 animate-spin" />
              <span className="text-[10px]">Loading…</span>
            </div>
          )}
          {url && (
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-end gap-1 px-2.5 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-linear-to-t from-black/55 to-transparent pointer-events-none select-none">
              <span className="text-[10px] text-white/90">
                {formatTime(sentAt)}
              </span>
              {isOwn && status === "pending" && (
                <Loader2 className="size-3 shrink-0 text-white/80 animate-spin" />
              )}
              {isOwn && status === "sent" && (
                <Check
                  className="size-3 shrink-0 text-white/80"
                  strokeWidth={2.5}
                />
              )}
              {isOwn && status === "read" && (
                <CheckCheck
                  className="size-3 shrink-0 text-white/80"
                  strokeWidth={2.5}
                />
              )}
            </div>
          )}
          {textContent && (
            <div
              className={cn(
                "px-3.5 py-2 border-t text-sm",
                isOwn ? "border-primary-foreground/20" : "border-border/40",
              )}
            >
              {textContent}
            </div>
          )}
        </div>
      ) : (
        <div className="px-3.5 py-2">
          <div className="flex items-center gap-2.5 min-w-40 pb-0.5">
            <div
              className={cn(
                "flex items-center justify-center size-8 shrink-0 rounded-lg",
                isOwn ? "bg-primary-foreground/15" : "bg-muted-foreground/10",
              )}
            >
              <FileIcon className="size-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate leading-tight">
                {meta?.name ?? "Attachment"}
              </p>
              {meta && meta.size > 0 && (
                <p className="text-[10px] opacity-60 mt-px">
                  {formatFileSize(meta.size)}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => saveFile(meta?.name ?? "file")}
              disabled={loading}
              className={cn(
                "shrink-0 rounded-lg p-1.5 transition-colors",
                isOwn
                  ? "hover:bg-primary-foreground/15 text-primary-foreground/70 hover:text-primary-foreground"
                  : "hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground",
                loading && "opacity-40 cursor-not-allowed",
              )}
              title={loading ? "Downloading…" : "Download"}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
            </button>
          </div>
          {error && <p className="text-[10px] opacity-60 mt-0.5">{error}</p>}
          {textContent && (
            <div
              className={cn(
                "mt-1.5 pt-1.5 border-t",
                isOwn ? "border-primary-foreground/20" : "border-border/40",
              )}
            >
              {textContent}
            </div>
          )}
          <div
            className={cn(
              "flex items-center justify-end gap-0.5 mt-1 text-[10px]",
              isOwn ? "text-primary-foreground/60" : "text-muted-foreground/50",
            )}
          >
            {formatTime(sentAt)}
            {isOwn && status === "pending" && (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            )}
            {isOwn && status === "sent" && (
              <Check className="size-3 shrink-0" strokeWidth={2.5} />
            )}
            {isOwn && status === "read" && (
              <CheckCheck className="size-3 shrink-0" strokeWidth={2.5} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function ChatMessages({
  server,
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

  const [decryptedMeta, setDecryptedMeta] = useState<
    Map<string, AttachmentMeta>
  >(new Map());
  const metaInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setDecrypted(new Map());
    setDecryptedMeta(new Map());
    inFlightRef.current.clear();
    metaInFlightRef.current.clear();
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

  useEffect(() => {
    if (!sharedSecret) return;

    const toDecryptMeta = messages.filter((m) => {
      if (
        !m.attachmentMetadata ||
        !m.attachmentMetadataIv ||
        !m.attachmentMetadataAuthTag
      )
        return false;
      if (m.attachmentFilename) return false; // already have plaintext name
      const key = messageKey(m);
      if (metaInFlightRef.current.has(key)) return false;
      if (decryptedMeta.has(key)) return false;
      return true;
    });

    if (!toDecryptMeta.length) return;

    toDecryptMeta.forEach((m) => metaInFlightRef.current.add(messageKey(m)));

    Promise.all(
      toDecryptMeta.map(async (m) => {
        const key = messageKey(m);
        try {
          const json = await window.security.decrypt(sharedSecret, {
            ciphertext: m.attachmentMetadata!,
            iv: m.attachmentMetadataIv!,
            authTag: m.attachmentMetadataAuthTag!,
          });
          const meta = JSON.parse(json) as AttachmentMeta;
          return [key, meta] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    ).then((results) => {
      results.forEach(([key]) => metaInFlightRef.current.delete(key));
      setDecryptedMeta((prev) => {
        const next = new Map(prev);
        for (const [key, meta] of results) {
          if (meta) next.set(key, meta);
        }
        return next;
      });
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

    // Hide zero-width space placeholder used for attachment-only messages
    if (message === "\u200b") return null;

    return <>{renderMessage(message)}</>;
  };

  const getAttachmentMeta = (msg: Message): AttachmentMeta | null => {
    if (msg.attachmentFilename) {
      return { name: msg.attachmentFilename, size: 0, mimeType: "" };
    }
    return decryptedMeta.get(messageKey(msg)) ?? null;
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
                  "relative max-w-[95%] lg:max-w-[65%] text-sm leading-relaxed wrap-break-word",
                  msg.attachmentId && msg.uploadProgress === undefined
                    ? "overflow-hidden p-0"
                    : "px-3.5 py-2",
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
                {msg.uploadProgress !== undefined ? (
                  // Upload in progress
                  <div className="min-w-45">
                    <div className="flex items-center gap-2 mb-2">
                      <FileIcon className="size-3.5 shrink-0 opacity-70" />
                      <span className="text-sm font-medium truncate max-w-40">
                        {msg.attachmentFilename ?? "File"}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-primary-foreground/20 overflow-hidden">
                      <div
                        className="h-full bg-primary-foreground/70 rounded-full transition-all duration-200"
                        style={{ width: `${msg.uploadProgress}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1 text-[10px] opacity-60">
                      <span>Uploading…</span>
                      <span>{msg.uploadProgress}%</span>
                    </div>
                  </div>
                ) : msg.attachmentId || msg.attachmentFilename ? (
                  // Attachment card
                  <>
                    {msg.attachmentId ? (
                      <AttachmentCard
                        server={server}
                        attachmentId={msg.attachmentId}
                        senderIdentityKey={member.identityKey}
                        meta={getAttachmentMeta(msg)}
                        isOwn={msg.isOwn}
                        textContent={getText(msg)}
                        sentAt={msg.sentAt}
                        status={getStatus(msg)}
                      />
                    ) : (
                      // Local pending (upload finished but ack not yet received)
                      <div className="flex items-center gap-2.5 min-w-40 pb-0.5">
                        <div
                          className={cn(
                            "flex items-center justify-center size-8 shrink-0 rounded-lg",
                            msg.isOwn
                              ? "bg-primary-foreground/15"
                              : "bg-muted-foreground/10",
                          )}
                        >
                          <FileIcon className="size-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate leading-tight">
                            {msg.attachmentFilename ?? "Attachment"}
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <span>{getText(msg)}</span>
                )}
                {!(msg.attachmentId && msg.uploadProgress === undefined) && (
                  <>
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
                        <CheckCheck
                          className="size-3 shrink-0"
                          strokeWidth={2.5}
                        />
                      )}
                    </span>
                  </>
                )}
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
