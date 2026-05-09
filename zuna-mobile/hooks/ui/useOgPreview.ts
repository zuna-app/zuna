import { useEffect, useRef, useState } from 'react';

const ogCache = new Map<string, OgData | null>();

export interface OgData {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  siteName?: string;
}

// React Native has no DOMParser — extract <meta> tags via regex instead
function getMeta(html: string, prop: string): string | undefined {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']*?)["']` +
      `|<meta[^>]+content=["']([^"']*?)["'][^>]+(?:property|name)=["']${esc}["']`,
    'i',
  );
  const m = html.match(re);
  return (m?.[1] ?? m?.[2]) || undefined;
}

function getTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m?.[1]?.trim() || undefined;
}

async function fetchOgBestEffort(url: string): Promise<OgData | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    return {
      title: getMeta(html, 'og:title') ?? getTitle(html),
      description: getMeta(html, 'og:description'),
      image: getMeta(html, 'og:image'),
      url: getMeta(html, 'og:url') ?? url,
      siteName: getMeta(html, 'og:site_name'),
    };
  } catch {
    return null;
  }
}

export function useOgPreview(url: string | null) {
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
    }, 0);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [url]);

  return { data, loading };
}
