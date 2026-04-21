import { Dialog as DialogPrimitive } from "radix-ui";
import { Download, X } from "lucide-react";

interface ImageLightboxProps {
  open: boolean;
  onClose: () => void;
  src: string;
  alt?: string;
  fileName?: string;
  onDownload: () => void;
}

export function ImageLightbox({
  open,
  onClose,
  src,
  alt,
  fileName,
  onDownload,
}: ImageLightboxProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()} >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-100"
          onClick={onClose}
        
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 duration-100"
          onClick={onClose}
        >
          {/* Top bar */}
          <div
            className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-linear-to-b from-black/60 to-transparent z-10 pointer-events-none"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-white/80 text-sm truncate max-w-[60%] select-none">
              {fileName ?? alt ?? "Image"}
            </span>
            <div className="flex items-center gap-2 pointer-events-auto">
              <button
                type="button"
                onClick={onDownload}
                className="flex items-center gap-1.5 text-white/80 hover:text-white transition-colors text-sm px-3 py-1.5 rounded-lg hover:bg-white/10"
              >
                <Download className="size-4" />
                Download
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-white/80 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/10"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>

          {/* Image */}
          <img
            src={src}
            alt={alt ?? "Image preview"}
            className="max-w-[90vw] max-h-[90vh] object-contain select-none"
            onClick={(e) => e.stopPropagation()}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
