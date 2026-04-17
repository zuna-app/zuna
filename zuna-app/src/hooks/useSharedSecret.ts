import { useState, useEffect } from "react";
import { ChatMember } from "@/types/serverTypes";

export function useSharedSecret(member: ChatMember | null): string | null {
  const [sharedSecret, setSharedSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!member?.identityKey) {
      setSharedSecret(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const privateKey = await window.vault.get("encPrivateKey");
        if (!privateKey || cancelled) return;
        const secret = await window.security.computeSharedSecret(
          privateKey,
          member.identityKey,
        );
        if (!cancelled) setSharedSecret(secret);
      } catch {
        if (!cancelled) setSharedSecret(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [member?.id]);

  return sharedSecret;
}
