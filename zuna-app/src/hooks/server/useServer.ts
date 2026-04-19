import { useAtomValue } from "jotai";
import { serverListAtom } from "../server/useServerConnector";

export function useServer(serverId: string) {
  const serverList = useAtomValue(serverListAtom);

  return serverList.find((s) => s.id === serverId);
}
