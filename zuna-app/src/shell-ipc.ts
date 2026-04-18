import { ipcMain, shell } from "electron";

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

export async function openExternal(rawUrl: string): Promise<void> {
  if (typeof rawUrl !== "string") return;
  try {
    const u = new URL(rawUrl);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return;
    await shell.openExternal(rawUrl);
  } catch {
    // invalid URL — do nothing
  }
}

export function registerShellIPC() {
  ipcMain.handle("shell:openExternal", (_, rawUrl: string) =>
    openExternal(rawUrl),
  );
}
