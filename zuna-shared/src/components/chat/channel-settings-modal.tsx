import { useState, useEffect } from "react";
import { Hash, Trash2, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useUpdateChannel } from "@/hooks/channel/useUpdateChannel";
import { useAuthorizedServerFetch } from "@/hooks/server/useServerFetch";
import type { Channel, ChannelMember, Server } from "@/types/serverTypes";

interface ChannelSettingsModalProps {
  server: Server;
  channel: Channel;
  members: ChannelMember[];
  selfId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed?: (name: string) => void;
}

export function ChannelSettingsModal({
  server,
  channel,
  members,
  selfId,
  open,
  onOpenChange,
  onRenamed,
}: ChannelSettingsModalProps) {
  const isOwner = channel.ownerId === selfId;

  const [name, setName] = useState(channel.name);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Add-member state
  const [allUsers, setAllUsers] = useState<
    Array<{
      id: string;
      username: string;
      avatar: string;
      identity_key: string;
    }>
  >([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { renameChannel, addMember, removeMember, isLoading, error } =
    useUpdateChannel(server);
  const { authorizedFetch } = useAuthorizedServerFetch(server);

  // Reset name when channel changes / modal opens
  useEffect(() => {
    if (open) setName(channel.name);
  }, [open, channel.name]);

  // Fetch users for add-member list (only for non-public channels where owner can add)
  useEffect(() => {
    if (!open || !isOwner) return;
    authorizedFetch("/api/chat/users")
      .then((r) => r.json())
      .then((json) => {
        setAllUsers(
          (json?.users ?? []).map(
            (u: {
              id: string;
              username: string;
              avatar?: string;
              identity_key?: string;
            }) => ({
              id: u.id,
              username: u.username,
              avatar: u.avatar ?? "",
              identity_key: u.identity_key ?? "",
            }),
          ),
        );
      })
      .catch(() => {});
  }, [open, isOwner]);

  const memberIds = new Set(members.map((m) => m.userId));
  const addableUsers = allUsers.filter(
    (u) => !memberIds.has(u.id) && u.id !== selfId,
  );

  const handleRename = async () => {
    if (!name.trim() || name.trim() === channel.name) return;
    const ok = await renameChannel(channel.id, name.trim());
    if (ok) {
      onRenamed?.(name.trim());
      setRenameError(null);
    } else {
      setRenameError(error ?? "Failed to rename");
    }
  };

  const handleAddMembers = async () => {
    if (selectedIds.size === 0) return;
    const toAdd = allUsers.filter(
      (u) => selectedIds.has(u.id) && u.identity_key,
    );
    const ok = await addMember(channel.id, toAdd);
    if (ok) setSelectedIds(new Set());
  };

  const handleRemoveMember = async (userId: string) => {
    await removeMember(channel.id, userId);
  };

  const toggleSelect = (id: string) => {
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
          <DialogTitle>Channel Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 pt-1">
          {/* Rename */}
          {isOwner && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="channel-rename">Channel name</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Hash className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                  <Input
                    id="channel-rename"
                    className="pl-8"
                    value={name}
                    onChange={(e) =>
                      setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))
                    }
                    onKeyDown={(e) => e.key === "Enter" && handleRename()}
                  />
                </div>
                <Button
                  size="sm"
                  onClick={handleRename}
                  disabled={
                    isLoading || !name.trim() || name.trim() === channel.name
                  }
                >
                  Save
                </Button>
              </div>
              {renameError && (
                <p className="text-xs text-destructive">{renameError}</p>
              )}
            </div>
          )}

          {/* Current members */}
          <div className="flex flex-col gap-1.5">
            <Label>Members</Label>
            <div className="flex flex-col rounded-lg border border-border/50 divide-y divide-border/30 max-h-48 overflow-y-auto">
              {members.map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <Avatar className="size-7 shrink-0">
                    {m.avatar ? (
                      <AvatarImage src={m.avatar} alt={m.username} />
                    ) : null}
                    <AvatarFallback className="text-xs">
                      {m.username[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 text-sm truncate">{m.username}</span>
                  {m.userId === channel.ownerId && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      owner
                    </span>
                  )}
                  {isOwner && m.userId !== channel.ownerId && (
                    <button
                      onClick={() => handleRemoveMember(m.userId)}
                      disabled={isLoading}
                      className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 shrink-0"
                      title="Remove member"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {members.length === 0 && (
                <p className="text-sm text-muted-foreground px-3 py-2">
                  No members
                </p>
              )}
            </div>
          </div>

          {/* Add members (owner only, restricted channels) */}
          {isOwner && !channel.isPublic && addableUsers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>Add members</Label>
              <div className="flex flex-col rounded-lg border border-border/50 divide-y divide-border/30 max-h-36 overflow-y-auto">
                {addableUsers.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => toggleSelect(u.id)}
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
                    <span className="text-sm truncate">{u.username}</span>
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                onClick={handleAddMembers}
                disabled={isLoading || selectedIds.size === 0}
                className="self-end gap-1.5"
              >
                <UserPlus className="size-3.5" />
                Add {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
