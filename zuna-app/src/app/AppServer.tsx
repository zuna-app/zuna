import { useEffect } from "react";
import { Server } from "@/types/serverTypes";
import { useAuthorizer } from "@/hooks/useAuthorizer";
import { Loader2 } from "lucide-react";

export const AppServer = ({ server }: { server: Server }) => {
  const { authorize, token, isAuthorizing, error } = useAuthorizer(server);

  useEffect(() => {
    if (!token) {
      authorize(server.username).catch(() => {});
    }
  }, [server.id]);

  if (isAuthorizing) {
    return (
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <p className="text-sm">Authorizing with {server.name}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-sm font-medium text-destructive">
          Authorization failed
        </p>
        <p className="text-xs text-muted-foreground">{error}</p>
        <button
          className="text-xs underline text-muted-foreground hover:text-foreground"
          onClick={() => authorize(server.username).catch(() => {})}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!token) return null;

  return (
    <div className="text-center">
      <p className="font-medium text-foreground">{server.name}</p>
      <p className="mt-1 text-xs">{server.address}</p>
    </div>
  );
};
