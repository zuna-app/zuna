import { useAtom } from "jotai";
import { jotaiStore, selectedChatAtom } from "../../store/atoms";
import type { ChatMember } from "../../types/serverTypes";

export function useSelectedChat() {
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom, {
    store: jotaiStore,
  });
  return {
    selectedChat,
    selectChat: (chat: ChatMember | null) => setSelectedChat(chat),
  };
}
