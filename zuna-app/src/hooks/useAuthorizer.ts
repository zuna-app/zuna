import { atom, useAtom } from "jotai";
import { useState } from "react";
import { Server } from "@/types/serverTypes";

export const serverTokensAtom = atom<Map<string, string>>(new Map());

export function useAuthorizer(server: Server) {
  const [serverTokens, setServerTokens] = useAtom(serverTokensAtom);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = serverTokens.get(server.id) ?? null;

  const authorize = async (username: string): Promise<string> => {
    setIsAuthorizing(true);
    setError(null);

    try {
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

      const { nonce } = await handshakeRes.json();

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

      setServerTokens((prev) => {
        const next = new Map(prev);
        next.set(server.id, newToken);
        return next;
      });

      return newToken;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setIsAuthorizing(false);
    }
  };

  return { authorize, token, isAuthorizing, error };
}
