import { useMemo } from "react";
import { useApp } from "@/state/store";

const EMPTY = new Map<string, string>();

/**
 * What message rendering needs to know about the current server. Everything here
 * is stable across presence updates, so visible messages don't re-render for them.
 */
export function useMarkupContext() {
  const serverUrl = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId]?.entry.url : undefined)) ?? "";
  const selfId = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId]?.self?.userId : undefined)) ?? "";
  const mentionable = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId]?.mentionable : undefined)) ?? EMPTY;
  return useMemo(() => ({ serverUrl, mentionable, selfId }), [serverUrl, mentionable, selfId]);
}
