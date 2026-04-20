import * as React from "react";
import { useAtomValue } from "jotai";
import { PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Server } from "@/types/serverTypes";
import { useServerConnector } from "@/hooks/server/useServerConnector";
import { serverMetaAtom, jotaiStore } from "@/hooks/auth/useAuthorizer";

interface ServerIconButtonProps {
  server: Server;
  isActive: boolean;
  onClick: () => void;
  displayName: string;
  logo: string | null;
}

function ServerIconButton({
  server,
  isActive,
  onClick,
  displayName,
  logo,
}: ServerIconButtonProps) {
  const rounded = isActive ? "xl" : "full";
  const borderRadius = isActive ? "0.75rem" : "50%";
  return (
    <Tooltip>
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
                src={`data:image/png;base64,${logo}`}
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
                  "size-10 flex items-center justify-center bg-muted text-muted-foreground",
                  rounded,
                )}
              >
                {displayName[0].toUpperCase()}
              </div>
            )}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span className="font-medium">{displayName}</span>
        <span className="ml-1.5 text-muted-foreground/70 font-normal text-[10px]">
          {server.address}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

interface ServerSidebarProps {
  onAddServer: () => void;
}

export function ServerSidebar({ onAddServer }: ServerSidebarProps) {
  const { serverList, selectedServer, selectServer } = useServerConnector();
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });

  return (
    <div className="flex w-17 shrink-0 flex-col items-center gap-2 border-r border-border/50 bg-neutral-100 py-3 dark:bg-neutral-900 overflow-y-auto">
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
  );
}
