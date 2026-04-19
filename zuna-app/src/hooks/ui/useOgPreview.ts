import { useEffect, useRef, useState } from "react";

// Module-level cache shared across all component instances
const ogCache = new Map<string, OgData | null>();

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const TRAILING_PUNCT_RE = /[.,;:!?)'"\]]+$/;

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match) return null;
  return match[0].replace(TRAILING_PUNCT_RE, "");
}

/**
 * Fetches OG data for a given URL with optional debounce (for input preview).
 * @param url     The URL to fetch metadata for (null = no-op).
 * @param debounceMs  Delay before firing the request (default 0 = immediate).
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
      try {
        const result = await window.og.fetch(url);
        ogCache.set(url, result);
        setData(result);
      } catch {
        ogCache.set(url, null);
        setData(null);
      } finally {
        setLoading(false);
      }
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [url, debounceMs]);

  return { data, loading };
}
