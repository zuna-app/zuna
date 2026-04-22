import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useAtomValue } from "jotai";
import { Server, ChatMember } from "@/types/serverTypes";
import {
  useAuthorizer,
  serverMetaAtom,
  jotaiStore,
} from "@/hooks/auth/useAuthorizer";
import { useMessages } from "@/hooks/chat/useMessages";
import { useSharedSecret } from "@/hooks/ws/useSharedSecret";
import { useBackgroundMessages } from "@/hooks/ws/useBackgroundMessages";
import { useWsConnection } from "@/hooks/ws/useWsConnection";
import { WS_MSG } from "@/hooks/ws/wsTypes";
import { Loader2, Upload } from "lucide-react";
import { ChatListPanel } from "@/components/chat/chat-list-panel";
import { ChatTopbar } from "@/components/chat/chat-topbar";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { useSelectedChat } from "@/hooks/chat/useSelectedChat";

function ChatView({ server, member }: { server: Server; member: ChatMember }) {
  const sharedSecret = useSharedSecret(member);
  const {
    messages,
    loading,
    hasMore,
    sendMessage,
    editMessage,
    uploadAndSend,
    fetchMore,
  } = useMessages(server, member.chatId, sharedSecret, member.identityKey);
  const { sendMessage: wsSend } = useWsConnection(server);
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });
  const meta = serverMeta.get(server.id);
  const sevenTvEnabled = meta?.sevenTvEnabled ?? true;
  const sevenTvEmotesSet = meta?.sevenTvEmotesSet ?? null;

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [editingMessage, setEditingMessage] = useState<{
    id: number;
    originalText: string;
  } | null>(null);

  useEffect(() => {
    setEditingMessage(null);
    setPendingFile(null);
  }, [member.chatId]);

  const handleWrite = useCallback(
    (writing: boolean) => {
      wsSend(WS_MSG.WRITE, { chat_id: member.chatId, writing });
    },
    [wsSend, member.chatId],
  );

  const handleSendFile = useCallback(
    (file: File, plaintext: string) => {
      uploadAndSend(file, plaintext);
    },
    [uploadAndSend],
  );

  const handleSend = useCallback(
    (cipherText: string, iv: string, authTag: string, plaintext: string) => {
      if (editingMessage) {
        editMessage(editingMessage.id, cipherText, iv, authTag, plaintext);
        setEditingMessage(null);
        return;
      }

      sendMessage(cipherText, iv, authTag, plaintext);
    },
    [editingMessage, editMessage, sendMessage],
  );

  const { getRootProps, isDragActive } = useDropzone({
    onDrop: (acceptedFiles) => {
      if (!sharedSecret) return;
      const file = acceptedFiles[0];
      if (file) setPendingFile(file);
    },
    noClick: true,
    noKeyboard: true,
    disabled: !sharedSecret,
  });

  return (
    <div
      className="flex flex-col flex-1 min-h-0 overflow-hidden relative"
      {...getRootProps()}
    >
      {isDragActive && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="size-8" />
            <span className="text-sm font-medium">Drop to attach</span>
          </div>
        </div>
      )}
      <ChatTopbar member={member} />
      <ChatMessages
        server={server}
        member={member}
        messages={messages}
        loading={loading}
        hasMore={hasMore}
        fetchMore={fetchMore}
        sharedSecret={sharedSecret}
        sevenTvEnabled={sevenTvEnabled}
        sevenTvEmotesSet={sevenTvEmotesSet}
        onEditMessage={(messageId, rawText) => {
          setPendingFile(null);
          setEditingMessage({ id: messageId, originalText: rawText });
        }}
      />
      <ChatInput
        key={member.chatId}
        sharedSecret={sharedSecret}
        onSend={handleSend}
        onWrite={handleWrite}
        onSendFile={handleSendFile}
        pendingFile={pendingFile}
        onPendingFileChange={setPendingFile}
        sevenTvEnabled={sevenTvEnabled}
        sevenTvEmotesSet={sevenTvEmotesSet}
        editingMessage={editingMessage}
        onCancelEdit={() => setEditingMessage(null)}
      />
    </div>
  );
}

export const AppServer = ({ server }: { server: Server }) => {
  const { authorize, token, isAuthorizing, error } = useAuthorizer(server);
  const [selectedMember, setSelectedMember] = useState<ChatMember | null>(null);
  const { selectChat } = useSelectedChat();

  useBackgroundMessages(server);

  useEffect(() => {
    if (!token && !error) {
      authorize(server.username).catch(() => {});
    }
  }, [server.id]);

  useEffect(() => {
    setSelectedMember(null);
    selectChat(null);
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
        onSelect={(member) => {
          setSelectedMember(member);
          selectChat(member.chatId);
        }}
      />
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {selectedMember ? (
          <ChatView server={server} member={selectedMember} />
        ) : (
          <ChatEmptyState />
        )}
      </div>
    </div>
  );
};
