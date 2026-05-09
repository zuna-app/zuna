import { useEffect, useRef, useState } from 'react';

const ogCache = new Map<string, OgData | null>();

export interface OgData {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  siteName?: string;
}

// React Native has no DOMParser — extract <meta> tags via regex instead.
// Use [^>]* (zero or more) so adjacent attributes without whitespace still match.
function getMeta(html: string, prop: string): string | undefined {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<meta[^>]*(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*?)["']` +
      `|<meta[^>]*content=["']([^"']*?)["'][^>]*(?:property|name)=["']${esc}["']`,
    'i',
  );
  const m = html.match(re);
  const raw = (m?.[1] ?? m?.[2]) || undefined;
  return raw ? decodeHtmlEntities(raw) : undefined;
}

function getTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const raw = m?.[1]?.trim();
  return raw ? decodeHtmlEntities(raw) : undefined;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

async function fetchOgBestEffort(url: string): Promise<OgData | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: FETCH_HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const result: OgData = {
      title: getMeta(html, 'og:title') ?? getTitle(html),
      description: getMeta(html, 'og:description'),
      image: getMeta(html, 'og:image'),
      url: getMeta(html, 'og:url') ?? url,
      siteName: getMeta(html, 'og:site_name'),
    };
    // Return null if no meaningful data was found
    if (!result.title && !result.description && !result.image) return null;
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
