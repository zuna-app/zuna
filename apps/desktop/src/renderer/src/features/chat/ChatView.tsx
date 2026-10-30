import type { ConversationView, MessageView } from "@zuna/core";
import { BadgeCheck, Bookmark, Lock, PanelRight, Pin, Search, ShieldAlert, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar, Tooltip } from "@/components/ui";
import { formatLastSeen } from "@/lib/format";
import { renderMarkup } from "@/lib/markup";
import { listIdFor, useActiveServer, useApp } from "@/state/store";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageList } from "./MessageList";
import { SidePanel } from "./SidePanel";
import { useMarkupContext } from "./use-markup-context";

function HeaderStatus({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const peer = conversation.peerId ? server?.users[conversation.peerId] : null;
  const typingUsers = Object.keys((conversation.groupId && server?.typing[conversation.groupId]) || {});
  if (typingUsers.length > 0) {
    const names = typingUsers.map((id) => server?.users[id]?.displayName.split(" ")[0] ?? "Someone");
    const label = conversation.kind === "dm" ? "typing" : names.length === 1 ? `${names[0]} is typing` : `${names.length} people are typing`;
    return (
      <span className="chat-status is-typing">
        {label}
        <span className="typing-dots">
          <i />
          <i />
          <i />
        </span>
      </span>
    );
  }
  if (conversation.kind === "group") {
    const online = conversation.members.filter((member) => server?.users[member.userId]?.online).length;
    const count = conversation.members.length;
    return (
      <span className="chat-status">
        {count} {count === 1 ? "member" : "members"}
        {online > 0 ? `, ${online} online` : ""}
      </span>
    );
  }
  if (conversation.peerId === server?.self?.userId) return <span className="chat-status">Notes to yourself</span>;
  if (peer?.banned) return <span className="chat-status">Removed from this server</span>;
  if (peer?.online) return <span className="chat-status is-online">online</span>;
  return <span className="chat-status">{formatLastSeen(peer?.lastSeenAt ?? null, peer?.hidesLastSeen ?? false)}</span>;
}

function PinnedBar({ conversation, onOpenAll }: { conversation: ConversationView; onOpenAll: () => void }) {
  const session = useApp((state) => state.session);
  const jump = useApp((state) => state.jumpToMessage);
  const signature = useApp((state) => {
    const list = conversation.groupId ? state.lists[conversation.groupId] : undefined;
    return list?.items.filter((item) => item.pinnedAt).map((item) => item.id).join(",") ?? "";
  });
  const [pins, setPins] = useState<MessageView[]>([]);
  const [index, setIndex] = useState(0);
  const context = useMarkupContext();

  useEffect(() => {
    if (!conversation.groupId) return;
    let cancelled = false;
    void session()
      .loadPins(conversation.groupId)
      .then((messages) => {
        if (!cancelled) setPins(messages);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversation.groupId, signature, session]);

  const current = pins[Math.min(index, pins.length - 1)];
  if (!current) return null;
  return (
    <div className="pinned-bar">
      <button
        className="pinned-main"
        onClick={() => {
          void jump(conversation.groupId!, current.id, current.seq);
          setIndex((value) => (value + 1) % pins.length);
        }}
      >
        <span className="pinned-rail">
          {pins.slice(0, 4).map((pin) => (
            <i key={pin.id} className={pin.id === current.id ? "is-active" : ""} />
          ))}
        </span>
        <span className="grow">
          <span className="pinned-label">Pinned message{pins.length > 1 ? ` ${Math.min(index, pins.length - 1) + 1} of ${pins.length}` : ""}</span>
          <span className="pinned-text truncate">
            {current.text ? renderMarkup(current.text.split("\n")[0]!.slice(0, 120), { ...context, emotes: current.emotes }) : current.attachments[0]?.name ?? "Attachment"}
          </span>
        </span>
      </button>
      <Tooltip text="All pinned messages">
        <button className="icon-btn" onClick={onOpenAll} aria-label="All pinned messages">
          <Pin size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

export function ChatView({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const listId = listIdFor(conversation);
  const loadList = useApp((state) => state.loadList);
  const togglePanel = useApp((state) => state.togglePanel);
  const panel = useApp((state) => state.panel);
  const setOverlay = useApp((state) => state.setOverlay);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const peer = conversation.peerId ? server?.users[conversation.peerId] : null;
  const isSaved = conversation.peerId === server?.self?.userId;

  useEffect(() => {
    void loadList(listId, conversation.groupId);
  }, [listId, conversation.groupId, loadList]);

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) composer.current?.addFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className="chat"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
    >
      <div className="chat-column">
        <header className="chat-head">
          <button className="chat-identity" onClick={() => togglePanel("info")}>
            {isSaved ? (
              <span className="avatar saved-avatar" style={{ width: 36, height: 36 }}>
                <Bookmark size={16} />
              </span>
            ) : (
              <Avatar name={conversation.title} seed={conversation.peerId ?? conversation.groupId ?? ""} avatar={conversation.avatar} size={36} />
            )}
            <span className="chat-names">
              <span className="chat-title truncate">
                {conversation.title}
                {peer?.trust === "verified" && !isSaved && (
                  <Tooltip text="Security key verified">
                    <BadgeCheck size={14} className="conv-verified" />
                  </Tooltip>
                )}
              </span>
              <HeaderStatus conversation={conversation} />
            </span>
          </button>
          <div className="chat-actions">
            <Tooltip text="Search this chat">
              <button className={`icon-btn${panel?.type === "search" ? " is-active" : ""}`} onClick={() => togglePanel("search")} aria-label="Search this chat" disabled={!conversation.groupId}>
                <Search size={17} />
              </button>
            </Tooltip>
            <Tooltip text="Pinned messages">
              <button className={`icon-btn${panel?.type === "pins" ? " is-active" : ""}`} onClick={() => togglePanel("pins")} aria-label="Pinned messages" disabled={!conversation.groupId}>
                <Pin size={17} />
              </button>
            </Tooltip>
            <Tooltip text="Details">
              <button className={`icon-btn${panel?.type === "info" ? " is-active" : ""}`} onClick={() => togglePanel("info")} aria-label="Details">
                <PanelRight size={17} />
              </button>
            </Tooltip>
          </div>
        </header>

        {peer?.trust === "changed" && !isSaved && (
          <div className="security-banner">
            <div className="security-banner-inner">
              <ShieldAlert size={16} />
              <span className="grow">
                <b>{conversation.title}'s security key changed.</b> This can mean someone is intercepting this chat. Compare keys before sharing anything private.
              </span>
              <button className="btn btn-small" onClick={() => setOverlay({ type: "verify", userId: peer.id })}>
                Verify
              </button>
            </div>
          </div>
        )}

        <PinnedBar conversation={conversation} onOpenAll={() => togglePanel("pins")} />

        <div className="chat-scroll">
          <MessageList conversation={conversation} listId={listId} emptyState={<EmptyChat conversation={conversation} />} />
        </div>

        {peer?.banned && !isSaved ? (
          <div className="composer-disabled">
            <X size={15} /> This person was removed from the server.
          </div>
        ) : (
          <Composer ref={composer} conversation={conversation} listId={listId} />
        )}
      </div>

      {panel && <SidePanel conversation={conversation} />}

      {dragging && (
        <div
          className="drop-overlay"
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <div className="drop-card">
            <Upload size={26} />
            <b style={{ fontWeight: 500 }}>Drop to send</b>
            <span>Files are encrypted before they leave this device</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyChat({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const setOverlay = useApp((state) => state.setOverlay);
  const peer = conversation.peerId ? server?.users[conversation.peerId] : null;
  const isSaved = conversation.peerId === server?.self?.userId;
  return (
    <div className="chat-empty-card">
      <Lock size={20} />
      {isSaved ? (
        <>
          <h3>Your saved messages</h3>
          <p>Keep notes, links and files here. They're encrypted and sync across your devices.</p>
        </>
      ) : conversation.kind === "group" ? (
        <>
          <h3>{conversation.title}</h3>
          <p>Messages here are end-to-end encrypted. Only members can read them.</p>
        </>
      ) : (
        <>
          <h3>Say hello to {conversation.title}</h3>
          <p>Your messages are end-to-end encrypted. Not even this server can read them.</p>
          {peer && peer.trust !== "verified" && (
            <button className="btn btn-small" onClick={() => setOverlay({ type: "verify", userId: peer.id })}>
              Verify with emoji
            </button>
          )}
        </>
      )}
    </div>
  );
}
