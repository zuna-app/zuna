import { useState } from "react";
import { Download, FileIcon, ImageIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelMessage, Server } from "@/types/serverTypes";
import { useChannelAttachmentDownload } from "@/hooks/chat/useChannelAttachmentDownload";
import { ImageLightbox } from "./image-lightbox";
import { formatFileSize } from "./types";

const IMAGE_INLINE_SIZE_LIMIT = 8 * 1024 * 1024; // 8 MB

function isImageMime(mime: string) {
  return mime.startsWith("image/");
}

interface ChannelAttachmentCardProps {
  server: Server;
  message: ChannelMessage;
  channelKey: string | null;
  meta: { name: string; size: number; mimeType: string } | null;
}

export function ChannelAttachmentCard({
  server,
  message,
  channelKey,
  meta,
}: ChannelAttachmentCardProps) {
  const mimeType = meta?.mimeType ?? "";
  const isImage = isImageMime(mimeType);
  const isInlineImage =
    isImage && meta !== null && meta.size <= IMAGE_INLINE_SIZE_LIMIT;

  const [lightboxOpen, setLightboxOpen] = useState(false);

  const { url, loading, error, download, saveFile } =
    useChannelAttachmentDownload(
      server,
      message.attachmentId,
      channelKey,
      mimeType,
      isInlineImage,
    );

  // Upload in progress – show progress bar
  if (message.uploadProgress !== undefined) {
    return (
      <div className="flex items-center gap-2 py-1 mb-1">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate text-muted-foreground">
            {message.attachmentFilename ?? "Uploading…"}
          </p>
          <div className="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{ width: `${message.uploadProgress}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (isInlineImage) {
    return (
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
        <div className="relative group mb-1 rounded-md overflow-hidden max-w-sm">
          {url ? (
            <img
              src={url}
              alt={meta?.name ?? "Image"}
              className="w-full max-h-72 object-cover cursor-pointer block"
              onClick={() => setLightboxOpen(true)}
            />
          ) : error ? (
            <div className="flex flex-col items-center gap-1.5 p-4 text-[11px] opacity-60 min-w-40 min-h-28 justify-center bg-muted-foreground/10 rounded-md">
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
            <div className="flex flex-col items-center gap-2 p-6 opacity-50 min-h-28 justify-center bg-muted-foreground/10 rounded-md">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-[10px]">Loading…</span>
            </div>
          )}
        </div>
      </>
    );
  }

  // File card
  return (
    <div className="flex items-center gap-2.5 bg-muted/50 border border-border/50 rounded-lg px-3 py-2 mb-1 max-w-xs">
      <div className="flex items-center justify-center size-8 shrink-0 rounded-lg bg-muted-foreground/10">
        <FileIcon className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate leading-tight">
          {meta?.name ?? message.attachmentFilename ?? "Attachment"}
        </p>
        {meta && meta.size > 0 && (
          <p className="text-[10px] opacity-60 mt-px">
            {formatFileSize(meta.size)}
          </p>
        )}
        {error && <p className="text-[10px] text-destructive mt-px">{error}</p>}
      </div>
      <button
        type="button"
        onClick={() => saveFile(meta?.name ?? "file")}
        disabled={loading}
        className={cn(
          "shrink-0 rounded-lg p-1.5 transition-colors",
          "hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground",
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
  );
}
