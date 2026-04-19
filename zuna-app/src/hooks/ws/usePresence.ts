import { atom, useAtomValue } from "jotai";
import { jotaiStore } from "@/hooks/auth/useAuthorizer";
import { MemberPresence } from "./wsTypes";

export const presenceAtom = atom<Map<string, MemberPresence>>(new Map());

export function usePresence() {
  const presence = useAtomValue(presenceAtom, { store: jotaiStore });
  return {
    getMemberPresence: (userId: string): MemberPresence | null =>
      presence.get(userId) ?? null,
  };
}
