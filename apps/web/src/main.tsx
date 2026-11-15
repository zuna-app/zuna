import { startApp } from "@zuna/ui";
import { applyLanguage, t } from "@/lib/i18n";
import { loadSettings } from "@/state/settings";
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
  if (!window.isSecureContext) return t("startup.needsHttps");
  if (!navigator.locks || !navigator.storage?.getDirectory || !("BroadcastChannel" in window) || !("indexedDB" in window)) {
    return t("startup.unsupportedBrowser");
  }
  return null;
}

/** Safari keeps no files for a private window, which is where Zuna keeps your messages. */
async function storageReason(): Promise<string | null> {
  try {
    await navigator.storage.getDirectory();
    return null;
  } catch {
    return t("startup.privateWindow");
  }
}

// What's shown before the app starts, such as why it can't, is in the language chosen in Settings too.
await applyLanguage(loadSettings().language).catch(() => undefined);
const unsupported = unsupportedReason() ?? (await storageReason());
if (unsupported) {
  showScreen(t("startup.cantRunTitle"), unsupported);
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
