import { startApp } from "@zuna/ui";
import { loadConfig } from "./config";
import { stopCore, webPlatform } from "./platform";
import { holdTab, showScreen } from "./tab";
import "./web.css";

// A file dropped anywhere but the message box would open in the tab, leaving Zuna.
// Drop areas that take files handle the event first and mark it.
window.addEventListener("dragover", (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
});
window.addEventListener("drop", (event) => event.preventDefault());

/** What the app needs from a browser: a secure page, its own files, and locks between tabs. */
function unsupportedReason(): string | null {
  if (!window.isSecureContext) return "Zuna must be opened over HTTPS.";
  if (!navigator.locks || !navigator.storage?.getDirectory || !("BroadcastChannel" in window) || !("indexedDB" in window)) {
    return "This browser doesn't support what Zuna needs to store your messages. Use a recent version of Chrome, Edge, Firefox or Safari.";
  }
  return null;
}

/** Safari keeps no files for a private window, which is where Zuna keeps your messages. */
async function storageReason(): Promise<string | null> {
  try {
    await navigator.storage.getDirectory();
    return null;
  } catch {
    return "This browser won't let Zuna store your messages, which happens in private windows. Open Zuna in a normal window.";
  }
}

const unsupported = unsupportedReason() ?? (await storageReason());
if (unsupported) {
  showScreen("Zuna can't run here", unsupported);
} else {
  const config = await loadConfig();
  holdTab(() => {
    const stopApp = startApp(webPlatform(config));
    return () => {
      stopApp();
      stopCore();
      document.title = "Zuna";
    };
  });
}
