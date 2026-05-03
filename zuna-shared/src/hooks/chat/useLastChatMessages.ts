import { useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { decrypt } from "../../crypto/x25519";
import {
  computeSharedSecretFromVault,
  useSharedSecrets,
} from "../ws/useSharedSecret";
import { jotaiStore, lastMessagesAtom, vaultAtom } from "../../store/atoms";
import type { LastMessage } from "../../types/serverTypes";
import type { ChatMember, Server } from "../../types/serverTypes";

export function useLastMessagesUpdater() {
  const [lastMessages, setLastMessages] = useAtom(lastMessagesAtom, {
    store: jotaiStore,
  });

  function updateLastMessage(msg: LastMessage) {
    setLastMessages((prev) => ({ ...prev, [msg.chatId]: msg }));
  }

  return { lastMessages, updateLastMessage };
}

export function useLastChatMessages(_server?: Server, data?: ChatMember[]) {
  const state = useLastMessagesUpdater();
  const vault = useAtomValue(vaultAtom, { store: jotaiStore });
  const sharedSecrets = useSharedSecrets(data ?? null);

  useEffect(() => {
    if (!data?.length) return;

    for (const member of data) {
      if (state.lastMessages[member.chatId]) continue;

      const secret =
        sharedSecrets?.[member.id] ??
        (vault
          ? computeSharedSecretFromVault(vault, member.identityKey)
          : null);
      if (!secret || !member.ciphertext || !member.iv || !member.authTag) {
        continue;
      }

      try {
        const plaintext = decrypt(secret, {
          ciphertext: member.ciphertext,
          iv: member.iv,
          authTag: member.authTag,
        });

        state.updateLastMessage({
          chatId: member.chatId,
          senderId: member.senderId,
          content: plaintext,
          unreadMessages: member.unreadMessages ?? 0,
          lastActivityAt: member.lastActivityAt ?? 0,
        });
      } catch {
        // Ignore invalid preview payloads from server and keep fallback text.
      }
    }
  }, [data, sharedSecrets, vault, state.lastMessages, state.updateLastMessage]);

  return state;
}
