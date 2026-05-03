import { useState, useEffect } from "react";
import { computeSharedSecret } from "../../crypto/x25519";
import { usePlatform } from "../../platform/PlatformContext";
import type { ChatMember } from "../../types/serverTypes";

// Session-level cache — keyed by identity key, valid for entire session.
const sharedSecretCache = new Map<string, string>();
let cachedPrivateKey: string | null = null;

async function getPrivateKey(
  vault: ReturnType<typeof usePlatform>["vault"],
): Promise<string | null> {
  if (cachedPrivateKey) return cachedPrivateKey;
  const key = await vault.get("encPrivateKey");
  if (key) cachedPrivateKey = key as string;
  return cachedPrivateKey;
}

async function getSharedSecret(
  vault: ReturnType<typeof usePlatform>["vault"],
  identityKey: string,
): Promise<string | null> {
  const cached = sharedSecretCache.get(identityKey);
  if (cached) return cached;
  const privateKey = await getPrivateKey(vault);
  if (!privateKey) return null;
  const secret = computeSharedSecret(privateKey, identityKey);
  sharedSecretCache.set(identityKey, secret);
  return secret;
}

export function computeSharedSecretFromVault(
  vault: Record<string, unknown>,
  identityKey: string,
): string | null {
  const privateKey = vault["encPrivateKey"] as string | undefined;
  if (!privateKey) return null;
  const cached = sharedSecretCache.get(identityKey);
  if (cached) return cached;
  const secret = computeSharedSecret(privateKey, identityKey);
  sharedSecretCache.set(identityKey, secret);
  return secret;
}

export function clearSharedSecretCache(): void {
  sharedSecretCache.clear();
  cachedPrivateKey = null;
}

export function useSharedSecret(member: ChatMember | null): string | null {
  const platform = usePlatform();
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

    const cached = sharedSecretCache.get(member.identityKey);
    if (cached) {
      setSharedSecret(cached);
      return;
    }

    let cancelled = false;
    getSharedSecret(platform.vault, member.identityKey)
      .then((secret) => {
        if (!cancelled) setSharedSecret(secret);
      })
      .catch(() => {
        if (!cancelled) setSharedSecret(null);
      });

    return () => {
      cancelled = true;
    };
  }, [member?.id]);

  return sharedSecret;
}

export function useSharedSecrets(
  members: ChatMember[] | null,
): Record<string, string> | null {
  const platform = usePlatform();
  const [sharedSecrets, setSharedSecrets] = useState<Record<
    string,
    string
  > | null>(null);

  useEffect(() => {
    if (!members || members.length === 0) {
      setSharedSecrets(null);
      return;
    }

    let cancelled = false;

    Promise.all(
      members.map(async (m) => {
        const secret = await getSharedSecret(platform.vault, m.identityKey);
        return [m.id, secret] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const result: Record<string, string> = {};
      for (const [id, secret] of entries) {
        if (secret) result[id] = secret;
      }
      setSharedSecrets(result);
    });

    return () => {
      cancelled = true;
    };
  }, [members?.map((m) => m.id).join(",")]);

  return sharedSecrets;
}
