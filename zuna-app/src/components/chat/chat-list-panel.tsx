import { useState, useMemo } from "react";
import { Server, ChatMember } from "@/types/serverTypes";
import { useChatList } from "@/hooks/useChatList";
import { ChatListItem } from "@/components/chat/chat-list-item";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PencilLine, Search, MessageSquarePlus } from "lucide-react";

interface ChatListPanelProps {
  server: Server;
  selectedMember: ChatMember | null;
  onSelect: (member: ChatMember) => void;
}

function ChatListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5 px-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton className="size-10.5 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatListPanel({
  server,
  selectedMember,
  onSelect,
}: ChatListPanelProps) {
  const [search, setSearch] = useState("");
  const { data, isLoading, error } = useChatList(server);

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim();
    if (!term) return data ?? [];
    return (data ?? []).filter((m) => m.username.toLowerCase().includes(term));
  }, [data, search]);

  return (
    <div className="flex w-75 shrink-0 flex-col border-r border-border/40 bg-neutral-50 dark:bg-neutral-950/50 h-full">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-base font-bold tracking-tight">Messages</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <PencilLine className="size-4" />
        </Button>
      </div>

      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-8 rounded-lg bg-muted/50 border-transparent text-sm placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]">
        {isLoading ? (
          <ChatListSkeleton />
        ) : error ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center px-4">
            <MessageSquarePlus className="size-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              Failed to load conversations
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center px-4">
            <Search className="size-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {search
                ? "No conversations matching your search"
                : "No conversations yet"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((member) => (
              <ChatListItem
                key={member.id}
                member={member}
                isSelected={selectedMember?.id === member.id}
                onClick={() => onSelect(member)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
