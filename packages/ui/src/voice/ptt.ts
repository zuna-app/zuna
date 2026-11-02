// Push to talk: the key held in the window, or anywhere on the computer where the
// desktop can tell. A key in the window is lost when focus goes, so that lets go.

import { platform } from "@/platform";
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
  // Without a way to see the key outside the window, it can't be seen going up from there either.
  const onBlur = () => {
    if (!platform.watchKey) state().setKeyHeld(false);
  };
  window.addEventListener("keydown", onDown);
  window.addEventListener("keyup", onUp);
  window.addEventListener("mousedown", onMouse);
  window.addEventListener("mouseup", onMouse);
  window.addEventListener("blur", onBlur);

  let stopGlobal: (() => void) | undefined;
  let watching: string | null = null;
  const update = () => {
    const { settings, status } = state();
    const wanted = settings.inputMode === "ptt" && status !== "idle" && settings.pttKey ? settings.pttKey : null;
    if (wanted === watching) return;
    watching = wanted;
    stopGlobal?.();
    useVoice.setState({ keyBound: null });
    stopGlobal = wanted ? platform.watchKey?.(wanted, (down) => state().setKeyHeld(down), (trigger) => useVoice.setState({ keyBound: trigger || null })) : undefined;
  };
  update();
  const unsubscribe = useVoice.subscribe(update);

  return () => {
    window.removeEventListener("keydown", onDown);
    window.removeEventListener("keyup", onUp);
    window.removeEventListener("mousedown", onMouse);
    window.removeEventListener("mouseup", onMouse);
    window.removeEventListener("blur", onBlur);
    unsubscribe();
    stopGlobal?.();
  };
}
