import { useAtom } from 'jotai';
import { jotaiStore, lastMessagesAtom } from '@/store/atoms';
import { LastMessage } from '@/types/serverTypes';

export function useLastMessagesUpdater() {
  const [lastMessages, setLastMessages] = useAtom(lastMessagesAtom, { store: jotaiStore });

  function updateLastMessage(msg: LastMessage) {
    setLastMessages((prev) => ({ ...prev, [msg.chatId]: msg }));
  }

  return { lastMessages, updateLastMessage };
}
