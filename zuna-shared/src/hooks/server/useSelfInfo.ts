import { useState, useEffect } from "react";
import { usePlatform } from "../../platform/PlatformContext";
import { jotaiStore, currentUserAtom } from "../../store/atoms";
import type { Server } from "../../types/serverTypes";

export interface SelfInfo {
  username: string;
  avatar: string;
}

/**
 * Returns the current user's username and avatar URL for the given server.
 * Falls back to `server.username` and an empty avatar until the cache resolves.
 */
export function useSelfInfo(server: Server): SelfInfo {
  const platform = usePlatform();
  const [selfInfo, setSelfInfo] = useState<SelfInfo>({
    username: server.username,
    avatar: "",
  });

  useEffect(() => {
    let cancelled = false;
    platform.cache
      .get<SelfInfo>("user-cache", `self-${server.id}`)
      .then((info) => {
        if (!cancelled && info) {
          setSelfInfo(info);
          // Hydrate the in-memory atom so other consumers (e.g. optimistic
          // channel messages) get the value without an async read.
          jotaiStore.set(currentUserAtom, (prev) => {
            const next = new Map(prev);
            next.set(server.id, info);
            return next;
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [server.id, platform.cache]);

  return selfInfo;
}

/**
 * Non-hook version — resolves self info from cache once.
 */
export async function getSelfInfo(
  cache: { get<T>(cacheName: string, key: string): Promise<T | null> },
  server: Server,
): Promise<SelfInfo> {
  const info = await cache
    .get<SelfInfo>("user-cache", `self-${server.id}`)
    .catch(() => null);
  return info ?? { username: server.username, avatar: "" };
}
