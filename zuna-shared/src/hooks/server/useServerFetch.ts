import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";
import {
  jotaiStore,
  serverTokensAtom,
  serverAuthErrorsAtom,
  serverListAtom,
  selectedServerAtom,
} from "../../store/atoms";
import type { Server } from "../../types/serverTypes";
import { usePlatform } from "../../platform/PlatformContext";

let persistedServerListPromise: Promise<Server[]> | null = null;
let shouldRetryPersistedServerListRead = false;

function isServer(value: unknown): value is Server {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<Server>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.address === "string" &&
    typeof candidate.username === "string"
  );
}

function parseStoredServerList(value: unknown): Server[] {
  if (!value) return [];

  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return [];
          }
        })()
      : value;

  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isServer);
}

function isCertError(e: unknown): boolean {
  return (
    e instanceof TypeError && /fetch|network/i.test((e as TypeError).message)
  );
}

function isVaultLockedError(e: unknown): boolean {
  return (
    e instanceof Error && /vault\s+is\s+locked|vault\s+locked/i.test(e.message)
  );
}

function certErrorMessage(address: string): string {
  return `Cannot reach ${address} — the server's SSL certificate is not trusted by your browser. Open https://${address} in a new tab, accept the certificate warning, 
  then try again or install the certificate to avoid this issue in the future.`;
}

async function safeFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (e) {
    const address = new URL(url).host;
    if (isCertError(e)) throw new Error(certErrorMessage(address));
    throw e;
  }
}

export function useServerFetch(server: Server) {
  const serverFetch = useCallback(
    async (path: string, options?: RequestInit): Promise<Response> => {
      const res = await safeFetch(`https://${server.address}${path}`, options);
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${text}`);
      }
      return res;
    },
    [server.address],
  );

  return { serverFetch };
}

export function useAuthorizedServerFetch(server: Server) {
  const [serverTokens, setServerTokens] = useAtom(serverTokensAtom, {
    store: jotaiStore,
  });
  const setServerAuthErrors = useSetAtom(serverAuthErrorsAtom, {
    store: jotaiStore,
  });

  const authorizedFetch = useCallback(
    async (path: string, options?: RequestInit): Promise<Response> => {
      const token = serverTokens.get(server.id);
      if (!token) throw new Error("No token available");

      const res = await safeFetch(`https://${server.address}${path}`, {
        ...options,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.status === 401) {
        setServerTokens((prev) => {
          const next = new Map(prev);
          next.delete(server.id);
          return next;
        });
        setServerAuthErrors((prev) => {
          const next = new Map(prev);
          next.set(server.id, "Session expired. Please re-authorize.");
          return next;
        });
        throw new Error("Unauthorized (401)");
      }

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${text}`);
      }

      return res;
    },
    [
      server.id,
      server.address,
      serverTokens,
      setServerTokens,
      setServerAuthErrors,
    ],
  );

  return { authorizedFetch };
}

export function useServerConnector() {
  const platform = usePlatform();
  const [serverList, setServerList] = useAtom(serverListAtom, {
    store: jotaiStore,
  });
  const [selectedServer, setSelectedServer] = useAtom(selectedServerAtom, {
    store: jotaiStore,
  });

  useEffect(() => {
    let cancelled = false;

    if (!persistedServerListPromise) {
      persistedServerListPromise = platform.vault
        .get("serverList")
        .then((storedServers) => parseStoredServerList(storedServers))
        .catch((error) => {
          if (isVaultLockedError(error)) {
            shouldRetryPersistedServerListRead = true;
            return [];
          }
          console.error("Failed to hydrate server list from vault", error);
          return [];
        });
    }

    persistedServerListPromise.then((storedServers) => {
      if (shouldRetryPersistedServerListRead) {
        shouldRetryPersistedServerListRead = false;
        persistedServerListPromise = null;
        return;
      }

      if (cancelled || storedServers.length === 0) return;

      setServerList((currentServers) =>
        currentServers.length > 0 ? currentServers : storedServers,
      );
      setSelectedServer((currentServer) => {
        if (
          currentServer &&
          storedServers.some((server) => server.id === currentServer.id)
        ) {
          return currentServer;
        }

        return storedServers[0] ?? null;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [platform.vault, setSelectedServer, setServerList]);

  const selectServer = (server: Server | null) => setSelectedServer(server);

  async function joinServer({
    address,
    username,
    password,
    avatar,
  }: {
    address: string;
    username: string;
    password: string;
    avatar: string;
  }): Promise<Server> {
    let encPublicKey: string | null;
    let sigPublicKey: string | null;

    try {
      [encPublicKey, sigPublicKey] = await Promise.all([
        platform.vault.get("encPublicKey"),
        platform.vault.get("sigPublicKey"),
      ]);
    } catch (error) {
      if (isVaultLockedError(error)) {
        throw new Error("Vault is locked. Unlock with your PIN and try again.");
      }
      throw error;
    }

    if (!encPublicKey || !sigPublicKey) {
      throw new Error("Encryption or signing key not found in vault");
    }

    const res = await safeFetch(`https://${address}/api/auth/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity_key: encPublicKey,
        signing_key: sigPublicKey,
        avatar,
        server_password: password,
        username,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Server returned ${res.status}: ${text}`);
    }

    const data = await res.json();
    const newServer: Server = {
      id: data.id,
      address,
      name: address,
      username,
      publicKey: data.server_public_key ?? null,
      serverId: data.server_id ?? null,
    };

    const next = [...serverList, newServer];
    setServerList(next);
    await platform.vault.set("serverList", next);
    setSelectedServer(newServer);

    return newServer;
  }

  return { serverList, selectedServer, joinServer, selectServer };
}

export function useServer(serverId: string): Server | undefined {
  const serverList = useAtomValue(serverListAtom, { store: jotaiStore });
  return serverList.find((s) => s.id === serverId);
}
