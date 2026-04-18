import { useEffect, useRef } from "react";
import { ExternalLink, Globe, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOgPreview } from "@/hooks/useOgPreview";

interface OgPreviewCardProps {
  url: string;
  /** Visual variant – "bubble" sits inside/below a message bubble, "input" floats above the input */
  variant?: "bubble" | "input";
  isOwn?: boolean;
  onDismiss?: () => void;
  onLoad?: () => void;
  className?: string;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function OgPreviewCard({
  url,
  variant = "bubble",
  isOwn = false,
  onDismiss,
  onLoad,
  className,
}: OgPreviewCardProps) {
  const { data, loading } = useOgPreview(url);

  const prevLoadingRef = useRef(true);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      onLoad?.();
    }
    prevLoadingRef.current = loading;
  }, [loading, onLoad]);

  const openUrl = () => window.shell.openExternal(url);

  if (loading) {
    return (
      <div
        className={cn(
          "animate-pulse rounded-xl overflow-hidden",
          variant === "input"
            ? "border border-border bg-muted/40 dark:bg-muted/20"
            : isOwn
              ? "bg-primary-foreground/10"
              : "bg-muted/50 dark:bg-muted/30 border border-border/40",
          className,
        )}
      >
        <div className="p-2.5 flex gap-2.5">
          <div className="shrink-0 w-10 h-10 rounded-md bg-muted-foreground/20" />
          <div className="flex-1 space-y-1.5 py-0.5">
            <div className="h-2.5 bg-muted-foreground/20 rounded w-2/3" />
            <div className="h-2.5 bg-muted-foreground/20 rounded w-full" />
            <div className="h-2.5 bg-muted-foreground/20 rounded w-1/2" />
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const domain = getDomain(url);
  const hasImage = !!data.image;

  if (variant === "input") {
    return (
      <div
        className={cn(
          "rounded-xl border border-border bg-background shadow-sm overflow-hidden",
          "flex items-stretch gap-0",
          className,
        )}
      >
        {hasImage && (
          <div className="w-20 shrink-0 bg-muted">
            <img
              src={data.image}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
        <div className="flex-1 min-w-0 p-3 flex flex-col justify-center gap-0.5">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
            <Globe className="size-3 shrink-0" />
            <span className="truncate">{data.siteName ?? domain}</span>
          </div>
          {data.title && (
            <p className="text-sm font-semibold leading-snug line-clamp-1 text-foreground">
              {data.title}
            </p>
          )}
          {data.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {data.description}
            </p>
          )}
        </div>
        <div className="flex flex-col items-center justify-around shrink-0 pr-2 gap-1">
          <button
            type="button"
            onClick={openUrl}
            className="p-1. rounded-md text-muted-foreground hover:text-foreground transition-colors"
            title="Open link"
          >
            <ExternalLink className="size-3.5" />
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
              title="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // "bubble" variant
  return (
    <button
      type="button"
      onClick={openUrl}
      className={cn(
        "w-full text-left rounded-xl overflow-hidden mt-1.5 transition-opacity hover:opacity-90 active:opacity-75",
        isOwn
          ? "bg-primary-foreground/15 border border-primary-foreground/20"
          : "bg-background/70 dark:bg-muted/30 border border-border/50",
        className,
      )}
    >
      {hasImage && (
        <div className="w-full max-h-24 overflow-hidden bg-muted">
          <img
            src={data.image}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (
                e.currentTarget as HTMLImageElement
              ).parentElement!.style.display = "none";
            }}
          />
        </div>
      )}
      <div className="p-2 space-y-0.5">
        <div className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wide opacity-60">
          <Globe className="size-2.5 shrink-0" />
          <span className="truncate">{data.siteName ?? domain}</span>
        </div>
        {data.title && (
          <p className="text-[11px] font-semibold leading-snug line-clamp-1">
            {data.title}
          </p>
        )}
        {data.description && (
          <p className="text-[10px] opacity-70 line-clamp-1 leading-relaxed">
            {data.description}
          </p>
        )}
      </div>
    </button>
  );
}

/** Renders clickable URL spans with optional OG card below */
interface MessageUrlProps {
  url: string;
  isOwn: boolean;
  onLoad?: () => void;
}

export function MessageOgPreview({ url, isOwn, onLoad }: MessageUrlProps) {
  return (
    <OgPreviewCard url={url} variant="bubble" isOwn={isOwn} onLoad={onLoad} />
  );
}
