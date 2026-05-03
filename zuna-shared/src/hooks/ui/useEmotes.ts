import { useState, useEffect } from "react";
import { SevenTV, emoteUrl, EmoteV3 } from "../../lib/seventv";

// Module-level caches keyed by emote set ID (GLOBAL_KEY = global set).
const GLOBAL_KEY = "__global__";

interface EmoteCache {
  emoteMap: ReadonlyMap<string, string>;
  emoteDataMap: ReadonlyMap<string, EmoteV3>;
}

const cacheByKey = new Map<string, EmoteCache>();
const pendingByKey = new Map<string, Promise<EmoteCache>>();

const EMPTY_CACHE: EmoteCache = {
  emoteMap: new Map<string, string>(),
  emoteDataMap: new Map<string, EmoteV3>(),
};

async function loadEmotes(
  emoteSetId: string | null | undefined,
): Promise<EmoteCache> {
  const key = emoteSetId || GLOBAL_KEY;

  const cached = cacheByKey.get(key);
  if (cached) return cached;

  const pending = pendingByKey.get(key);
  if (pending) return pending;

  const promise = (
    emoteSetId ? SevenTV.getEmoteSet(emoteSetId) : SevenTV.getGlobalEmoteSet()
  ).then((set) => {
    const urlMap = new Map<string, string>();
    const dataMap = new Map<string, EmoteV3>();
    for (const emote of set.emotes as EmoteV3[]) {
      const url = emoteUrl(emote);
      if (url) {
        urlMap.set(emote.name, url);
        dataMap.set(emote.name, emote);
      }
    }
    const result: EmoteCache = { emoteMap: urlMap, emoteDataMap: dataMap };
    cacheByKey.set(key, result);
    pendingByKey.delete(key);
    return result;
  });

  pendingByKey.set(key, promise);
  return promise;
}

export type EmoteMap = ReadonlyMap<string, string>;
export type EmoteDataMap = ReadonlyMap<string, EmoteV3>;

export interface UseEmotesResult {
  /** Emote name → CDN image URL */
  emoteMap: EmoteMap;
  /** Emote name → full EmoteV3 data (for hover panels etc.) */
  emoteDataMap: EmoteDataMap;
  loading: boolean;
  error: Error | null;
}

/**
 * Fetches a 7TV emote set once and caches it for the lifetime of the renderer
 * process. Pass `emoteSetId` to use a specific set, or omit it to use the
 * global set. Set `enabled` to false to skip fetching entirely.
 */
export function useEmotes(
  emoteSetId?: string | null,
  enabled: boolean = true,
): UseEmotesResult {
  const key = emoteSetId || GLOBAL_KEY;

  const [cache, setCache] = useState<EmoteCache>(() =>
    enabled ? (cacheByKey.get(key) ?? EMPTY_CACHE) : EMPTY_CACHE,
  );
  const [loading, setLoading] = useState(() => enabled && !cacheByKey.has(key));
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCache(EMPTY_CACHE);
      setLoading(false);
      return;
    }

    const cached = cacheByKey.get(key);
    if (cached) {
      setCache(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    loadEmotes(emoteSetId)
      .then((c) => {
        if (!cancelled) {
          setCache(c);
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
  }, [enabled, key]);

  return {
    emoteMap: cache.emoteMap,
    emoteDataMap: cache.emoteDataMap,
    loading,
    error,
  };
}
