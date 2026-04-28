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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { ArrowUpRightIcon, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppServer } from "./AppServer";

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

function MainApp() {
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const { selectedServer, serverList } = useServerConnector();

  useEffect(() => {
    if (serverList.length > 0) {
      fetchAndUpdateServerInfos(serverList);
    }
  }, [serverList]);

  return (
    <div className="flex h-svh flex-col bg-background rounded-md overflow-hidden border border-neutral-600 dark:border-neutral-800">
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
      <div className="flex flex-1 min-h-0">
        <ServerSidebar onAddServer={() => setJoinDialogOpen(true)} />
        {selectedServer ? (
          <AppServer server={selectedServer} />
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
    </div>
  );
}

export function App() {
  const [isFirstTime, setIsFirstTime] = useState<boolean | null>(null);
  const [isPasswordPromptOpen, setIsPasswordPromptOpen] = useState(true);

  useEffect(() => {
    window.vault.isFirstTimeSetup().then((result: boolean) => {
      setIsFirstTime(result);
    });
  }, []);

  if (isFirstTime === null) {
    return null;
  }

  if (isFirstTime) {
    return <FirstTimeSetup onComplete={() => setIsFirstTime(false)} />;
  }

  if (isPasswordPromptOpen) {
    return (
      <PasswordPrompter onUnlocked={() => setIsPasswordPromptOpen(false)} />
    );
  }

  return (
    <TooltipProvider>
      <MainApp />
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
