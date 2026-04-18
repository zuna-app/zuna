import { ipcMain } from "electron";
import ogs from "open-graph-scraper";

export type OgData = {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
};

const ALLOWED_PROTOCOLS = ["https:", "http:"];

export function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return ALLOWED_PROTOCOLS.includes(u.protocol);
  } catch {
    return false;
  }
}

export async function fetchOgData(rawUrl: string): Promise<OgData | null> {
  if (typeof rawUrl !== "string" || !isValidUrl(rawUrl)) return null;

  try {
    const { result, error } = await ogs({
      url: rawUrl,
      timeout: 8000,
      fetchOptions: { signal: AbortSignal.timeout(8000) },
    });

    if (error) return null;

    const image =
      Array.isArray(result.ogImage) && result.ogImage.length > 0
        ? result.ogImage[0].url
        : undefined;

    return {
      url: rawUrl,
      title: result.ogTitle || undefined,
      description: result.ogDescription || undefined,
      image,
      siteName: result.ogSiteName || undefined,
    };
  } catch {
    return null;
  }
}

export function registerOgIPC() {
  ipcMain.handle("og:fetch", (_, rawUrl: string) => fetchOgData(rawUrl));
}
