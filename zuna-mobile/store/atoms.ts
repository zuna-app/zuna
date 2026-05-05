import { atom, createStore } from 'jotai';
import type { Server, ChatMember, LastMessage, Message } from '@/types/serverTypes';
import type { MemberPresence } from '@/hooks/ws/wsTypes';

export const jotaiStore = createStore();

// Auth
export const serverTokensAtom = atom<Map<string, string>>(new Map());
export const serverAuthErrorsAtom = atom<Map<string, string>>(new Map());
export const serverMetaAtom = atom<
  Map<
    string,
    {
      name: string | null;
      logo: string | null;
      sevenTvEmotesSet: string | null;
      sevenTvEnabled: boolean;
    }
  >
>(new Map());

// Server management
export const serverListAtom = atom<Server[]>([]);
export const selectedServerAtom = atom<Server | null>(null);

// Chat
export const selectedChatAtom = atom<ChatMember | null>(null);
export const lastMessagesAtom = atom<Record<string, LastMessage>>({});

// Vault
export const vaultAtom = atom<Record<string, unknown> | null>(null);
export const vaultPinAtom = atom<string | null>(null);

// Real-time
export const presenceAtom = atom<Map<string, MemberPresence>>(new Map());
export const writingAtom = atom<Map<string, { chatId: string; writing: boolean }>>(new Map());
