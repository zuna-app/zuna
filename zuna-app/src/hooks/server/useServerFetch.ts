import { useAtom, useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  serverTokensAtom,
  serverAuthErrorsAtom,
} from "@/hooks/auth/useAuthorizer";
import { Server } from "@/types/serverTypes";

export function useServerFetch(server: Server) {
  const serverFetch = useCallback(
    async (path: string, options?: RequestInit): Promise<Response> => {
      const res = await fetch(`http://${server.address}${path}`, options);
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
  const [serverTokens, setServerTokens] = useAtom(serverTokensAtom);
  const setServerAuthErrors = useSetAtom(serverAuthErrorsAtom);

  const authorizedFetch = useCallback(
    async (path: string, options?: RequestInit): Promise<Response> => {
      const token = serverTokens.get(server.id);
      if (!token) throw new Error("No token available");

      const res = await fetch(`http://${server.address}${path}`, {
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
