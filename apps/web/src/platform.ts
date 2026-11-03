// The web app's side of the interface. Notifications are the browser's, and the
// tab's title counts what's unread.

import { connectWorker, type Platform } from "@zuna/ui";
import type { HostConfig } from "./config";
import { deviceName, loadDeviceKey, removeUnreadableDatabase } from "./device";
import { askToNotify, clearNotifications, notificationPermission, notify, onOpenConversation } from "./notifications";

const UPDATE_CHECK_MS = 30 * 60_000;
const UPDATE_CHECK_ON_FOCUS_MS = 60_000;

let worker: Worker | null = null;

/** Stops the core, which lets go of the database for another tab. */
export function stopCore(): void {
  worker?.terminate();
  worker = null;
}

/** An invite link given as https://web.example/#join=<link>. The link is in the fragment, so no server sees its key. */
function takeJoinLink(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const link = params.get("join");
  if (!link) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return link;
}

export function webPlatform(config: HostConfig): Platform {
  return {
    hour12: undefined,
    titleBar: false,
    // What sound there is to share is up to the browser, which offers it in its own picker.
    systemAudio: true,
    async bootCore(onEvent) {
      const { key, created } = await loadDeviceKey();
      if (created) await removeUnreadableDatabase();
      worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: config.previews ? "zuna-core" : "zuna-core-no-previews",
      });
      const booted = await connectWorker(worker, { key, protected: false, deviceName: deviceName(), localLinks: config.localLinks }, onEvent);
      // Asks the browser not to clear Zuna's data when the disk fills up. If it does
      // anyway, signing in again brings the history back from the vault.
      void navigator.storage.persist?.().catch(() => false);
      return booted;
    },
    openExternal: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
    setUnreadCount(count) {
      document.title = count > 0 ? `(${count}) Zuna` : "Zuna";
    },
    notify,
    clearNotifications,
    onOpenConversation,
    notificationPermission,
    askToNotify,
    takeDeepLink: async () => takeJoinLink(),
    onDeepLink(listener) {
      const onHashChange = () => {
        const link = takeJoinLink();
        if (link) listener(link);
      };
      window.addEventListener("hashchange", onHashChange);
      return () => window.removeEventListener("hashchange", onHashChange);
    },
    keyWarning:
      "Browsers can't lock Zuna's local data to your login, so anyone who can copy this browser's profile can read it. On a computer others use, sign out when you're done, or use the desktop app.",
    defaultServer: config.server ?? undefined,
    onUpdate(listener) {
      let first: string | null = null;
      let lastCheck = 0;
      const check = async () => {
        lastCheck = Date.now();
        try {
          const response = await fetch("/version.json", { cache: "no-store" });
          const { build } = (await response.json()) as { build: string };
          if (first === null) first = build;
          else if (build !== first) {
            stop();
            listener();
          }
        } catch {
          // Offline, or served without zuna-web. The next check tries again.
        }
      };
      const onFocus = () => {
        if (Date.now() - lastCheck > UPDATE_CHECK_ON_FOCUS_MS) void check();
      };
      const timer = setInterval(() => void check(), UPDATE_CHECK_MS);
      window.addEventListener("focus", onFocus);
      const stop = () => {
        clearInterval(timer);
        window.removeEventListener("focus", onFocus);
      };
      void check();
      return stop;
    },
    warnBeforeLeaving: true,
  };
}
