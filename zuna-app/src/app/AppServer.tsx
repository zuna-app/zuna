import { useEffect, useState } from "react";
import { Server, ChatMember } from "@/types/serverTypes";
import { useAuthorizer } from "@/hooks/useAuthorizer";
import { Loader2 } from "lucide-react";
import { ChatListPanel } from "@/components/chat/chat-list-panel";
import { ChatTopbar } from "@/components/chat/chat-topbar";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";

export const AppServer = ({ server }: { server: Server }) => {
  const { authorize, token, isAuthorizing, error } = useAuthorizer(server);
  const [selectedMember, setSelectedMember] = useState<ChatMember | null>(null);

  useEffect(() => {
    if (!token && !error) {
      authorize(server.username).catch(() => {});
    }
  }, [server.id]);

  useEffect(() => {
    setSelectedMember(null);
  }, [server.id]);

  if (isAuthorizing) {
    return (
      <div className="flex flex-1 w-full h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <p className="text-sm">Authorizing with {server.name}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 w-full h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm font-medium text-destructive">
          Authorization failed
        </p>
        <p className="text-xs text-muted-foreground">{error}</p>
        <button
          className="text-xs underline text-muted-foreground hover:text-foreground"
          onClick={() => authorize(server.username).catch(() => {})}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!token) return null;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <ChatListPanel
        server={server}
        selectedMember={selectedMember}
        onSelect={setSelectedMember}
      />
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {selectedMember ? (
          <>
            <ChatTopbar member={selectedMember} />
            <ChatMessages member={selectedMember} />
            <ChatInput />
          </>
        ) : (
          <ChatEmptyState />
        )}
      </div>
    </div>
  );
};
