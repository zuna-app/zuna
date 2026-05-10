import { useCallback, useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { useAtomValue } from "jotai";
import { Server, ChatMember, Channel } from "@/types/serverTypes";
import { useAuthorizer } from "@/hooks/auth/useAuthorizer";
import { serverMetaAtom, jotaiStore } from "@/store/atoms";
import { useMessages } from "@/hooks/chat/useMessages";
import { useSharedSecret } from "@/hooks/ws/useSharedSecret";
import { useBackgroundMessages } from "@/hooks/ws/useBackgroundMessages";
import { useWsConnection } from "@/hooks/ws/useWsConnection";
import { useAppPresence } from "@/hooks/ws/useAppPresence";
import { useChannelKeyManager } from "@/hooks/channel/useChannelKeyManager";
import { useVoiceChannel } from "@/hooks/channel/useVoiceChannel";
import { WS_MSG } from "@/hooks/ws/wsTypes";
import { Loader2, Upload } from "lucide-react";
import { ChatListPanel } from "@/components/chat/chat-list-panel";
import { ChatTopbar } from "@/components/chat/chat-topbar";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { ChannelView } from "@/components/chat/channel-view";
import { useSelectedChat } from "@/hooks/chat/useSelectedChat";
import { useMessageDecryption } from "@/components/chat/messages/use-decryption";
import { usePlatform } from "@/platform/PlatformContext";
import { useSelfInfo } from "@/hooks/server/useSelfInfo";

function ChatView({
  server,
  member,
  onBack,
}: {
  server: Server;
  member: ChatMember;
  onBack?: () => void;
}) {
  const sharedSecret = useSharedSecret(member);
  const {
    messages,
    loading,
    hasMore,
    sendMessage,
    sendReplyMessage,
    editMessage,
    togglePinMessage,
    uploadAndSend,
    fetchMore,
  } = useMessages(server, member.chatId, sharedSecret, member.identityKey);
  const { sendMessage: wsSend } = useWsConnection(server);
  const serverMeta = useAtomValue(serverMetaAtom, { store: jotaiStore });
  const meta = serverMeta.get(server.id);
  const sevenTvEnabled = meta?.sevenTvEnabled ?? true;
  const sevenTvEmotesSet = meta?.sevenTvEmotesSet ?? null;
  const { getRawText, getAttachmentMeta } = useMessageDecryption(
    messages,
    sharedSecret,
    member.id,
  );

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [editingMessage, setEditingMessage] = useState<{
    id: number;
    originalText: string;
  } | null>(null);
  const [replyingTo, setReplyingTo] = useState<{
    id: number;
    rawText: string;
  } | null>(null);

  useEffect(() => {
    setEditingMessage(null);
    setPendingFile(null);
    setReplyingTo(null);
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

      if (replyingTo) {
        sendReplyMessage(cipherText, iv, authTag, plaintext, replyingTo.id);
        setReplyingTo(null);
        return;
      }

      sendMessage(cipherText, iv, authTag, plaintext);
    },
    [editingMessage, replyingTo, editMessage, sendReplyMessage, sendMessage],
  );

  const lastEditableMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.isOwn || message.id == null || message.pending) continue;
      return {
        id: message.id,
        originalText: getRawText(message) === "​" ? "" : getRawText(message),
      };
    }

    return null;
  }, [getRawText, messages]);

  const handleStartEditLastMessage = useCallback(() => {
    if (!lastEditableMessage) return;
    setPendingFile(null);
    setEditingMessage(lastEditableMessage);
  }, [lastEditableMessage]);

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
      <ChatTopbar
        member={member}
        server={server}
        sharedSecret={sharedSecret}
        onBack={onBack}
      />
      <ChatMessages
        server={server}
        member={member}
        messages={messages}
        loading={loading}
        hasMore={hasMore}
        fetchMore={fetchMore}
        getRawText={getRawText}
        getAttachmentMeta={getAttachmentMeta}
        sevenTvEnabled={sevenTvEnabled}
        sevenTvEmotesSet={sevenTvEmotesSet}
        sharedSecret={sharedSecret}
        onTogglePinMessage={togglePinMessage}
        onEditMessage={(messageId, rawText) => {
          setPendingFile(null);
          setEditingMessage({ id: messageId, originalText: rawText });
        }}
        onReplyMessage={(messageId, rawText) => {
          setEditingMessage(null);
          setReplyingTo({ id: messageId, rawText });
        }}
        onJumpToReply={() => {}}
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
        onEditLastMessage={handleStartEditLastMessage}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />
    </div>
  );
}

export const AppServer = ({
  server,
  onMobileServerMenu,
}: {
  server: Server;
  onMobileServerMenu?: () => void;
}) => {
  const { authorize, token, isAuthorizing, error } = useAuthorizer(server);
  const platform = usePlatform();
  const [selectedMember, setSelectedMember] = useState<ChatMember | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const { selectChat } = useSelectedChat();
  const mobileEnabled = onMobileServerMenu !== undefined;

  // Self identity for channel view — resolved from cache after auth
  const { username: selfUsername, avatar: selfAvatar } = useSelfInfo(server);

  // Mount channel key manager at app level so keys are delivered even when no channel is selected
  useChannelKeyManager(server);
  useAppPresence(server);

  const { joinVoiceChannel, leaveVoiceChannel, toggleMute, toggleDeafen, setParticipantVolume } =
    useVoiceChannel(server);

  useBackgroundMessages(server);

  useEffect(() => {
    if (!token && !error) {
      authorize(server.username).catch(() => {});
    }
  }, [server.id]);

  useEffect(() => {
    setSelectedMember(null);
    setSelectedChannel(null);
    setMobileView("list");
    selectChat(null);
  }, [server.id]);

  const handleSelectMember = useCallback(
    (member: ChatMember) => {
      setSelectedMember(member);
      setSelectedChannel(null);
      setMobileView("chat");
      selectChat(member);
    },
    [selectChat],
  );

  const handleSelectChannel = useCallback(
    (channel: Channel) => {
      setSelectedChannel(channel);
      setSelectedMember(null);
      setMobileView("chat");
      selectChat(null);
    },
    [selectChat],
  );

  const handleVoiceJoin = useCallback(
    (channel: Channel) => {
      joinVoiceChannel(channel.id, channel.name);
    },
    [joinVoiceChannel],
  );

  const handleMobileBack = () => {
    setMobileView("list");
  };

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

  const selfId = server.id;

  const showChat = selectedMember !== null;
  const showChannel = selectedChannel !== null;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Sidebar: chat + channel list */}
      <div
        className={
          mobileEnabled
            ? `${mobileView === "list" ? "flex" : "hidden"} md:flex w-full md:w-auto flex-col`
            : "flex flex-col"
        }
      >
        <ChatListPanel
          server={server}
          selectedMember={selectedMember}
          selectedChannel={selectedChannel}
          onSelect={handleSelectMember}
          onSelectChannel={handleSelectChannel}
          onVoiceJoin={handleVoiceJoin}
          onVoiceLeave={leaveVoiceChannel}
          onVoiceMuteToggle={toggleMute}
          onVoiceDeafenToggle={toggleDeafen}
          onVoiceSetParticipantVolume={setParticipantVolume}
          onMenuOpen={onMobileServerMenu}
        />
      </div>

      {/* Main content area */}
      <div
        className={
          mobileEnabled
            ? `${mobileView === "chat" ? "flex" : "hidden"} md:flex flex-1 flex-col min-h-0 overflow-hidden`
            : "flex flex-1 flex-col min-h-0 overflow-hidden"
        }
      >
        {showChat ? (
          <ChatView
            server={server}
            member={selectedMember!}
            onBack={mobileEnabled ? handleMobileBack : undefined}
          />
        ) : showChannel ? (
          <ChannelView
            server={server}
            channel={selectedChannel!}
            selfId={selfId}
            selfUsername={selfUsername}
            selfAvatar={selfAvatar}
            onBack={mobileEnabled ? handleMobileBack : undefined}
          />
        ) : (
          <ChatEmptyState />
        )}
      </div>
    </div>
  );
};
