import { useState, useEffect } from "react";
import { SevenTV, emoteUrl, EmoteV3 } from "@/lib/seventv";

// Module-level caches keyed by emote set ID (GLOBAL_KEY = global set).
const GLOBAL_KEY = "__global__";
const cacheByKey = new Map<string, ReadonlyMap<string, string>>();
const pendingByKey = new Map<string, Promise<ReadonlyMap<string, string>>>();

const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

async function loadEmotes(
  emoteSetId: string | null | undefined,
): Promise<ReadonlyMap<string, string>> {
  const key = emoteSetId || GLOBAL_KEY;

  const cached = cacheByKey.get(key);
  if (cached) return cached;

  const pending = pendingByKey.get(key);
  if (pending) return pending;

  const promise = (
    emoteSetId ? SevenTV.getEmoteSet(emoteSetId) : SevenTV.getGlobalEmoteSet()
  ).then((set) => {
    const map = new Map<string, string>();
    for (const emote of set.emotes as EmoteV3[]) {
      const url = emoteUrl(emote);
      if (url) map.set(emote.name, url);
    }
    const result: ReadonlyMap<string, string> = map;
    cacheByKey.set(key, result);
    pendingByKey.delete(key);
    return result;
  });

  pendingByKey.set(key, promise);
  return promise;
}

export type EmoteMap = ReadonlyMap<string, string>;

export interface UseEmotesResult {
  /** Emote name → CDN image URL */
  emoteMap: EmoteMap;
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

  const [emoteMap, setEmoteMap] = useState<EmoteMap>(() =>
    enabled ? (cacheByKey.get(key) ?? EMPTY_MAP) : EMPTY_MAP,
  );
  const [loading, setLoading] = useState(() => enabled && !cacheByKey.has(key));
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEmoteMap(EMPTY_MAP);
      setLoading(false);
      return;
    }

    const cached = cacheByKey.get(key);
    if (cached) {
      setEmoteMap(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    loadEmotes(emoteSetId)
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
  }, [enabled, key]);

  return { emoteMap, loading, error };
}
