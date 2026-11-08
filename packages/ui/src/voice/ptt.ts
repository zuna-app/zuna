// Push to talk: the key held in the window. A browser can't hear keys elsewhere, and a key in
// the window is lost when focus goes, so that lets go.

import { useVoice } from "./store";

export function watchPushToTalk(): () => void {
  const state = () => useVoice.getState();
  const inputFocused = () => {
    const element = document.activeElement as HTMLElement | null;
    return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable);
  };
  const onDown = (event: KeyboardEvent) => {
    if (event.repeat || event.code !== state().settings.pttKey) return;
    // A letter being typed into a message isn't someone wanting to talk.
    if (event.code.startsWith("Key") && inputFocused()) return;
    state().setKeyHeld(true);
  };
  const onUp = (event: KeyboardEvent) => {
    if (event.code === state().settings.pttKey) state().setKeyHeld(false);
  };
  const onMouse = (event: MouseEvent) => {
    if (`Mouse${event.button}` === state().settings.pttKey) state().setKeyHeld(event.type === "mousedown");
  };
  // The key can't be seen going up outside the window either.
  const onBlur = () => state().setKeyHeld(false);
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("mousedown", onMouse);
  window.addEventListener("mouseup", onMouse);
  window.addEventListener("blur", onBlur);

  return () => {
    window.removeEventListener("keydown", onDown);
    window.removeEventListener("keyup", onUp);
    window.removeEventListener("mousedown", onMouse);
    window.removeEventListener("mouseup", onMouse);
    window.removeEventListener("blur", onBlur);
  };
}
