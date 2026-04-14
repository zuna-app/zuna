import * as React from "react";
import { PlusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PseudoAvatar } from "@/components/ui/pseudo-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Server } from "@/types/serverTypes";
import { useServerConnector } from "@/hooks/useServerConnector";

interface ServerIconButtonProps {
  server: Server;
  isActive: boolean;
  onClick: () => void;
}

function ServerIconButton({
  server,
  isActive,
  onClick,
}: ServerIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={server.name}
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
            <PseudoAvatar
              name={server.name || server.address}
              size={44}
              rounded={isActive ? "xl" : "full"}
            />
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span className="font-medium">{server.name || server.address}</span>
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

  return (
    <div className="flex w-17 shrink-0 flex-col items-center gap-2 border-r border-border/50 bg-neutral-100 py-3 dark:bg-neutral-900 overflow-y-auto">
      {serverList.length > 0 && (
        <>
          <div className="flex flex-col items-center gap-2 w-full px-3">
            {serverList.map((server) => (
              <ServerIconButton
                key={server.id}
                server={server}
                isActive={selectedServer?.id === server.id}
                onClick={() => selectServer(server)}
              />
            ))}
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
