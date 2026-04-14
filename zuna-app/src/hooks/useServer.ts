import { useAtom } from "jotai";
import { serverListAtom } from "./useServerConnector";

export function useServer(serverId: string) {
  const [serverList, _] = useAtom(serverListAtom);

  return serverList.find((s) => s.id === serverId);
}
