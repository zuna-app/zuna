import { useAtomValue } from "jotai";
import { currentUserAtom, jotaiStore } from "../../store/atoms";
import type { Server } from "../../types/serverTypes";

export type CurrentUser = {
  username: string;
  avatar: string;
};

/**
 * Returns the current authenticated user's username and avatar URL for the
 * given server, or `null` if not yet resolved (e.g. before the first
 * successful authorization or on first render before cache hydration).
 */
export function useCurrentUser(server: Server): CurrentUser | null {
  const currentUsers = useAtomValue(currentUserAtom, { store: jotaiStore });
  return currentUsers.get(server.id) ?? null;
}
