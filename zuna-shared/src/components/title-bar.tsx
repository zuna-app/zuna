import {
  Download,
  Minus,
  Settings,
  Square,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { usePlatform } from "../platform";

interface TitleBarProps {
  serverAddress?: string;
  ping?: number | null;
  onSettings?: () => void;
  onExportVault?: () => void;
}

function pingColor(ping: number | null | undefined) {
  if (ping == null) return "bg-red-500";
  if (ping < 60) return "bg-green-500";
  if (ping < 150) return "bg-yellow-400";
  return "bg-orange-500";
}

function pingLabel(ping: number | null | undefined) {
  if (ping == null) return "Disconnected";
  return `${ping} ms`;
}

export function TitleBar({
  serverAddress,
  ping,
  onSettings,
  onExportVault,
}: TitleBarProps) {
  const isConnected = ping != null;
  const { window: win } = usePlatform();

  const windowControls = win.isNative ? (
    <div className="app-no-drag flex items-center gap-1 px-2">
      <button
        onClick={onExportVault}
        aria-label="Export vault"
        className="flex size-7 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Download className="size-3" />
      </button>
      <button
        onClick={() => win.minimize()}
        aria-label="Minimize"
        className="flex size-7 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="size-3" />
      </button>
      <button
        onClick={() => win.maximize()}
        aria-label="Maximize"
        className="flex size-7 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Square className="size-3" />
      </button>
      <button
        onClick={() => win.close()}
        aria-label="Close"
        className="flex size-7 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-red-500 hover:text-white"
      >
        <X className="size-3" />
      </button>
    </div>
  ) : null;

  return (
    <div className="app-drag flex w-full h-10 shrink-0 select-none items-center border-b border-border/50 bg-neutral-100 dark:bg-neutral-900">
      <div className="flex flex-1 items-center gap-3 pl-3">
        <img src={"zuna.png"} alt="Zuna" className="size-5 shrink-0" />
        <span className="text-sm font-semibold tracking-wide text-foreground/90">
          Zuna
        </span>

        <span className="h-4 w-px bg-border/60 shrink-0" />

        {serverAddress ? (
          <div className="app-no-drag flex items-center gap-2 text-xs">
            {isConnected ? (
              <Wifi className="size-3 text-green-500 shrink-0" />
            ) : (
              <WifiOff className="size-3 text-red-500 shrink-0" />
            )}
            <span className="font-mono text-foreground/60 max-w-48 truncate">
              {serverAddress}
            </span>
            <span className="h-3 w-px bg-border/60 shrink-0" />
            <span
              className={`flex items-center gap-1.5 font-medium ${isConnected ? "text-foreground/60" : "text-red-500"}`}
            >
              <span
                className={`inline-block size-1.5 rounded-full ${pingColor(ping)}`}
              />
              {pingLabel(ping)}
            </span>
          </div>
        ) : (
          <div className="app-no-drag flex items-center gap-1.5 text-xs text-muted-foreground/50">
            <WifiOff className="size-3" />
            <span>Not connected</span>
          </div>
        )}
      </div>

      <div className="flex items-center">
        {onSettings && (
          <button
            onClick={onSettings}
            aria-label="Settings"
            className="app-no-drag flex size-7 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-accent hover:text-foreground mr-1"
          >
            <Settings className="size-3.5" />
          </button>
        )}
        {windowControls}
      </div>
    </div>
  );
}
