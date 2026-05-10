import * as React from "react";
import { useState } from "react";
import { useAtomValue } from "jotai";
import { PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Server } from "@/types/serverTypes";
import { useServerConnector } from "@/hooks/server/useServerConnector";
import { serverMetaAtom, jotaiStore } from "@/store/atoms";

interface ServerIconButtonProps {
  server: Server;
  isActive: boolean;
  onClick: () => void;
  onLeave: () => void;
  displayName: string;
  logo: string | null;
}

function ServerIconButton({
  server,
  isActive,
  onClick,
  onLeave,
  displayName,
  logo,
}: ServerIconButtonProps) {
  const borderRadius = isActive ? "0.75rem" : "50%";
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              onClick={onClick}
              aria-label={displayName}
              className="group relative flex items-center focus:outline-none"
            >
              <span
                className={cn(
                  "absolute -left-3 w-1 rounded-r-full bg-foreground transition-all duration-150",
                  isActive
                    ? "h-8"
                    : "h-2 opacity-0 group-hover:opacity-100 group-hover:h-4",
                )}
              />

              <div
                className={cn(
                  "transition-all duration-150",
                  isActive ? "rounded-xl" : "rounded-full group-hover:rounded-xl",
                )}
              >
                {logo ? (
                  <img
                    // base64
                    src={logo}
                    alt={`${displayName} logo`}
                    style={{ borderRadius }}
                    className={cn(
                      "size-10 transition-all duration-150 hover:brightness-95 hover:transform hover:scale-105",
                      isActive
                        ? "rounded-xl"
                        : "rounded-full group-hover:rounded-xl",
                    )}
                  />
                ) : (
                  <div
                    className={cn(
                      "size-10 flex items-center justify-center bg-muted text-muted-foreground rounded-xl",
                      isActive
                        ? "rounded-xl"
                        : "rounded-full group-hover:rounded-xl",
                    )}
                  >
                    {displayName[0].toUpperCase()}
                  </div>
                )}
              </div>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right">
          <span className="font-medium">{displayName}</span>
          <span className="ml-1.5 text-muted-foreground/70 font-normal text-[10px]">
            {server.address}
          </span>
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={onLeave}>
          Leave server
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface ServerSidebarProps {
  onAddServer: () => void;
}

export function ServerSidebar({ onAddServer }: ServerSidebarProps) {
  const { serverList, selectedServer, selectServer, leaveServer } = useServerConnector();
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });
  const [serverToLeave, setServerToLeave] = useState<Server | null>(null);

  const leaveDisplayName = serverToLeave
    ? (serverMeta.get(serverToLeave.id)?.name ?? serverToLeave.name ?? serverToLeave.address)
    : "";

  return (
    <>
      <div className="flex h-full w-17 shrink-0 flex-col items-center gap-2 border-r border-border/50 bg-neutral-100 py-3 dark:bg-neutral-900 overflow-y-auto">
        {serverList.length > 0 && (
          <>
            <div className="flex flex-col items-center gap-2 w-full px-3">
              {serverList.map((server) => {
                const meta = serverMeta.get(server.id);
                const displayName = meta?.name ?? server.name ?? server.address;
                const logo = meta?.logo ?? null;
                return (
                  <ServerIconButton
                    key={server.id}
                    server={server}
                    isActive={selectedServer?.id === server.id}
                    onClick={() => selectServer(server)}
                    onLeave={() => setServerToLeave(server)}
                    displayName={displayName}
                    logo={logo}
                  />
                );
              })}
            </div>

            <div className="w-8 h-px bg-border/60 my-1 shrink-0" />
          </>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onAddServer}
              aria-label="Add server"
              className="group flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground transition-all duration-100 hover:rounded-xl hover:bg-sky-700 hover:text-white focus:outline-none"
            >
              <PlusIcon className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Add a Server</TooltipContent>
        </Tooltip>
      </div>

      <AlertDialog
        open={serverToLeave !== null}
        onOpenChange={(open) => !open && setServerToLeave(null)}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {leaveDisplayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              You will stop receiving notifications from this server. You can
              rejoin later — your data will not be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (serverToLeave) leaveServer(serverToLeave);
                setServerToLeave(null);
              }}
            >
              Leave server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
