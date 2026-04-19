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

interface WritingState {
  chatId: string;
  writing: boolean;
}

export const writingAtom = atom<Map<string, WritingState>>(new Map());

export function useWriting() {
  const writing = useAtomValue(writingAtom, { store: jotaiStore });
  return {
    isMemberTyping: (userId: string, chatId: string): boolean => {
      const state = writing.get(userId);
      return state?.writing === true && state.chatId === chatId;
    },
  };
}
