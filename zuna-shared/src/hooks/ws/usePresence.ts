import { useAtomValue } from "jotai";
import { jotaiStore, presenceAtom, writingAtom } from "../../store/atoms";
import type { MemberPresence } from "./wsTypes";

export function usePresence() {
  const presence = useAtomValue(presenceAtom, { store: jotaiStore });
  return {
    getMemberPresence: (userId: string): MemberPresence | null =>
      presence.get(userId) ?? null,
  };
}

export function useWriting() {
  const writing = useAtomValue(writingAtom, { store: jotaiStore });
  return {
    isMemberTyping: (userId: string, chatId: string): boolean => {
      const state = writing.get(userId);
      return state?.writing === true && state.chatId === chatId;
    },
  };
}
