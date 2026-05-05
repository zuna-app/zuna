import { useMutation } from '@tanstack/react-query';
import { useAtom, useAtomValue } from 'jotai';
import {
  jotaiStore,
  serverTokensAtom,
  serverAuthErrorsAtom,
  serverMetaAtom,
  vaultAtom,
} from '@/store/atoms';
import { signMessage } from '@/lib/crypto/ed25519';
import { verifySignature } from '@/lib/crypto/ed25519';
import { Server } from '@/types/serverTypes';

export async function reauthorize(server: Server): Promise<void> {
  const vault = jotaiStore.get(vaultAtom);
  const sigPrivateKey = vault?.['sigPrivateKey'] as string | undefined;
  if (!sigPrivateKey) throw new Error('Signing key not found in vault');

  const handshakeRes = await fetch(`https://${server.address}/api/auth/handshake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: server.username }),
  });
  if (!handshakeRes.ok) throw new Error(`Handshake failed (${handshakeRes.status})`);

  const { nonce } = await handshakeRes.json();
  const signature = signMessage(sigPrivateKey, nonce);

  const loginRes = await fetch(`https://${server.address}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: server.username, signature }),
  });
  if (!loginRes.ok) throw new Error(`Login failed (${loginRes.status})`);

  const { token } = await loginRes.json();
  jotaiStore.set(serverTokensAtom, (prev) => {
    const next = new Map(prev);
    next.set(server.id, token);
    return next;
  });
}

export function useAuthorizer(server: Server) {
  const [serverTokens, setServerTokens] = useAtom(serverTokensAtom, { store: jotaiStore });
  const [serverAuthErrors, setServerAuthErrors] = useAtom(serverAuthErrorsAtom, {
    store: jotaiStore,
  });
  const vault = useAtomValue(vaultAtom, { store: jotaiStore });

  const token = serverTokens.get(server.id) ?? null;
  const error = serverAuthErrors.get(server.id) ?? null;

  const mutation = useMutation({
    mutationFn: async (username: string) => {
      const sigPrivateKey = vault?.['sigPrivateKey'] as string | undefined;
      if (!sigPrivateKey) throw new Error('Signing key not found in vault');

      const handshakeRes = await fetch(`https://${server.address}/api/auth/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      if (!handshakeRes.ok) {
        const text = await handshakeRes.text().catch(() => handshakeRes.statusText);
        throw new Error(`Handshake failed (${handshakeRes.status}): ${text}`);
      }

      const { nonce, seven_tv_emotes_set, seven_tv_enabled } =
        await handshakeRes.json();

      const signature = signMessage(sigPrivateKey, nonce);

      const loginRes = await fetch(`https://${server.address}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, signature }),
      });
      if (!loginRes.ok) {
        const text = await loginRes.text().catch(() => loginRes.statusText);
        throw new Error(`Login failed (${loginRes.status}): ${text}`);
      }

      const { token: newToken, server_id, signature: serverSignature } = await loginRes.json();

      if (server.publicKey && server_id && serverSignature) {
        const isValid = verifySignature(server.publicKey, server_id, serverSignature);
        if (!isValid) throw new Error('Invalid server signature — possible MITM attack');
      }

      return {
        token: newToken,
        sevenTvEmotesSet: seven_tv_emotes_set ?? null,
        sevenTvEnabled: seven_tv_enabled ?? true,
      };
    },
    onMutate: () => {
      setServerAuthErrors((prev) => {
        const next = new Map(prev);
        next.delete(server.id);
        return next;
      });
    },
    onSuccess: ({ token: newToken, sevenTvEmotesSet, sevenTvEnabled }) => {
      setServerTokens((prev) => {
        const next = new Map(prev);
        next.set(server.id, newToken);
        return next;
      });

      jotaiStore.set(serverMetaAtom, (prev) => {
        const next = new Map(prev);
        const existing = prev.get(server.id);
        next.set(server.id, {
          name: existing?.name ?? null,
          logo: existing?.logo ?? null,
          sevenTvEmotesSet,
          sevenTvEnabled,
        });
        return next;
      });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      setServerAuthErrors((prev) => {
        const next = new Map(prev);
        next.set(server.id, message);
        return next;
      });
    },
  });

  return {
    authorize: (username: string) => mutation.mutateAsync(username),
    token,
    isAuthorizing: mutation.isPending,
    error,
  };
}

export async function fetchAndUpdateServerInfos(servers: Server[]): Promise<void> {
  await Promise.allSettled(
    servers.map(async (server) => {
      try {
        const res = await fetch(`https://${server.address}/api/auth/info`);
        if (!res.ok) return;
        const { server_name, server_logo } = await res.json();
        jotaiStore.set(serverMetaAtom, (prev) => {
          const next = new Map(prev);
          const existing = prev.get(server.id);
          next.set(server.id, {
            name: server_name ?? null,
            logo: server_logo ?? null,
            sevenTvEmotesSet: existing?.sevenTvEmotesSet ?? null,
            sevenTvEnabled: existing?.sevenTvEnabled ?? true,
          });
          return next;
        });
      } catch (err) {
        console.error(`Failed to fetch server info for ${server.address}:`, err);
      }
    })
  );
}
