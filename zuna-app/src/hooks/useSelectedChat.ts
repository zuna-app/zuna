import { atom, useAtom } from "jotai";
import { Chat } from "@/types/serverTypes";

export const selectedChatAtom = atom<string | null>(null);

export function useSelectedChat() {
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom);

  const selectChat = (chat: string | null) => setSelectedChat(chat);

  return { selectedChat, selectChat };
}
