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

export function useSharedSecrets(
  members: ChatMember[] | null,
): Record<string, string> | null {
  const [sharedSecrets, setSharedSecrets] = useState<Record<
    string,
    string
  > | null>(null);

  useEffect(() => {
    if (!members) {
      setSharedSecrets(null);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const privateKey = await window.vault.get("encPrivateKey");
        if (!privateKey || cancelled) return;

        const secrets: Record<string, string> = {};
        for (const member of members) {
          if (!member.identityKey) continue;
          try {
            const secret = await window.security.computeSharedSecret(
              privateKey,
              member.identityKey,
            );
            secrets[member.id] = secret;
          } catch {
            // skip members we can't compute a secret for
          }
        }
        if (!cancelled) setSharedSecrets(secrets);
      } catch {
        if (!cancelled) setSharedSecrets(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [members]);

  return sharedSecrets;
}
