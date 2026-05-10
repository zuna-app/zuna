import { useState, useEffect } from "react";
import { Hash, Lock, Globe, Volume2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useCreateChannel } from "@/hooks/channel/useCreateChannel";
import { useAuthorizedServerFetch } from "@/hooks/server/useServerFetch";
import type { Channel, Server } from "@/types/serverTypes";

interface CreateChannelModalProps {
  server: Server;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channel: Channel) => void;
}

export function CreateChannelModal({
  server,
  open,
  onOpenChange,
  onCreated,
}: CreateChannelModalProps) {
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [isPublic, setIsPublic] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [users, setUsers] = useState<
    Array<{ id: string; username: string; avatar: string }>
  >([]);

  const { createChannel, isCreating, error } = useCreateChannel(server);
  const { authorizedFetch } = useAuthorizedServerFetch(server);

  useEffect(() => {
    if (!open || isPublic || channelType === "voice") return;
    authorizedFetch("/api/chat/users")
      .then((r) => r.json())
      .then((json) => {
        setUsers(
          (json?.users ?? []).map(
            (u: { id: string; username: string; avatar?: string }) => ({
              id: u.id,
              username: u.username,
              avatar: u.avatar ?? "",
            }),
          ),
        );
      })
      .catch(() => {});
  }, [open, isPublic, channelType]);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    const channel = await createChannel({
      name: name.trim(),
      isPublic: channelType === "voice" ? true : isPublic,
      channelType,
      memberIds:
        channelType === "voice" || isPublic
          ? undefined
          : Array.from(selectedIds),
    });
    if (channel) {
      setName("");
      setSelectedIds(new Set());
      setIsPublic(true);
      setChannelType("text");
      onCreated(channel);
    }
  };

  const toggleMember = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Channel</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-1">
          {/* Channel type selector */}
          <div className="flex gap-2">
            <button
              onClick={() => setChannelType("text")}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                channelType === "text"
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-border/50 text-muted-foreground hover:bg-muted/50",
              )}
            >
              <Hash className="size-4 shrink-0" />
              Text
            </button>
            <button
              onClick={() => setChannelType("voice")}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                channelType === "voice"
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-border/50 text-muted-foreground hover:bg-muted/50",
              )}
            >
              <Volume2 className="size-4 shrink-0" />
              Voice
            </button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-name">Channel name</Label>
            <div className="relative">
              {channelType === "voice" ? (
                <Volume2 className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              ) : (
                <Hash className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              )}
              <Input
                id="channel-name"
                className="pl-8"
                placeholder={channelType === "voice" ? "voice-chat" : "general"}
                value={name}
                onChange={(e) =>
                  setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))
                }
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                autoFocus
              />
            </div>
          </div>

          {/* Visibility — only for text channels */}
          {channelType === "text" && (
            <>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  {isPublic ? (
                    <Globe className="size-4 text-muted-foreground" />
                  ) : (
                    <Lock className="size-4 text-muted-foreground" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {isPublic ? "Public" : "Restricted"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isPublic
                        ? "All server members can access"
                        : "Only selected members"}
                    </p>
                  </div>
                </div>
                <Switch checked={isPublic} onCheckedChange={setIsPublic} />
              </div>

              {!isPublic && users.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label>Members</Label>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/30">
                    {users.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => toggleMember(u.id)}
                        className="flex items-center gap-3 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                      >
                        <div
                          className={`size-4 rounded-sm border-2 flex items-center justify-center shrink-0 transition-colors ${
                            selectedIds.has(u.id)
                              ? "bg-primary border-primary"
                              : "border-muted-foreground/40"
                          }`}
                        >
                          {selectedIds.has(u.id) && (
                            <svg
                              className="size-2.5 text-primary-foreground"
                              viewBox="0 0 12 12"
                              fill="none"
                            >
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </div>
                        <span className="text-sm">{u.username}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            onClick={handleSubmit}
            disabled={isCreating || !name.trim()}
            className="w-full"
          >
            {isCreating ? "Creating…" : "Create Channel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
