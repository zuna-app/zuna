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
  if (!window.isSecureContext) return "Zuna has to be opened over HTTPS.";
  if (!navigator.locks || !navigator.storage?.getDirectory || !("BroadcastChannel" in window) || !("indexedDB" in window)) {
    return "This browser is missing what Zuna needs to keep your messages. Use a current version of Chrome, Edge, Firefox or Safari.";
  }
  return null;
}

const unsupported = unsupportedReason();
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
