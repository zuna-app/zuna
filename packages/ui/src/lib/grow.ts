import { useLayoutEffect, type RefObject } from "react";

/**
 * Grows a text box with its text, up to its max-height, where the browser can't by itself.
 * Chromium does it in CSS with `field-sizing: content`, which the stylesheets ask for; the
 * Safari and Firefox versions the build supports may not have it, and there one line would
 * scroll inside a box a line tall.
 */
export function useGrowWithText(box: RefObject<HTMLTextAreaElement | null>, text: string): void {
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || CSS.supports("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [box, text]);
}
