// Keeps the message box focused. Clicking around, closing a dialog, switching
// back to the window or simply starting to type all land in the composer, so it
// never needs a manual click. Keyboard users can still Tab away from it, and
// selecting text to copy is left alone.

let composer: HTMLTextAreaElement | null = null;

const OVERLAYS = ".modal-layer, .settings-layer, .menu, .picker, .image-viewer";

export function registerComposer(element: HTMLTextAreaElement): () => void {
  composer = element;
  return () => {
    if (composer === element) composer = null;
  };
}

const overlayOpen = () => !!document.querySelector(OVERLAYS);

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT";
}

export function focusComposer(): void {
  if (!composer || overlayOpen() || document.activeElement === composer) return;
  composer.focus({ preventScroll: true });
}

/** Refocuses after the current event, once whatever it opened or closed has settled. */
export function refocusComposer(): void {
  setTimeout(() => {
    if (isEditable(document.activeElement)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    focusComposer();
  });
}

function onKeyDown(event: KeyboardEvent): void {
  if (isEditable(document.activeElement) || overlayOpen()) return;
  const paste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
  if ((event.ctrlKey || event.metaKey || event.altKey) && !paste) return;
  // Space and Enter belong to whichever button has keyboard focus.
  if (paste || (event.key.length === 1 && event.key !== " ")) focusComposer();
}

/** Installs the global listeners. Returns a function that removes them. */
export function installStickyFocus(): () => void {
  window.addEventListener("mouseup", refocusComposer);
  window.addEventListener("focus", refocusComposer);
  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    window.removeEventListener("mouseup", refocusComposer);
    window.removeEventListener("focus", refocusComposer);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
