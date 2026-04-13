import * as React from "react";
import { ServerIcon, UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

export interface ServerJoinData {
  serverAddress: string;
  serverPassword: string;
  username: string;
}

interface StepJoinServerProps {
  onNext: (data: ServerJoinData) => void;
  onBack?: () => void;
  showBack?: boolean;
  nextLabel?: string;
}

function getInitials(username: string): string {
  const parts = username
    .trim()
    .split(/[\s_.\-]+/)
    .filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (username.length >= 2) return username.slice(0, 2).toUpperCase();
  return username.toUpperCase();
}

function getAvatarHue(username: string): number {
  if (!username) return 220;
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return ((Math.abs(hash) % 360) + 360) % 360;
}

function PseudoAvatar({
  username,
  size = 40,
}: {
  username: string;
  size?: number;
}) {
  const hue = getAvatarHue(username);
  const bg = `hsl(${hue}, 60%, 50%)`;
  const border = `hsl(${hue}, 60%, 38%)`;
  const initials = username ? (
    getInitials(username)
  ) : (
    <UserIcon className="size-4" />
  );

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: username
          ? `radial-gradient(circle at 35% 35%, hsl(${hue}, 70%, 62%), ${bg})`
          : undefined,
        backgroundColor: username ? undefined : "hsl(var(--muted))",
        boxShadow: `0 0 0 2px ${username ? border : "hsl(var(--border))"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: username ? "white" : "hsl(var(--muted-foreground))",
        fontSize: size * 0.32,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        flexShrink: 0,
        userSelect: "none",
        transition: "all 0.2s ease",
      }}
    >
      {initials}
    </div>
  );
}

export function StepJoinServer({
  onNext,
  onBack,
  showBack = true,
  nextLabel = "Join Server",
}: StepJoinServerProps) {
  const [serverAddress, setServerAddress] = React.useState("");
  const [serverPassword, setServerPassword] = React.useState("");
  const [username, setUsername] = React.useState("");

  const canContinue =
    serverAddress.trim().length > 0 && username.trim().length > 0;

  const handleNext = () => {
    if (!canContinue) return;
    onNext({
      serverAddress: serverAddress.trim(),
      serverPassword,
      username: username.trim(),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold">Join a Server</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect to a Zuna server to start communicating securely with others.
        </p>
      </div>

      <div className="grid gap-4">
        <div className="rounded-lg border border-border/60 bg-card/50 p-4 grid gap-3">
          <div className="flex items-center gap-2 mb-0.5">
            <ServerIcon className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Server
            </span>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="server-address">
              Address{" "}
              <Badge variant="destructive" className="h-4 text-[10px] ml-1">
                required
              </Badge>
            </Label>
            <Input
              id="server-address"
              placeholder="zuna.example.com:8080"
              value={serverAddress}
              onChange={(e) => setServerAddress(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="server-password">
              Password{" "}
              <span className="text-xs font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="server-password"
              type="password"
              placeholder="Leave empty if the server is open"
              value={serverPassword}
              onChange={(e) => setServerPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>

        <Separator />

        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <UserIcon className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Your Identity
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="grid gap-1.5 flex-1 min-w-0">
              <Label htmlFor="username">
                Username{" "}
                <Badge variant="destructive" className="h-4 text-[10px] ml-1">
                  required
                </Badge>
              </Label>
              <Input
                id="username"
                placeholder="your_username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col items-center gap-1.5 mt-5 shrink-0">
              <PseudoAvatar username={username} size={44} />
              <span className="text-[10px] text-muted-foreground">Preview</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Your avatar is automatically generated from your username and is
            unique to you.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        {showBack && onBack ? (
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        ) : (
          <div />
        )}
        <Button onClick={handleNext} disabled={!canContinue}>
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}
