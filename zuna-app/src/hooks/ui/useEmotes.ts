import { useState, useEffect } from "react";
import { SevenTV, emoteUrl, EmoteV3 } from "@/lib/seventv";

// Module-level cache so the network round-trip only happens once per session.
let cachedMap: ReadonlyMap<string, string> | null = null;
let pendingPromise: Promise<ReadonlyMap<string, string>> | null = null;

async function loadGlobalEmotes(): Promise<ReadonlyMap<string, string>> {
  if (cachedMap) return cachedMap;
  if (pendingPromise) return pendingPromise;

  pendingPromise = SevenTV.getGlobalEmoteSet().then((set) => {
    const map = new Map<string, string>();
    for (const emote of set.emotes as EmoteV3[]) {
      const url = emoteUrl(emote);
      if (url) map.set(emote.name, url);
    }
    cachedMap = map;
    pendingPromise = null;
    return cachedMap;
  });

  return pendingPromise;
}

export type EmoteMap = ReadonlyMap<string, string>;

export interface UseEmotesResult {
  /** Emote name → CDN image URL */
  emoteMap: EmoteMap;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetches the 7TV global emote set once and caches it for the lifetime of
 * the renderer process. Re-mounting this hook will use the cached data.
 */
export function useEmotes(): UseEmotesResult {
  const [emoteMap, setEmoteMap] = useState<EmoteMap>(
    () => cachedMap ?? new Map(),
  );
  const [loading, setLoading] = useState(() => cachedMap === null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (cachedMap) {
      setEmoteMap(cachedMap);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    loadGlobalEmotes()
      .then((map) => {
        if (!cancelled) {
          setEmoteMap(map);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { emoteMap, loading, error };
}
