import { TitleBar } from "@/components/title-bar";
import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { FirstTimeSetup } from "@/components/setup/first-time-setup";
import { PasswordPrompter } from "@/components/password-prompter";
import { ServerSidebar } from "@/components/server-sidebar";
import { JoinServerDialog } from "@/components/join-server-dialog";
import { ExportVaultDialog } from "@/components/export-vault-dialog";
import { useServerConnector } from "@/hooks/server/useServerConnector";
import { usePing } from "@/hooks/server/usePing";
import { Server } from "@/types/serverTypes";
import { fetchAndUpdateServerInfos } from "@/hooks/auth/useAuthorizer";
import { ThemeProvider } from "@/components/theme-provider";
import { usePlatform } from "../platform";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Folder, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppServer } from "./AppServer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAtomValue } from "jotai";
import { serverMetaAtom, jotaiStore } from "@/store/atoms";
import { cn } from "@/lib/utils";

function TitleBarWithServer({
  server,
  onSettings,
  onExportVault,
}: {
  server: Server;
  onSettings?: () => void;
  onExportVault?: () => void;
}) {
  const { latency } = usePing(server);
  return (
    <TitleBar
      serverAddress={server.address}
      ping={latency}
      onSettings={onSettings}
      onExportVault={onExportVault}
    />
  );
}

function MobileServerSelector({
  open,
  onOpenChange,
  onAddServer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddServer: () => void;
}) {
  const { serverList, selectedServer, selectServer } = useServerConnector();
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Select Server</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1 py-1">
          {serverList.map((server) => {
            const meta = serverMeta.get(server.id);
            const displayName = meta?.name ?? server.name ?? server.address;
            const logo = meta?.logo ?? null;
            const isActive = selectedServer?.id === server.id;
            return (
              <button
                key={server.id}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted",
                )}
                onClick={() => {
                  selectServer(server);
                  onOpenChange(false);
                }}
              >
                {logo ? (
                  <img
                    src={logo}
                    alt={displayName}
                    className="size-8 rounded-lg shrink-0"
                  />
                ) : (
                  <div className="size-8 flex items-center justify-center rounded-lg bg-muted text-muted-foreground text-sm font-medium shrink-0">
                    {displayName[0].toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{displayName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {server.address}
                  </p>
                </div>
                {isActive && (
                  <div className="ml-auto size-2 rounded-full bg-primary shrink-0" />
                )}
              </button>
            );
          })}
          <div className="my-1 h-px bg-border" />
          <button
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-muted transition-colors text-muted-foreground"
            onClick={() => {
              onOpenChange(false);
              onAddServer();
            }}
          >
            <div className="size-8 flex items-center justify-center rounded-lg bg-muted shrink-0">
              <PlusIcon className="size-4" />
            </div>
            <span className="text-sm">Add Server</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MainApp() {
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [mobileServerOpen, setMobileServerOpen] = useState(false);
  const { selectedServer, serverList } = useServerConnector();
  const { window: win } = usePlatform();
  const isNative = win.isNative;

  useEffect(() => {
    if (serverList.length > 0) {
      fetchAndUpdateServerInfos(serverList);
    }
  }, [serverList]);

  return (
    <div
      className={cn(
        "flex h-svh flex-col bg-background overflow-hidden",
        isNative &&
          "rounded-md border border-neutral-600 dark:border-neutral-800",
      )}
    >
      {/* TitleBar: always on native; desktop-only on PWA */}
      <div className={isNative ? undefined : "hidden md:flex w-full"}>
        {selectedServer ? (
          <TitleBarWithServer
            server={selectedServer}
            onSettings={() => console.log("settings")}
            onExportVault={() => setExportDialogOpen(true)}
          />
        ) : (
          <TitleBar
            onSettings={() => console.log("settings")}
            onExportVault={() => setExportDialogOpen(true)}
          />
        )}
      </div>
      <div className="flex flex-1 min-h-0">
        {/* ServerSidebar: always on native; desktop-only on PWA */}
        <div
          className={isNative ? undefined : "hidden md:flex md:self-stretch"}
        >
          <ServerSidebar onAddServer={() => setJoinDialogOpen(true)} />
        </div>
        {selectedServer ? (
          <AppServer
            server={selectedServer}
            onMobileServerMenu={
              isNative ? undefined : () => setMobileServerOpen(true)
            }
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Folder />
                </EmptyMedia>
                <EmptyTitle>No servers yet.</EmptyTitle>
                <EmptyDescription>
                  You haven&apos;t joined any servers yet. Get started by
                  joining your first server.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setJoinDialogOpen(true)}
                >
                  Join Server
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        )}
      </div>
      <JoinServerDialog
        open={joinDialogOpen}
        onOpenChange={setJoinDialogOpen}
      />
      <ExportVaultDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
      />
      <MobileServerSelector
        open={!isNative && mobileServerOpen}
        onOpenChange={setMobileServerOpen}
        onAddServer={() => setJoinDialogOpen(true)}
      />
    </div>
  );
}

export function App() {
  const [isFirstTime, setIsFirstTime] = useState<boolean | null>(null);
  const [isPasswordPromptOpen, setIsPasswordPromptOpen] = useState(true);
  const { vault } = usePlatform();

  useEffect(() => {
    vault.isFirstTimeSetup().then((result: boolean) => {
      setIsFirstTime(result);
    });
  }, []);

  if (isFirstTime === null) {
    return null;
  }

  return (
    <ThemeProvider>
      <TooltipProvider>
        {isFirstTime ? (
          <FirstTimeSetup onComplete={() => setIsFirstTime(false)} />
        ) : isPasswordPromptOpen ? (
          <PasswordPrompter onUnlocked={() => setIsPasswordPromptOpen(false)} />
        ) : (
          <>
            <MainApp />
            <Toaster />
          </>
        )}
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
