// What a message reads of its server, picked narrowly so it only draws again when that changes.

import { useApp } from "@/state/store";

/** Narrow selectors, so a message only re-renders when something it shows changes. */
export const useServerField = <T,>(pick: (server: NonNullable<ReturnType<typeof serverOf>>) => T, fallback: T): T =>
  useApp((state) => {
    const server = serverOf(state);
    return server ? pick(server) : fallback;
  });

export function serverOf(state: ReturnType<typeof useApp.getState>) {
  return state.activeServerId ? state.servers[state.activeServerId] : undefined;
}
