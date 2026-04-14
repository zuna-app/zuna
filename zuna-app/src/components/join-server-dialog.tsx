import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  StepJoinServer,
  type ServerJoinData,
} from "@/components/setup/step-join-server";
import { useServerConnector } from "@/hooks/useServerConnector";

interface JoinServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JoinServerDialog({
  open,
  onOpenChange,
}: JoinServerDialogProps) {
  const { joinServer } = useServerConnector();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const handleNext = async (data: ServerJoinData) => {
    setError(null);
    try {
      await joinServer(data.serverAddress, data.username, new Uint8Array());
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message ?? "Failed to join server.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {error && (
          <div className="mx-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive -mb-2">
            {error}
          </div>
        )}
        <StepJoinServer
          onNext={handleNext}
          showBack={false}
          nextLabel="Join Server"
        />
      </DialogContent>
    </Dialog>
  );
}
