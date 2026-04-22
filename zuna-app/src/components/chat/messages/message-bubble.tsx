import React, { useMemo } from "react";
import { motion } from "motion/react";
import { Check, CheckCheck, FileIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Server } from "@/types/serverTypes";
import { MessageOgPreview } from "../og-preview";
import { extractFirstUrl } from "@/hooks/ui/useOgPreview";
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

const URL_SPLIT_RE = /(https?:\/\/[^\s<>"']+)/i;

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
  }: MessageBubbleProps) {
    const status = getStatus(msg);

    const textContent = useMemo(
      () =>
        rawText === "\u200b" ? null : (
          <>{renderMessage(rawText, emoteMap, emoteDataMap)}</>
        ),
      [rawText, emoteMap, emoteDataMap],
    );

    const ogUrl =
      rawText && rawText !== "\u200b" ? extractFirstUrl(rawText) : null;

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
                  !msg.isFirst && !msg.isLast && "rounded-l-2xl rounded-r-md",
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
                  !msg.isFirst && !msg.isLast && "rounded-r-2xl rounded-l-md",
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
          ) : (
            <span>{textContent}</span>
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
                {msg.isOwn && status === "pending" && <DelayedMessageSpinner />}
                {msg.isOwn && status === "sent" && (
                  <Check className="size-3 shrink-0" strokeWidth={2.5} />
                )}
                {msg.isOwn && status === "read" && (
                  <CheckCheck className="size-3 shrink-0" strokeWidth={2.5} />
                )}
              </span>
            </>
          )}
        </div>

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
    prev.onLoad === next.onLoad,
);
