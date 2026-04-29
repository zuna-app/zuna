import { atom, useAtomValue } from 'jotai';
import { jotaiStore } from '@/store/atoms';
import type { MemberPresence } from './wsTypes';

// Re-exported atoms used by useWsConnection
export const presenceAtom = atom<Map<string, MemberPresence>>(new Map());
export const writingAtom = atom<Map<string, { chatId: string; writing: boolean }>>(new Map());

export function usePresence() {
  const presence = useAtomValue(presenceAtom, { store: jotaiStore });

  function getMemberPresence(userId: string): MemberPresence | undefined {
    return presence.get(userId);
  }

  return { getMemberPresence };
}

export function useWriting() {
  const writing = useAtomValue(writingAtom, { store: jotaiStore });

  function isMemberTyping(userId: string, chatId: string): boolean {
    const entry = writing.get(userId);
    return !!entry?.writing && entry.chatId === chatId;
  }

  return { isMemberTyping };
}
