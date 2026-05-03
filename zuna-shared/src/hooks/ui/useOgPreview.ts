import { useEffect, useRef, useState } from "react";

// Module-level cache shared across all instances
const ogCache = new Map<string, OgData | null>();

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const TRAILING_PUNCT_RE = /[.,;:!?)'"\]]+$/;

export interface OgData {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  siteName?: string;
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match) return null;
  return match[0].replace(TRAILING_PUNCT_RE, "");
}

async function fetchOgBestEffort(url: string): Promise<OgData | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const getMeta = (prop: string) =>
      doc.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ??
      doc.querySelector(`meta[name="${prop}"]`)?.getAttribute("content") ??
      undefined;

    return {
      title: getMeta("og:title") ?? doc.title ?? undefined,
      description: getMeta("og:description") ?? undefined,
      image: getMeta("og:image") ?? undefined,
      url: getMeta("og:url") ?? url,
      siteName: getMeta("og:site_name") ?? undefined,
    };
  } catch {
    // CORS failure or network error — silently return null
    return null;
  }
}

/**
 * Fetches OG data for a given URL using a best-effort browser fetch.
 * CORS failures are silently ignored — returns null in those cases.
 */
export function useOgPreview(url: string | null, debounceMs = 0) {
  const [data, setData] = useState<OgData | null>(() =>
    url ? (ogCache.get(url) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }

    if (ogCache.has(url)) {
      setData(ogCache.get(url) ?? null);
      setLoading(false);
      return;
    }

    setLoading(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      const result = await fetchOgBestEffort(url);
      ogCache.set(url, result);
      setData(result);
      setLoading(false);
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [url, debounceMs]);

  return { data, loading };
}
