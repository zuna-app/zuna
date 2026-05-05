import { useEffect, useState } from 'react';
import { EmoteV3, SevenTV, emoteUrl } from '@/lib/seventv';

const GLOBAL_KEY = '__global__';

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

async function loadEmotes(emoteSetId: string | null | undefined): Promise<EmoteCache> {
  const key = emoteSetId || GLOBAL_KEY;

  const cached = cacheByKey.get(key);
  if (cached) return cached;

  const pending = pendingByKey.get(key);
  if (pending) return pending;

  const promise = (
    emoteSetId ? SevenTV.getEmoteSet(emoteSetId) : SevenTV.getGlobalEmoteSet()
  ).then((set) => {
    const emoteMap = new Map<string, string>();
    const emoteDataMap = new Map<string, EmoteV3>();

    for (const emote of set.emotes) {
      const url = emoteUrl(emote);
      if (!url) continue;
      emoteMap.set(emote.name, url);
      emoteDataMap.set(emote.name, emote);
    }

    const result = { emoteMap, emoteDataMap };
    cacheByKey.set(key, result);
    pendingByKey.delete(key);
    return result;
  });

  pendingByKey.set(key, promise);
  return promise;
}

export function useEmotes(emoteSetId?: string | null, enabled = true) {
  const key = emoteSetId || GLOBAL_KEY;
  const [cache, setCache] = useState<EmoteCache>(() =>
    enabled ? (cacheByKey.get(key) ?? EMPTY_CACHE) : EMPTY_CACHE,
  );
  const [loading, setLoading] = useState(enabled && !cacheByKey.has(key));
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCache(EMPTY_CACHE);
      setLoading(false);
      setError(null);
      return;
    }

    const cached = cacheByKey.get(key);
    if (cached) {
      setCache(cached);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    loadEmotes(emoteSetId)
      .then((nextCache) => {
        if (cancelled) return;
        setCache(nextCache);
        setLoading(false);
      })
      .catch((nextError: unknown) => {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError : new Error(String(nextError)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [emoteSetId, enabled, key]);

  return {
    emoteMap: cache.emoteMap,
    emoteDataMap: cache.emoteDataMap,
    loading,
    error,
  };
}