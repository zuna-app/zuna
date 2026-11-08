// One press of Escape closes one thing: the layer opened last, such as a menu over a
// dialog over the settings. Each layer registers with useEscape, and one listener,
// ahead of everything else on the page, hands the key to the top one alone.

import { useEffect, useRef } from "react";

interface Layer {
  order: number;
  close: () => void;
}

const layers = new Set<Layer>();
let opened = 0;

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || layers.size === 0) return;
  let top: Layer | null = null;
  for (const layer of layers) if (!top || layer.order > top.order) top = layer;
  event.preventDefault();
  event.stopImmediatePropagation();
  top!.close();
}

/**
 * Closes this layer on Escape while `close` is given, unless one opened after it is
 * still open. A layer counts as opened when it first renders with a handler, so a menu
 * rendered inside a dialog is above it even when both appear at once.
 */
export function useEscape(close: (() => void) | null): void {
  const latest = useRef(close);
  latest.current = close;
  const order = useRef(0);
  const on = close !== null;
  if (!on) order.current = 0;
  else if (order.current === 0) order.current = ++opened;
  useEffect(() => {
    if (!on) return;
    if (layers.size === 0) window.addEventListener("keydown", onKeyDown, true);
    const layer: Layer = { order: order.current, close: () => latest.current?.() };
    layers.add(layer);
    return () => {
      layers.delete(layer);
      if (layers.size === 0) window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [on]);
}
