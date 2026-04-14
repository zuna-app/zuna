import { ServerList, Server } from "@/types/serverTypes";
import { atom, useAtom } from "jotai";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

export const serverListAtom = atom<ServerList>([]);
export const selectedServerAtom = atom<Server | null>(null);

export const useServerConnector = () => {
  const [serverList, setServerList] = useAtom(serverListAtom);
  const [selectedServer, setSelectedServer] = useAtom(selectedServerAtom);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    if (serverList.length > 0) {
      setLoading(false);
      return;
    }

    const loadServerList = async () => {
      try {
        const storedList = await window.vault.get("serverList");
        if (Array.isArray(storedList) && storedList.length > 0) {
          setServerList(storedList);
        }

        if (storedList && storedList.length > 0) {
          setSelectedServer(storedList[0]);
        }
      } catch {
        // vault locked or other error — skip
      } finally {
        setLoading(false);
      }
    };

    loadServerList();
  }, [setServerList]);

  const selectServer = (server: Server | null) => {
    setSelectedServer(server);
  };

  const joinMutation = useMutation({
    mutationFn: async ({
      address,
      username,
      avatar,
    }: {
      address: string;
      username: string;
      avatar: Uint8Array;
    }) => {
      const [encPublicKey, sigPublicKey] = await Promise.all([
        window.vault.get("encPublicKey"),
        window.vault.get("sigPublicKey"),
      ]);

      if (!encPublicKey || !sigPublicKey) {
        throw new Error("Encryption or signing key not found in vault");
      }

      const res = await fetch(`http://${address}/api/auth/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identity_key: encPublicKey,
          signing_key: sigPublicKey,
          avatar: "",
          avatar_iv: "",
          avatar_auth_tag: "",
          username,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Server returned ${res.status}: ${text}`);
      }

      return { data: await res.json(), address, username };
    },
    onSuccess: ({ data, address, username }) => {
      const newServer: Server = {
        id: data.id,
        address,
        name: data.serverName ?? address,
        username,
      };

      setServerList((prev) => {
        const next = [...prev, newServer];
        window.vault.set("serverList", next);
        return next;
      });
      setSelectedServer(newServer);
    },
  });

  const joinServer = (
    address: string,
    username: string,
    avatar: Uint8Array,
  ): Promise<void> =>
    joinMutation
      .mutateAsync({ address, username, avatar })
      .then(() => undefined);

  return { serverList, selectedServer, selectServer, isLoading, joinServer };
};
