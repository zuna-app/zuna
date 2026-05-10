import { atom, createStore } from "jotai";
import type {
  Server,
  ChatMember,
  LastMessage,
  Channel,
  ChannelMessage,
  ChannelMember,
  VoiceParticipant,
} from "../types/serverTypes";
import type { MemberPresence } from "../hooks/ws/wsTypes";

export const jotaiStore = createStore();

// ── Auth ─────────────────────────────────────────────────────────────────────
export const serverTokensAtom = atom<Map<string, string>>(new Map());
export const serverAuthErrorsAtom = atom<Map<string, string>>(new Map());
export const serverMetaAtom = atom<
  Map<
    string,
    {
      name: string | null;
      logo: string | null;
      gatewayAddress: string | null;
      sevenTvEmotesSet: string | null;
      sevenTvEnabled: boolean | null;
    }
  >
>(new Map());

// ── Server management ─────────────────────────────────────────────────────────
export const serverListAtom = atom<Server[]>([]);
export const selectedServerAtom = atom<Server | null>(null);

// ── Chat ─────────────────────────────────────────────────────────────────────
export const selectedChatAtom = atom<ChatMember | null>(null);
export const lastMessagesAtom = atom<Record<string, LastMessage>>({});

// ── Vault (in-memory decrypted state) ────────────────────────────────────────
export const vaultAtom = atom<Record<string, unknown> | null>(null);

// ── Current user (per server) ─────────────────────────────────────────────────
export const currentUserAtom = atom<
  Map<string, { username: string; avatar: string }>
>(new Map());

// ── Real-time presence ───────────────────────────────────────────────────────
export const presenceAtom = atom<Map<string, MemberPresence>>(new Map());

interface WritingState {
  chatId: string;
  writing: boolean;
}
export const writingAtom = atom<Map<string, WritingState>>(new Map());

// ── Channels ─────────────────────────────────────────────────────────────────
export const channelsAtom = atom<Channel[]>([]);
export const selectedChannelAtom = atom<Channel | null>(null);
export const channelMessagesAtom = atom<Map<string, ChannelMessage[]>>(
  new Map(),
);
// channelId → unread message count
export const channelUnreadAtom = atom<Map<string, number>>(new Map());
export const channelMembersAtom = atom<Map<string, ChannelMember[]>>(new Map());

interface ChannelWritingState {
  username: string;
}
// channelId → Map<senderId, ChannelWritingState>
export const channelWritingAtom = atom<
  Map<string, Map<string, ChannelWritingState>>
>(new Map());

// ── Voice channels ────────────────────────────────────────────────────────────
// channelId → list of connected participants
export const voiceChannelParticipantsAtom = atom<Map<string, VoiceParticipant[]>>(new Map());
// active voice channel info for the current user, or null
export const activeVoiceChannelAtom = atom<{ id: string; name: string } | null>(null);
export const voiceMutedAtom = atom<boolean>(false);
// set of user IDs currently speaking (LiveKit active speakers)
export const voiceSpeakingAtom = atom<Set<string>>(new Set<string>());
