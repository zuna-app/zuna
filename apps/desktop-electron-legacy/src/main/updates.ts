// Automatic updates, so that a security fix reaches people without their having
// to notice it. An update is only ever installed if it carries the same publisher's
// signature as the app running now: Windows and macOS builds check that before
// installing. A build that isn't signed has nothing to compare with, so it doesn't
// update itself, and neither does Linux, where these formats carry no signature.

import { app } from "electron";
import electronUpdater from "electron-updater";

/** Set when building with signing keys: see .github/workflows/release.yml. */
declare const __ZUNA_SIGNED_BUILD__: boolean;

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function startUpdates(): void {
  if (!app.isPackaged || !__ZUNA_SIGNED_BUILD__ || process.platform === "linux") return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("error", (error) => console.warn("[zuna] checking for updates", error));
  const check = () => void autoUpdater.checkForUpdates().catch((error) => console.warn("[zuna] checking for updates", error));
  check();
  setInterval(check, CHECK_EVERY_MS);
}
