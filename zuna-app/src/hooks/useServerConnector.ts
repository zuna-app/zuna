import { ServerList, Server } from "@/types/serverTypes";
import { atom, useAtom } from "jotai";
import { useEffect, useState } from "react";

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

  const joinServer = async (
    serverAddress: string,
    username: string,
    avatar: Uint8Array,
  ) => {
    const [encPublicKey, sigPublicKey] = await Promise.all([
      window.vault.get("encPublicKey"),
      window.vault.get("sigPublicKey"),
    ]);

    if (!encPublicKey || !sigPublicKey) {
      throw new Error("Encryption or signing key not found in vault");
    }

    const res = await fetch(`http://${serverAddress}/api/auth/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identity_key: encPublicKey,
        signing_key: sigPublicKey,
        //avatar: Array.from(avatar),
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

    const data = await res.json();

    const newServer = {
      id: data.serverId,
      address: serverAddress,
      name: data.serverName ?? serverAddress,
      username,
    };

    setServerList((prev) => {
      const next = [...prev, newServer];
      window.vault.set("serverList", next);
      return next;
    });
    setSelectedServer(newServer);
  };

  return { serverList, selectedServer, selectServer, isLoading, joinServer };
};
