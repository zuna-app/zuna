import type { ConversationView } from "@zuna/core";
import { BadgeCheck, Bookmark, Copy, Forward, Lock, PanelRight, Pin, Search, ShieldAlert, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar, Tooltip, TypingDots, useAction } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatFull, formatLastSeen } from "@/lib/format";
import { listIdFor, useActiveServer, useApp } from "@/state/store";
import { Composer, type ComposerHandle } from "./Composer";
import { MessageList } from "./MessageList";
import { SidePanel } from "./SidePanel";

function HeaderStatus({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const peer = conversation.peerId ? server?.users[conversation.peerId] : null;
  const typingUsers = Object.keys((conversation.groupId && server?.typing[conversation.groupId]) || {});
  // The line fades between typing and the usual status, but not on opening a chat.
  const everTyped = useRef(false);
  everTyped.current ||= typingUsers.length > 0;
  const statusClass = `chat-status${everTyped.current ? " is-changing" : ""}`;
  if (typingUsers.length > 0) {
    const names = typingUsers.map((id) => server?.users[id]?.displayName.split(" ")[0] ?? "Someone");
    const label = conversation.kind === "dm" ? "typing" : names.length === 1 ? `${names[0]} is typing` : `${names.length} people are typing`;
    return (
      <span key="typing" className={`${statusClass} is-typing`}>
        {label}
        <TypingDots />
      </span>
    );
  }
  if (conversation.kind === "group") {
    const online = conversation.members.filter((member) => server?.users[member.userId]?.online).length;
    const count = conversation.members.length;
    return (
      <span key="status" className={statusClass}>
        {count} {count === 1 ? "member" : "members"}
        {online > 0 ? `, ${online} online` : ""}
      </span>
    );
  }
  if (conversation.peerId === server?.self?.userId) return <span key="status" className={statusClass}>Notes to yourself</span>;
  if (peer?.banned) return <span key="status" className={statusClass}>Removed from this server</span>;
  if (peer?.online) return <span key="status" className={`${statusClass} is-online`}>online</span>;
  return <span key="status" className={statusClass}>{formatLastSeen(peer?.lastSeenAt ?? null, peer?.hidesLastSeen ?? false)}</span>;
}

/** What can be done with the picked messages, in place of the composer, as in Telegram. */
function SelectionBar({ conversation, listId }: { conversation: ConversationView; listId: string }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const toggleSelected = useApp((state) => state.toggleSelected);
  const ids = useApp((state) => state.selection?.ids ?? []);
  const items = useApp((state) => state.lists[listId]?.items ?? []);
  const { busy, run } = useAction();
  // In the chat's order, whatever order they were picked in.
  const picked = items.filter((item) => ids.includes(item.id));
  const selfId = server?.self?.userId;
  const isAdmin = conversation.members.find((member) => member.userId === selfId)?.role === "admin";
  const canDelete = picked.length > 0 && picked.every((item) => item.senderId === selfId || (conversation.kind === "group" && isAdmin));
  const stop = () => toggleSelected(listId, null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const copy = async () => {
    const name = (id: string) => (id === selfId ? "You" : (server?.users[id]?.displayName ?? "Unknown"));
    const text =
      picked.length === 1
        ? picked[0]!.text
        : picked.map((item) => `${name(item.senderId)}, [${formatFull(item.createdAt)}]\n${item.text || item.attachments.map((file) => file.name).join(", ")}`).join("\n\n");
    await copyText(text);
    toast(picked.length === 1 ? "Copied" : `Copied ${picked.length} messages`);
    stop();
  };

  return (
    <div className="selection-bar">
      <Tooltip text="Cancel" side="top">
        <button className="icon-btn" onClick={stop} aria-label="Cancel selection">
          <X size={18} />
        </button>
      </Tooltip>
      <span className="grow selection-count">
        {picked.length} {picked.length === 1 ? "message" : "messages"} selected
      </span>
      <button className="btn" disabled={!picked.length} onClick={() => void copy()}>
        <Copy size={15} /> Copy
      </button>
      <button
        className="btn"
        disabled={!picked.length || !conversation.groupId}
        onClick={() => useApp.getState().setOverlay({ type: "forward", serverId: server!.entry.id, groupId: conversation.groupId!, ids: picked.map((item) => item.id) })}
      >
        <Forward size={15} /> Forward
      </button>
      {canDelete && (
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await session().deleteMessages(conversation.groupId!, picked.map((item) => item.id));
              stop();
            })
          }
        >
          <Trash2 size={15} /> Delete for everyone
        </button>
      )}
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
  const selecting = useApp((state) => state.selection?.listId === listId);

  useEffect(() => {
    void loadList(listId, conversation.groupId);
  }, [listId, conversation.groupId, loadList]);

  // Picked messages belong to the chat they were picked in.
  useEffect(() => () => useApp.getState().toggleSelected(listId, null), [listId]);

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

        <div className="chat-scroll">
          <MessageList conversation={conversation} listId={listId} emptyState={<EmptyChat conversation={conversation} />} />
        </div>

        {selecting ? (
          <SelectionBar conversation={conversation} listId={listId} />
        ) : peer?.banned && !isSaved ? (
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
