import { useState, useEffect } from "react";
import { ChatMember } from "@/types/serverTypes";

// Session-level caches — keyed by identity key (public key), valid for entire session.
// `computeSharedSecret` is pure/deterministic; no need to recompute per render/refetch.
const sharedSecretCache = new Map<string, string>();
let cachedPrivateKey: string | null = null;

async function getPrivateKey(): Promise<string | null> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const key = await window.vault.get("encPrivateKey");
  if (key) cachedPrivateKey = key;
  return cachedPrivateKey;
}

async function getSharedSecret(identityKey: string): Promise<string | null> {
  const cached = sharedSecretCache.get(identityKey);
  if (cached) return cached;
  const privateKey = await getPrivateKey();
  if (!privateKey) return null;
  const secret = await window.security.computeSharedSecret(
    privateKey,
    identityKey,
  );
  sharedSecretCache.set(identityKey, secret);
  return secret;
}

export function useSharedSecret(member: ChatMember | null): string | null {
  const [sharedSecret, setSharedSecret] = useState<string | null>(() =>
    member?.identityKey
      ? (sharedSecretCache.get(member.identityKey) ?? null)
      : null,
  );

  useEffect(() => {
    if (!member?.identityKey) {
      setSharedSecret(null);
      return;
    }

    // Return cached value synchronously without IPC
    const cached = sharedSecretCache.get(member.identityKey);
    if (cached) {
      setSharedSecret(cached);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const secret = await getSharedSecret(member.identityKey);
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
    if (!members || members.length === 0) {
      setSharedSecrets(null);
      return;
    }

    // If every member's secret is already cached, return synchronously with no IPC
    const membersWithKeys = members.filter((m) => m.identityKey);
    const allCached = membersWithKeys.every((m) =>
      sharedSecretCache.has(m.identityKey),
    );
    if (allCached) {
      const secrets: Record<string, string> = {};
      for (const m of membersWithKeys) {
        secrets[m.id] = sharedSecretCache.get(m.identityKey)!;
      }
      setSharedSecrets(secrets);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Only fetch secrets for uncached identity keys; resolve cached ones immediately
        const results = await Promise.all(
          membersWithKeys.map(async (member) => {
            try {
              const secret = await getSharedSecret(member.identityKey);
              return secret ? { id: member.id, secret } : null;
            } catch {
              return null;
            }
          }),
        );

        if (!cancelled) {
          const secrets: Record<string, string> = {};
          for (const result of results) {
            if (result) secrets[result.id] = result.secret;
          }
          setSharedSecrets(secrets);
        }
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
