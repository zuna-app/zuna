// The image viewer over the app: a picture fitted to the window, zoomed, dragged and scrolled,
// and the chat's other pictures beside it.

import type { Attachment } from "@zuna/core";
import { AlertTriangle, ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Spinner, useReturnFocus } from "@/components/ui";
import { useEscape } from "@/lib/escape";
import { loadsByItself, useDecryptedUrl } from "@/lib/media";

const MAX_ZOOM = 8;

interface View {
  scale: number;
  /** Where the picture's center is, from the middle of the window. */
  x: number;
  y: number;
}

const FITTED: View = { scale: 1, x: 0, y: 0 };

/** A mouse wheel moves in steps; a trackpad scrolls smoothly, and pans instead. */
const isMouseWheel = (event: WheelEvent) => event.deltaX === 0 && event.deltaY !== 0 && Math.abs((event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 1) % 120 === 0;

/** How far a finger has to go sideways to go to the next picture. */
const SWIPE_PX = 60;

/**
 * A picture, fitted to the window. It zooms with a pinch, the mouse wheel, a
 * double click or the buttons, towards where the pointer is, and once it's
 * bigger than the window it can be dragged and scrolled around. The chat's
 * other pictures are either side of it, as in Telegram, the older on the left:
 * the arrows, the arrow keys or a swipe go to them.
 */
export function ImageViewer({ serverId, pictures, start, onClose }: { serverId: string; pictures: Attachment[]; start: number; onClose: () => void }) {
  useEscape(onClose);
  useReturnFocus();
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), pictures.length - 1));
  const picture = pictures[index];
  const { url, failed } = useDecryptedUrl(serverId, picture);
  // The ones either side, so going to one shows it at once.
  const before = pictures[index - 1];
  const after = pictures[index + 1];
  useDecryptedUrl(serverId, before && loadsByItself(before) ? before : null);
  useDecryptedUrl(serverId, after && loadsByItself(after) ? after : null);
  const go = useCallback((step: number) => setIndex((current) => Math.min(pictures.length - 1, Math.max(0, current + step))), [pictures.length]);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  // A swipe that ends over the shade isn't a click on it.
  const swiped = useRef(false);
  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  // Steps glide; pinching, scrolling and dragging follow the fingers exactly.
  const [gliding, setGliding] = useState(true);
  // How big the fitted picture is next to its own size, for the zoom shown.
  const [fitted, setFitted] = useState(1);
  const measure = () => {
    const element = image.current;
    if (element?.naturalWidth) setFitted(element.offsetWidth / element.naturalWidth);
  };
  const image = useRef<HTMLImageElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  // Wheel and pointer events can come faster than the view is drawn, so each builds on the last.
  const latest = useRef<View>(FITTED);
  const drag = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null);

  // The picture can't be moved further than its edges reach past the window.
  const show = useCallback((next: View, glide = true) => {
    const element = image.current;
    const scale = Math.min(MAX_ZOOM, Math.max(1, next.scale));
    let limited = FITTED;
    if (element && scale > 1) {
      const spareX = Math.max(0, (element.offsetWidth * scale - window.innerWidth) / 2);
      const spareY = Math.max(0, (element.offsetHeight * scale - window.innerHeight) / 2);
      limited = { scale, x: Math.min(spareX, Math.max(-spareX, next.x)), y: Math.min(spareY, Math.max(-spareY, next.y)) };
    }
    latest.current = limited;
    setView(limited);
    setGliding(glide);
  }, []);

  // The point under the pointer stays where it is.
  const zoomTo = useCallback(
    (scale: number, clientX = window.innerWidth / 2, clientY = window.innerHeight / 2, glide = true) => {
      const current = latest.current;
      const target = Math.min(MAX_ZOOM, Math.max(1, scale));
      const pointX = clientX - window.innerWidth / 2;
      const pointY = clientY - window.innerHeight / 2;
      const ratio = target / current.scale;
      show({ scale: target, x: pointX - (pointX - current.x) * ratio, y: pointY - (pointY - current.y) * ratio }, glide);
    },
    [show],
  );

  // Double clicking shows the picture at its own size, or twice as big if it already fits.
  const closerScale = () => {
    const element = image.current;
    if (!element?.offsetWidth) return 2;
    return Math.max(2, Math.min(MAX_ZOOM, element.naturalWidth / element.offsetWidth));
  };

  // Each picture starts fitted.
  useEffect(() => {
    latest.current = FITTED;
    drag.current = null;
    setView(FITTED);
    setGliding(false);
    setDragging(false);
    setFitted(1);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "+" || event.key === "=") zoomTo(latest.current.scale * 1.5);
      else if (event.key === "-") zoomTo(latest.current.scale / 1.5);
      else if (event.key === "0") show(FITTED);
    };
    const onResize = () => {
      measure();
      show(latest.current, false);
    };
    // Handled here rather than through React, whose wheel events can't stop the page from scrolling.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = latest.current;
      if (event.ctrlKey || event.metaKey || isMouseWheel(event)) {
        // A pinch comes as small steps with ctrlKey set, a mouse wheel as big ones.
        const pinch = event.ctrlKey && !isMouseWheel(event);
        zoomTo(current.scale * (pinch ? Math.exp(-event.deltaY / 100) : event.deltaY < 0 ? 1.25 : 0.8), event.clientX, event.clientY, !pinch);
      } else {
        show({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }, false);
      }
    };
    const element = viewer.current!;
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      element.removeEventListener("wheel", onWheel);
    };
  }, [onClose, zoomTo, show, go]);

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const zoomed = view.scale > 1;
  // Until the picture's here, its blurred preview at the size it'll have.
  const width = picture.width ?? 320;
  const height = picture.height ?? 240;
  const fit = Math.min(1, (window.innerWidth - 80) / width, (window.innerHeight - 80) / height);
  const shown = url ?? picture.thumb;
  return createPortal(
    <div
      ref={viewer}
      className={`image-viewer${zoomed ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget && !swiped.current) onClose();
        swiped.current = false;
      }}
      onPointerDown={(event) => {
        swiped.current = false;
        swipe.current = !zoomed && event.pointerType === "touch" ? { x: event.clientX, y: event.clientY } : null;
      }}
      onPointerUp={(event) => {
        const from = swipe.current;
        swipe.current = null;
        if (!from) return;
        const dx = event.clientX - from.x;
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(event.clientY - from.y)) return;
        swiped.current = true;
        go(dx < 0 ? 1 : -1);
      }}
    >
      {shown && (
        <img
          key={picture.fileId}
          ref={image}
          src={shown}
          alt={picture.name}
          className={url ? undefined : "is-preview"}
          draggable={false}
          onLoad={url ? measure : undefined}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transition: gliding ? undefined : "none",
            ...(url ? {} : { width: width * fit, height: height * fit }),
          }}
          onDoubleClick={(event) => {
            if (!url) return;
            if (zoomed) show(FITTED);
            else zoomTo(closerScale(), event.clientX, event.clientY);
          }}
          onPointerDown={(event) => {
            if (!zoomed || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerX: event.clientX, pointerY: event.clientY, x: view.x, y: view.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start) show({ ...latest.current, x: start.x + event.clientX - start.pointerX, y: start.y + event.clientY - start.pointerY }, false);
        }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
      {!url && !failed && (
        <span className="image-state">
          <Spinner delayed />
        </span>
      )}
      {failed && (
        <span className="image-state">
          <AlertTriangle size={18} /> This picture couldn't be loaded.
        </span>
      )}
      {index > 0 && (
        <button className="icon-btn image-nav is-before" onClick={() => go(-1)} aria-label="Previous picture">
          <ChevronLeft size={22} />
        </button>
      )}
      {index < pictures.length - 1 && (
        <button className="icon-btn image-nav is-after" onClick={() => go(1)} aria-label="Next picture">
          <ChevronRight size={22} />
        </button>
      )}
      <div className="image-tools" onClick={(event) => event.stopPropagation()}>
        {pictures.length > 1 && <span className="image-count">{`${index + 1} of ${pictures.length}`}</span>}
        <button className="icon-btn" onClick={() => zoomTo(view.scale / 1.5)} disabled={!zoomed} aria-label="Zoom out">
          <ZoomOut size={17} />
        </button>
        <button className="image-zoom" onClick={() => show(FITTED)} disabled={!zoomed} aria-label="Fit to the window">
          {Math.round(view.scale * fitted * 100)}%
        </button>
        <button className="icon-btn" onClick={() => zoomTo(view.scale * 1.5)} disabled={!url || view.scale >= MAX_ZOOM} aria-label="Zoom in">
          <ZoomIn size={17} />
        </button>
        <a className="btn image-save" href={url ?? undefined} download={picture.name} aria-disabled={!url}>
          Save
        </a>
      </div>
      <button className="icon-btn image-close" onClick={onClose} aria-label="Close">
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}
