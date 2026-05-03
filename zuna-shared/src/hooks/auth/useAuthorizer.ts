import { useAtom } from "jotai";
import { useMutation } from "@tanstack/react-query";
import { signMessage, verifySignature } from "../../crypto/ed25519";
import { usePlatform } from "../../platform/PlatformContext";
import {
  jotaiStore,
  serverTokensAtom,
  serverAuthErrorsAtom,
  serverMetaAtom,
} from "../../store/atoms";
import type { Server } from "../../types/serverTypes";

function isVaultLockedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /vault\s+is\s+locked|vault\s+locked/i.test(error.message)
  );
}

async function getSigningKeyOrThrow(
  vault: ReturnType<typeof usePlatform>["vault"],
): Promise<string> {
  try {
    const sigPrivateKey = await vault.get("sigPrivateKey");
    if (!sigPrivateKey) {
      throw new Error("Signing key not found in vault");
    }
    return sigPrivateKey;
  } catch (error) {
    if (isVaultLockedError(error)) {
      throw new Error("Vault is locked. Unlock with your PIN and try again.");
    }
    throw error;
  }
}

function saveGatewayToVault(
  vault: ReturnType<typeof usePlatform>["vault"],
  serverId: string,
  gatewayAddress: string | null,
) {
  vault
    .get("gatewayList")
    .then((data) => {
      const obj = data ? JSON.parse(data as string) : {};
      obj[serverId] = gatewayAddress;
      vault.set("gatewayList", JSON.stringify(obj)).catch((err: unknown) => {
        console.error("Failed to save gateway address to vault", err);
      });
    })
    .catch((err: unknown) => {
      console.error("Failed to retrieve gateway addresses from vault", err);
    });
}

export async function getGatewayFromVault(
  vault: ReturnType<typeof usePlatform>["vault"],
  serverId: string,
): Promise<string | null> {
  try {
    const data = await vault.get("gatewayList");
    if (!data) return null;
    const obj = JSON.parse(data as string);
    return obj[serverId] ?? null;
  } catch {
    return null;
  }
}

export async function fetchAndUpdateServerInfos(
  servers: Server[],
): Promise<void> {
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
            gatewayAddress: existing?.gatewayAddress ?? null,
            sevenTvEmotesSet: existing?.sevenTvEmotesSet ?? null,
            sevenTvEnabled: existing?.sevenTvEnabled ?? null,
          });
          return next;
        });
      } catch (err) {
        console.error(
          `Failed to fetch server info for ${server.address}:`,
          err,
        );
      }
    }),
  );
}

export async function reauthorize(
  server: Server,
  vault: ReturnType<typeof usePlatform>["vault"],
): Promise<void> {
  const sigPrivateKey = await getSigningKeyOrThrow(vault);

  const handshakeRes = await fetch(
    `https://${server.address}/api/auth/handshake`,
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
  const { nonce, gateway_address, seven_tv_emotes_set, seven_tv_enabled } =
    await handshakeRes.json();

  jotaiStore.set(serverMetaAtom, (prev) => {
    const next = new Map(prev);
    const existing = prev.get(server.id);
    next.set(server.id, {
      name: existing?.name ?? null,
      logo: existing?.logo ?? null,
      gatewayAddress: gateway_address ?? null,
      sevenTvEmotesSet: seven_tv_emotes_set ?? null,
      sevenTvEnabled: seven_tv_enabled ?? null,
    });
    return next;
  });
  saveGatewayToVault(vault, server.id, gateway_address);

  const signature = signMessage(sigPrivateKey as string, nonce);

  const loginRes = await fetch(`https://${server.address}/api/auth/login`, {
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
  const platform = usePlatform();
  const [serverTokens, setServerTokens] = useAtom(serverTokensAtom, {
    store: jotaiStore,
  });
  const [serverAuthErrors, setServerAuthErrors] = useAtom(
    serverAuthErrorsAtom,
    {
      store: jotaiStore,
    },
  );

  const token = serverTokens.get(server.id) ?? null;
  const error = serverAuthErrors.get(server.id) ?? null;

  const mutation = useMutation({
    mutationFn: async (
      username: string,
    ): Promise<{
      token: string;
      gatewayAddress: string | null;
      sevenTvEmotesSet: string | null;
      sevenTvEnabled: boolean | null;
    }> => {
      const sigPrivateKey = await getSigningKeyOrThrow(platform.vault);

      const handshakeRes = await fetch(
        `https://${server.address}/api/auth/handshake`,
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

      const { nonce, gateway_address, seven_tv_emotes_set, seven_tv_enabled } =
        await handshakeRes.json();

      const signature = signMessage(sigPrivateKey as string, nonce);

      const authorizeRes = await fetch(
        `https://${server.address}/api/auth/login`,
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

      const {
        token: newToken,
        server_id,
        signature: serverSignature,
      } = await authorizeRes.json();

      // MITM check — only verify if the server supplied a public key on join
      if (server.publicKey && server_id && serverSignature) {
        const isValid = verifySignature(
          server.publicKey,
          server_id,
          serverSignature,
        );
        if (!isValid) {
          throw new Error(
            "Invalid signature from server. Possible MITM attack?",
          );
        }
      }

      // Cache user map for avatar/username lookups
      const usersRes = await fetch(`https://${server.address}/api/chat/users`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${newToken}`,
        },
      });
      if (usersRes.ok) {
        const { users } = await usersRes.json();
        if (Array.isArray(users)) {
          const existing =
            (await platform.cache.get<Record<string, unknown>>(
              "user-cache",
              "users",
            )) ?? {};
          const usersMap: Record<string, { username: string; avatar: string }> =
            {
              ...(existing as Record<
                string,
                { username: string; avatar: string }
              >),
            };
          for (const user of users) {
            const avatarUrl = `https://${server.address}/api/chat/avatar?user_id=${encodeURIComponent(
              user.id,
            )}`;
            usersMap[user.id] = {
              username: user.username,
              avatar: avatarUrl,
            };
          }
          await platform.cache
            .set("user-cache", "users", usersMap)
            .catch((err: unknown) => {
              console.error("Failed to save users to cache", err);
            });
        }
      }

      return {
        token: newToken,
        gatewayAddress: gateway_address ?? null,
        sevenTvEmotesSet: seven_tv_emotes_set ?? null,
        sevenTvEnabled: seven_tv_enabled ?? null,
      };
    },
    onMutate: () => {
      setServerAuthErrors((prev) => {
        const next = new Map(prev);
        next.delete(server.id);
        return next;
      });
    },
    onSuccess: ({
      token: newToken,
      gatewayAddress,
      sevenTvEmotesSet,
      sevenTvEnabled,
    }) => {
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
          gatewayAddress,
          sevenTvEmotesSet,
          sevenTvEnabled,
        });
        return next;
      });
      saveGatewayToVault(platform.vault, server.id, gatewayAddress);
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
