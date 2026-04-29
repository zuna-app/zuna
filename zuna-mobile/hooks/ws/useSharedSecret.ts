import { useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { jotaiStore, vaultAtom } from '@/store/atoms';
import { computeSharedSecret } from '@/lib/crypto/x25519';
import { ChatMember } from '@/types/serverTypes';

// Module-level cache: identity key → shared secret (base64)
const sharedSecretCache = new Map<string, string>();

export function useSharedSecret(member: ChatMember | null): string | null {
  const vault = useAtomValue(vaultAtom, { store: jotaiStore });

  if (!member || !vault) return null;

  const cached = sharedSecretCache.get(member.identityKey);
  if (cached) return cached;

  const encPrivateKey = vault['encPrivateKey'] as string | undefined;
  if (!encPrivateKey) return null;

  try {
    const secret = computeSharedSecret(encPrivateKey, member.identityKey);
    sharedSecretCache.set(member.identityKey, secret);
    return secret;
  } catch {
    return null;
  }
}

export function computeSharedSecretFromVault(
  vault: Record<string, unknown>,
  identityKey: string,
): string | null {
  const cached = sharedSecretCache.get(identityKey);
  if (cached) return cached;

  const encPrivateKey = vault['encPrivateKey'] as string | undefined;
  if (!encPrivateKey) return null;

  try {
    const secret = computeSharedSecret(encPrivateKey, identityKey);
    sharedSecretCache.set(identityKey, secret);
    return secret;
  } catch {
    return null;
  }
}

export function clearSharedSecretCache(): void {
  sharedSecretCache.clear();
}
