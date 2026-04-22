import React, { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Check,
  CheckCheck,
  FileIcon,
  Loader2,
  Copy,
  Reply,
  Pin,
  PinOff,
  Edit,
  Delete,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Server } from "@/types/serverTypes";
import { MessageOgPreview } from "../og-preview";
import { extractFirstUrl } from "@/hooks/ui/useOgPreview";
import { BiCheck, BiCheckDouble } from "react-icons/bi";
import {
  formatTime,
  getStatus,
  type AttachmentMeta,
  type GroupedMessage,
} from "./types";
import { AttachmentCard } from "./attachment-card";
import { DelayedMessageSpinner } from "@/components/ui/delayed-spinner";
import type { EmoteV3 } from "@/lib/seventv";
import { emoteUrl } from "@/lib/seventv";
import type { EmoteDataMap } from "@/hooks/ui/useEmotes";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.min.css";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useWsConnection } from "@/hooks/ws/useWsConnection";
import { WS_MSG } from "@/hooks/ws/wsTypes";

const URL_SPLIT_RE = /(https?:\/\/[^\s<>"']+)/i;

const CODE_BLOCK_RE = /^```(\w*)\n([\s\S]+)\n?```$/;

function parseCodeBlock(
  text: string,
): { language: string; code: string } | null {
  const m = CODE_BLOCK_RE.exec(text.trim());
  if (!m) return null;
  return { language: m[1] ?? "", code: m[2] };
}

function CodeBlock({
  language,
  code,
  isOwn,
}: {
  language: string;
  code: string;
  isOwn: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    return hljs.highlightAuto(code);
  }, [language, code]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className={cn(
        "rounded-xl overflow-hidden text-xs leading-relaxed",
        isOwn ? "bg-black/30" : "bg-black/60",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-3 py-1.5",
          isOwn ? "bg-black/20" : "bg-black/30",
        )}
      >
        <span className="text-[10px] text-white/40 uppercase tracking-wider">
          {highlighted.language || "code"}{" "}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 transition-colors"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 m-0 bg-transparent rounded-xl mb-5">
        <code
          className={cn(
            "hljs rounded-xl",
            highlighted.language && `language-${highlighted.language}`,
          )}
          dangerouslySetInnerHTML={{ __html: highlighted.value }}
        />
      </pre>
    </div>
  );
}

function EmoteHoverCard({
  name,
  emote,
  src,
}: {
  name: string;
  emote: EmoteV3;
  src: string;
}) {
  const srcLarge = emoteUrl(emote, "3x") ?? emoteUrl(emote, "2x") ?? src;
  const emotePageUrl = `https://7tv.app/emotes/${emote.data.id}`;
  const owner = emote.data.owner;

  const sizeFiles = emote.data.host.files.filter((f) =>
    /^\dx\.webp$/.test(f.name),
  );
  const largestFile = sizeFiles[sizeFiles.length - 1];
  const dimensions = largestFile
    ? `${largestFile.width}×${largestFile.height}`
    : null;

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        <img
          src={src}
          alt={name}
          className="inline-block align-middle h-[2em] cursor-default"
        />
      </HoverCardTrigger>
      <HoverCardContent
        className="w-auto min-w-44 max-w-60 p-3"
        align="center"
        side="top"
      >
        <div className="flex flex-col items-center gap-2">
          {srcLarge && (
            <img
              src={srcLarge}
              alt={name}
              className="max-h-24 max-w-full object-contain"
            />
          )}
          <div className="w-full space-y-1 text-center">
            <p className="font-semibold text-sm leading-tight">{name}</p>
            {(dimensions || emote.data.animated) && (
              <p className="text-xs text-muted-foreground">
                {emote.data.animated && (
                  <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium">
                    Animated
                  </span>
                )}
                {dimensions}
              </p>
            )}
            {owner && (
              <p className="text-xs text-muted-foreground">
                By{" "}
                <button
                  type="button"
                  onClick={() =>
                    window.shell.openExternal(
                      `https://7tv.app/users/${owner.id}`,
                    )
                  }
                  className="underline underline-offset-1 hover:text-foreground transition-colors duration-100"
                >
                  {owner.display_name || owner.username}
                </button>
              </p>
            )}
            <button
              type="button"
              onClick={() => window.shell.openExternal(emotePageUrl)}
              className="text-xs text-primary/80 hover:text-primary underline underline-offset-1 transition-colors duration-100"
            >
              View on 7TV ↗
            </button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function renderMessage(
  text: string,
  emoteMap: ReadonlyMap<string, string>,
  emoteDataMap: EmoteDataMap,
): React.ReactNode {
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

    const emoteParts = part.split(/(\b[a-zA-Z0-9_]+\b)/g);
    return emoteParts.map((ep, j) => {
      const src = emoteMap.get(ep);
      const emoteData = emoteDataMap.get(ep);
      if (src && emoteData) {
        return (
          <EmoteHoverCard
            key={`${i}-${j}`}
            name={ep}
            emote={emoteData}
            src={src}
          />
        );
      }
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
}

interface MessageBubbleProps {
  msg: GroupedMessage;
  server: Server;
  senderIdentityKey: string;
  rawText: string;
  attachmentMeta: AttachmentMeta | null;
  emoteMap: ReadonlyMap<string, string>;
  emoteDataMap: EmoteDataMap;
  onLoad: () => void;
  onEditMessage: (messageId: number, rawText: string) => void;
  onTogglePinMessage: (messageId: number) => void;
}

export const MessageBubble = React.memo(
  function MessageBubble({
    msg,
    server,
    senderIdentityKey,
    rawText,
    attachmentMeta,
    emoteMap,
    emoteDataMap,
    onLoad,
    onEditMessage,
    onTogglePinMessage,
  }: MessageBubbleProps) {
    const status = getStatus(msg);
    const [isOpenMenuContext, setIsOpenMenuContext] = useState(false);
    const messageRef = useRef<HTMLDivElement | null>(null);
    const { sendMessage: wsSend } = useWsConnection(server);

    const getSelectedMessageText = () => {
      const selection = window.getSelection();
      const bubble = messageRef.current;
      if (!selection || !bubble || selection.isCollapsed) return "";

      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (!anchorNode || !focusNode) return "";
      if (!bubble.contains(anchorNode) || !bubble.contains(focusNode))
        return "";

      return selection.toString().trim();
    };

    const codeBlock = useMemo(
      () => (rawText && rawText !== "\u200b" ? parseCodeBlock(rawText) : null),
      [rawText],
    );

    const textContent = useMemo(
      () =>
        rawText === "\u200b" ? null : (
          <>{renderMessage(rawText, emoteMap, emoteDataMap)}</>
        ),
      [rawText, emoteMap, emoteDataMap],
    );

    const ogUrl =
      rawText && rawText !== "\u200b" && !codeBlock
        ? extractFirstUrl(rawText)
        : null;

    return (
      <motion.div
        initial={{ opacity: 1, y: 8, x: 0, scale: 1 }}
        animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
        transition={{ type: "spring", duration: 0.25, bounce: 0.2 }}
        className={cn(
          "flex flex-col",
          msg.isOwn ? "items-end" : "items-start",
          msg.isFirst ? "mt-3" : "mt-0.5",
        )}
      >
        <ContextMenu
          onOpenChange={(open) => {
            setIsOpenMenuContext(open);
          }}
        >
          <ContextMenuTrigger asChild className="select-text">
            <div
              ref={messageRef}
              className={cn(
                "relative text-sm leading-relaxed wrap-break-word",
                codeBlock
                  ? "max-w-[95%] lg:max-w-[80%] p-0 overflow-hidden"
                  : "max-w-[95%] lg:max-w-[65%]",
                msg.attachmentId && msg.uploadProgress === undefined
                  ? "overflow-hidden p-0"
                  : !codeBlock && "px-3.5 py-2",
                msg.isOwn
                  ? cn(
                      "bg-primary text-primary-foreground",
                      isOpenMenuContext && "bg-primary/80",
                      msg.pinned && "bg-violet-900",
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
                      isOpenMenuContext && "bg-muted dark:bg-muted/70",
                      msg.pinned && "bg-violet-900 dark:bg-violet-900",
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
                <>
                  {msg.attachmentId ? (
                    <AttachmentCard
                      server={server}
                      attachmentId={msg.attachmentId}
                      senderIdentityKey={senderIdentityKey}
                      meta={attachmentMeta}
                      isOwn={msg.isOwn}
                      textContent={textContent}
                      sentAt={msg.sentAt}
                      status={status}
                      onLoad={onLoad}
                    />
                  ) : (
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
              ) : codeBlock ? (
                <div className="relative">
                  <CodeBlock
                    language={codeBlock.language}
                    code={codeBlock.code}
                    isOwn={msg.isOwn}
                  />
                  <span
                    className={cn(
                      "absolute bottom-2 right-3 flex items-center gap-0.5 text-[10px]",
                      "text-white/30",
                    )}
                  >
                    {formatTime(msg.sentAt)}
                    {msg.isOwn && status === "pending" && (
                      <DelayedMessageSpinner />
                    )}
                    {msg.isOwn && status === "sent" && (
                      <Check className="size-3 shrink-0" strokeWidth={2.5} />
                    )}
                    {msg.isOwn && status === "read" && (
                      <CheckCheck
                        className="size-3 shrink-0"
                        strokeWidth={2.5}
                      />
                    )}
                  </span>
                </div>
              ) : (
                <span>{textContent}</span>
              )}

              {!(msg.attachmentId && msg.uploadProgress === undefined) &&
                !codeBlock && (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        "inline-block align-bottom ml-3 opacity-0 pointer-events-none select-none text-[12px] whitespace-nowrap",
                        msg.isOwn ? "ml-3" : "ml-2",
                      )}
                    >
                      {msg.modified && "edited\u00a0"}
                      {formatTime(msg.sentAt)}
                      {msg.isOwn && "\u00a0\u00a0\u2713"}
                    </span>
                    <span
                      className={cn(
                        "absolute bottom-2 right-3.5 flex items-center gap-0.5 text-[12px] whitespace-nowrap",
                        msg.isOwn
                          ? "text-primary-foreground/60"
                          : "text-muted-foreground/50",
                      )}
                    >
                      {msg.modified && (
                        <span className="text-[12px] pr-0.5">edited</span>
                      )}

                      {formatTime(msg.sentAt)}
                      {msg.isOwn && status === "pending" && (
                        <DelayedMessageSpinner />
                      )}
                      {msg.isOwn && status === "sent" && (
                        <BiCheck
                          className="size-5 shrink-0"
                          strokeWidth={0.5}
                        />
                      )}
                      {msg.isOwn && status === "read" && (
                        <BiCheckDouble
                          className="size-5 shrink-0"
                          strokeWidth={0.5}
                        />
                      )}
                    </span>
                  </>
                )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>
              <Reply className="size-4" />
              Reply
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                if (msg.id == null || msg.pending) return;
                onTogglePinMessage(msg.id);
              }}
            >
              {msg.pinned ? (
                <>
                  <PinOff className="size-4" />
                  Unpin
                </>
              ) : (
                <>
                  <Pin className="size-4" />
                  Pin
                </>
              )}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                navigator.clipboard.writeText(
                  getSelectedMessageText() || rawText,
                );
              }}
            >
              <Copy className="size-4" />
              Copy
            </ContextMenuItem>
            {msg.isOwn && (
              <>
                <ContextMenuItem
                  disabled={msg.id == null || msg.pending}
                  onClick={() => {
                    if (msg.id == null || msg.pending) return;
                    onEditMessage(msg.id, rawText === "\u200b" ? "" : rawText);
                  }}
                >
                  <Edit className="size-4" />
                  Edit
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-destructive"
                  onClick={() => {
                    wsSend(WS_MSG.MESSAGE_DELETE, { id: msg.id });
                  }}
                >
                  <Delete className="size-4" />
                  Delete
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {ogUrl && (
          <div className="max-w-[75%] lg:max-w-[45%] w-full">
            <MessageOgPreview url={ogUrl} isOwn={msg.isOwn} onLoad={onLoad} />
          </div>
        )}
      </motion.div>
    );
  },
  (prev, next) =>
    prev.rawText === next.rawText &&
    prev.msg.id === next.msg.id &&
    prev.msg.localId === next.msg.localId &&
    prev.msg.isFirst === next.msg.isFirst &&
    prev.msg.isLast === next.msg.isLast &&
    prev.msg.showDivider === next.msg.showDivider &&
    prev.msg.pending === next.msg.pending &&
    prev.msg.readAt === next.msg.readAt &&
    prev.msg.uploadProgress === next.msg.uploadProgress &&
    prev.attachmentMeta === next.attachmentMeta &&
    prev.emoteMap === next.emoteMap &&
    prev.emoteDataMap === next.emoteDataMap &&
    prev.onLoad === next.onLoad &&
    prev.onEditMessage === next.onEditMessage &&
    prev.onTogglePinMessage === next.onTogglePinMessage &&
    prev.msg.pinned === next.msg.pinned,
);
