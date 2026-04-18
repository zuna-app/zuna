import { atom, createStore, useAtom } from "jotai";
import { useMutation } from "@tanstack/react-query";
import { Server } from "@/types/serverTypes";

export const serverTokensAtom = atom<Map<string, string>>(new Map());
export const serverAuthErrorsAtom = atom<Map<string, string>>(new Map());
export const serverMetaAtom = atom<
  Map<string, { name: string | null; logo: string | null }>
>(new Map());

export const jotaiStore = createStore();

export async function reauthorize(server: Server): Promise<void> {
  const sigPrivateKey = await window.vault.get("sigPrivateKey");
  if (!sigPrivateKey) throw new Error("Signing key not found in vault");

  const handshakeRes = await fetch(
    `http://${server.address}/api/auth/handshake`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: server.username }),
    },
  );
  if (!handshakeRes.ok) {
    const text = await handshakeRes.text().catch(() => handshakeRes.statusText);
    throw new Error(`Handshake failed (${handshakeRes.status}): ${text}`);
  }
  const { nonce, server_name, server_logo } = await handshakeRes.json();
  jotaiStore.set(serverMetaAtom, (prev) => {
    const next = new Map(prev);
    next.set(server.id, {
      name: server_name ?? null,
      logo: server_logo ?? null,
    });
    return next;
  });
  const signature = await window.security.signMessage(sigPrivateKey, nonce);

  const loginRes = await fetch(`http://${server.address}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: server.username, signature }),
  });
  if (!loginRes.ok) {
    const text = await loginRes.text().catch(() => loginRes.statusText);
    throw new Error(`Login failed (${loginRes.status}): ${text}`);
  }
  const { token } = await loginRes.json();

  jotaiStore.set(serverTokensAtom, (prev) => {
    const next = new Map(prev);
    next.set(server.id, token);
    return next;
  });
}

export function useAuthorizer(server: Server) {
  const [serverTokens, setServerTokens] = useAtom(serverTokensAtom, {
    store: jotaiStore,
  });
  const [serverAuthErrors, setServerAuthErrors] = useAtom(
    serverAuthErrorsAtom,
    { store: jotaiStore },
  );

  const token = serverTokens.get(server.id) ?? null;
  const error = serverAuthErrors.get(server.id) ?? null;

  const mutation = useMutation({
    mutationFn: async (
      username: string,
    ): Promise<{ token: string; name: string | null; logo: string | null }> => {
      const sigPrivateKey = await window.vault.get("sigPrivateKey");
      if (!sigPrivateKey) {
        throw new Error("Signing key not found in vault");
      }

      const handshakeRes = await fetch(
        `http://${server.address}/api/auth/handshake`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        },
      );

      if (!handshakeRes.ok) {
        const text = await handshakeRes
          .text()
          .catch(() => handshakeRes.statusText);
        throw new Error(`Handshake failed (${handshakeRes.status}): ${text}`);
      }

      const { nonce, server_name, server_logo } = await handshakeRes.json();

      const signature = await window.security.signMessage(sigPrivateKey, nonce);

      const authorizeRes = await fetch(
        `http://${server.address}/api/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, signature }),
        },
      );

      if (!authorizeRes.ok) {
        const text = await authorizeRes
          .text()
          .catch(() => authorizeRes.statusText);
        throw new Error(
          `Authorization failed (${authorizeRes.status}): ${text}`,
        );
      }

      const { token: newToken } = await authorizeRes.json();
      return {
        token: newToken,
        name: server_name ?? null,
        logo: server_logo ?? null,
      };
    },
    onMutate: () => {
      setServerAuthErrors((prev) => {
        const next = new Map(prev);
        next.delete(server.id);
        return next;
      });
    },
    onSuccess: ({ token: newToken, name, logo }) => {
      setServerTokens((prev) => {
        const next = new Map(prev);
        next.set(server.id, newToken);
        return next;
      });
      jotaiStore.set(serverMetaAtom, (prev) => {
        const next = new Map(prev);
        next.set(server.id, { name, logo });
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
    authorize: (username: string) =>
      mutation.mutateAsync(username).then((r) => r.token),
    token,
    isAuthorizing: mutation.isPending,
    error,
  };
}
