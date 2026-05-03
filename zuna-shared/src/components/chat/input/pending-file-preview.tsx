import { FileIcon, X } from "lucide-react";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PendingFilePreviewProps {
  file: File;
  onDismiss: () => void;
}

export function PendingFilePreview({
  file,
  onDismiss,
}: PendingFilePreviewProps) {
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5 mb-2.5">
      <div className="flex items-center gap-2 bg-muted/60 border border-border/60 rounded-lg px-2.5 py-1.5 text-xs max-w-xs">
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{file.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {formatFileSize(file.size)}
        </span>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            onDismiss();
          }}
          className="shrink-0 ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
