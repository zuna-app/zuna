import { atom, useAtom } from "jotai";
import { Chat } from "@/types/serverTypes";

export const selectedChatAtom = atom<Chat | null>(null);

export function useSelectedChat() {
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom);

  const selectChat = (chat: Chat | null) => setSelectedChat(chat);

  return { selectedChat, selectChat };
}
