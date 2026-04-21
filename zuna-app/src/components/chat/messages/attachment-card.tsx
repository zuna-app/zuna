import { useState } from "react";
import {
  Check,
  CheckCheck,
  Download,
  FileIcon,
  ImageIcon,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Server } from "@/types/serverTypes";
import { useAttachmentDownload } from "@/hooks/chat/useAttachmentDownload";
import {
  formatFileSize,
  formatTime,
  type AttachmentMeta,
  type MessageStatus,
} from "./types";
import { ImageLightbox } from "./image-lightbox";

const IMAGE_INLINE_SIZE_LIMIT = 8 * 1024 * 1024; // 8 MB

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
  onLoad?: () => void;
}

export function AttachmentCard({
  server,
  attachmentId,
  senderIdentityKey,
  meta,
  isOwn,
  textContent,
  sentAt,
  status,
  onLoad,
}: AttachmentCardProps) {
  const mimeType = meta?.mimeType ?? "";
  const isImage = isImageMime(mimeType);
  // Images over 8 MB are shown as file attachments to avoid huge inline loads
  const isInlineImage =
    isImage && meta !== null && meta.size <= IMAGE_INLINE_SIZE_LIMIT;

  const [lightboxOpen, setLightboxOpen] = useState(false);

  const { url, loading, error, download, saveFile } = useAttachmentDownload(
    server,
    attachmentId,
    senderIdentityKey,
    mimeType,
    isInlineImage,
  );

  return (
    <>
      {isInlineImage ? (
        <>
          {url && (
            <ImageLightbox
              open={lightboxOpen}
              onClose={() => setLightboxOpen(false)}
              src={url}
              alt={meta?.name}
              fileName={meta?.name}
              onDownload={() => saveFile(meta?.name ?? "image")}
            />
          )}
          <div className="relative group">
            {url ? (
              <img
                src={url}
                alt={meta?.name ?? "Image"}
                className="w-full max-h-72 object-cover cursor-pointer block"
                onLoad={onLoad}
                onClick={() => setLightboxOpen(true)}
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
        </>
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
