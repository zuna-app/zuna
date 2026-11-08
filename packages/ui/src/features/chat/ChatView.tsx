import type { ConversationView, MessageView } from "@zuna/core";
import { Ban, BadgeCheck, Bell, BellOff, Bookmark, Copy, Forward, Hash, Lock, PanelRight, Pencil, Phone, Pin, Search, ShieldAlert, Timer, Trash2, Upload, Users, Video, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, PopupMenu, Tooltip, TypingDots, useAction } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { useEscape } from "@/lib/escape";
import { timerText } from "@/lib/disappearing";
import { formatFull, formatLastSeen } from "@/lib/format";
import { muteEntries } from "@/lib/mute";
import { activeServerNow, listIdFor, useActiveField, useActiveServer, useApp } from "@/state/store";
import { useShallow } from "zustand/react/shallow";
import { VoiceStage } from "@/features/voice/VoiceStage";
import { useVoice } from "@/voice/store";
import { Composer, type ComposerHandle } from "./Composer";
import { MemberList } from "./MemberList";
import { MessageList } from "./MessageList";
import { SidePanel } from "./SidePanel";

const MEMBERS_KEY = "zuna-member-list";

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
  if (peer?.deleted) return <span key="status" className={statusClass}>Deleted their account</span>;
  if (peer?.banned) return <span key="status" className={statusClass}>Removed from this server</span>;
  if (peer?.online) return <span key="status" className={`${statusClass} is-online`}>online</span>;
  return <span key="status" className={statusClass}>{formatLastSeen(peer?.lastSeenAt ?? null, peer?.hidesLastSeen ?? false)}</span>;
}

/** Whether a call can be started here: a direct message with someone else, or a group still had. */
function canCall(conversation: ConversationView, selfId: string | undefined, peerGone: boolean): boolean {
  if (conversation.kind === "dm") return !!conversation.peerId && conversation.peerId !== selfId && !conversation.blocked && !peerGone && !conversation.removed;
  return conversation.kind === "group" && !conversation.removed;
}

/** Starting a call, or joining the one going on, from a conversation's header. */
function CallButtons({ conversation, going }: { conversation: ConversationView; going: boolean }) {
  const serverId = useApp((state) => state.activeServerId);
  const startCall = useVoice((state) => state.startCall);
  const join = useVoice((state) => state.join);
  if (!serverId) return null;
  if (going && conversation.groupId) {
    return (
      <Tooltip text="Join the call">
        <button className="btn btn-small call-join" onClick={() => void join(serverId, conversation.groupId!)} aria-label="Join the call">
          <Phone size={15} /> Join
        </button>
      </Tooltip>
    );
  }
  return (
    <>
      <Tooltip text="Start a voice call">
        <button className="icon-btn" onClick={() => void startCall(serverId, conversation.key, false)} aria-label="Start a voice call">
          <Phone size={17} />
        </button>
      </Tooltip>
      <Tooltip text="Start a video call">
        <button className="icon-btn" onClick={() => void startCall(serverId, conversation.key, true)} aria-label="Start a video call">
          <Video size={18} />
        </button>
      </Tooltip>
    </>
  );
}

/** A call going on in this conversation that this device isn't in: who's there, and a way in. */
function CallBanner({ conversation, people }: { conversation: ConversationView; people: string[] }) {
  const serverId = useApp((state) => state.activeServerId);
  const selfId = useActiveField((server) => server.self?.userId, undefined);
  // Only the first two are named, so only their names are watched.
  const first = useActiveField((server) => server.users[people[0] ?? ""]?.displayName, undefined);
  const second = useActiveField((server) => server.users[people[1] ?? ""]?.displayName, undefined);
  const join = useVoice((state) => state.join);
  if (!serverId || !conversation.groupId || people.length === 0) return null;
  const nameOf = (id: string | undefined, displayName: string | undefined) => (id === selfId ? "You" : (displayName?.split(" ")[0] ?? "Someone"));
  const names = [nameOf(people[0], first), nameOf(people[1], second), ...people.slice(2)];
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  // Being in it on another device of yours is still being in it.
  const elsewhere = people.includes(selfId ?? "");
  return (
    <div className="call-banner">
      <Phone size={15} />
      <span className="grow truncate">
        {elsewhere ? "You're in this call on another device" : `${who} ${people.length === 1 ? "is" : "are"} in a call`}
      </span>
      <button className="btn btn-small btn-primary" onClick={() => void join(serverId, conversation.groupId!)}>
        {elsewhere ? "Move here" : "Join"}
      </button>
    </div>
  );
}

/**
 * A channel's header, as in Discord: its name, then its topic after a line, and on the
 * right notifications, pins, the member list and search.
 */
function ChannelHeader({ conversation, voice, showMembers, onToggleMembers, onClose }: { conversation: ConversationView; voice?: boolean; showMembers: boolean; onToggleMembers?: () => void; onClose?: () => void }) {
  const session = useApp((state) => state.session);
  const panel = useApp((state) => state.panel);
  const togglePanel = useApp((state) => state.togglePanel);
  const [muteMenu, setMuteMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <header className="chat-head channel-head">
      <button className="channel-head-name" onClick={() => togglePanel("info")} aria-label="Channel details">
        {voice ? <Volume2 size={22} /> : <Hash size={22} />}
        <h1 className="chat-title truncate">{conversation.title}</h1>
      </button>
      {conversation.description && (
        <>
          <span className="channel-head-divider" />
          <button className="channel-head-topic truncate" onClick={() => togglePanel("info")} title={conversation.description}>
            {conversation.description}
          </button>
        </>
      )}
      <span className="grow" />
      <div className="chat-actions">
        <Tooltip text={conversation.muted ? "Unmute channel" : "Notification settings"}>
          <button
            className={`icon-btn${muteMenu ? " is-active" : ""}`}
            onClick={(event) => {
              if (conversation.muted) {
                void session().unmute(conversation.key);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMuteMenu({ x: rect.right, y: rect.bottom + 6 });
            }}
            aria-label={conversation.muted ? "Unmute channel" : "Notification settings"}
          >
            {conversation.muted ? <BellOff size={20} /> : <Bell size={20} />}
          </button>
        </Tooltip>
        {muteMenu && <PopupMenu x={muteMenu.x} y={muteMenu.y} alignRight entries={muteEntries((until) => void session().mute(conversation.key, until))} onClose={() => setMuteMenu(null)} />}
        <Tooltip text="Pinned messages">
          <button className={`icon-btn${panel?.type === "pins" ? " is-active" : ""}`} onClick={() => togglePanel("pins")} aria-label="Pinned messages">
            <Pin size={20} />
          </button>
        </Tooltip>
        {onToggleMembers && (
          <Tooltip text={showMembers ? "Hide member list" : "Show member list"}>
            <button className={`icon-btn${showMembers && !panel ? " is-active" : ""}`} onClick={onToggleMembers} aria-label={showMembers ? "Hide member list" : "Show member list"}>
              <Users size={20} />
            </button>
          </Tooltip>
        )}
        <button className={`channel-search${panel?.type === "search" ? " is-active" : ""}`} onClick={() => togglePanel("search")} aria-label="Search this channel">
          <span className="truncate">Search</span>
          <Search size={15} />
        </button>
        {onClose && (
          <Tooltip text="Hide chat">
            <button className="icon-btn" onClick={onClose} aria-label="Hide chat">
              <X size={20} />
            </button>
          </Tooltip>
        )}
      </div>
    </header>
  );
}

/** Who's typing in a channel, under the message box, as in Discord. Always there, so nothing moves. */
function ChannelTyping({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const typing = Object.keys((conversation.groupId && server?.typing[conversation.groupId]) || {}).filter((id) => id !== server?.self?.userId);
  const names = typing.map((id) => server?.users[id]?.displayName ?? "Someone");
  return (
    <div className="channel-typing" aria-live="polite">
      {names.length > 0 && (
        <>
          <TypingDots />
          <span className="truncate">
            {names.length === 1 ? (
              <>
                <b>{names[0]}</b> is typing…
              </>
            ) : names.length === 2 ? (
              <>
                <b>{names[0]}</b> and <b>{names[1]}</b> are typing…
              </>
            ) : names.length === 3 ? (
              <>
                <b>{names[0]}</b>, <b>{names[1]}</b> and <b>{names[2]}</b> are typing…
              </>
            ) : (
              "Several people are typing…"
            )}
          </span>
        </>
      )}
      {conversation.slowMode > 0 && <SlowMode conversation={conversation} />}
    </div>
  );
}

/** That slow mode is on, at the right of the line under the box, as in Discord. How long until you may send again is where the send button was. */
function SlowMode({ conversation }: { conversation: ConversationView }) {
  return (
    <span className="channel-slow">
      <Tooltip text={`One message every ${timerText(conversation.slowMode)} for each person, except admins`} side="top">
        <span className="channel-slow-text">
          <Timer size={14} />
          Slow mode is on
        </span>
      </Tooltip>
    </span>
  );
}

/** The top of a channel's history, as in Discord. */
function ChannelWelcome({ conversation, voice }: { conversation: ConversationView; voice?: boolean }) {
  const role = useActiveField((server) => server.self?.role, undefined);
  const setOverlay = useApp((state) => state.setOverlay);
  const isAdmin = role === "owner" || role === "admin";
  return (
    <div className="channel-welcome">
      <span className="channel-welcome-icon">{voice ? <Volume2 size={40} /> : <Hash size={44} />}</span>
      <h2>Welcome to #{conversation.title}!</h2>
      <p>
        This is the start of the #{conversation.title} channel.{conversation.description ? ` ${conversation.description}` : ""}
      </p>
      <p className="channel-welcome-lock">
        <Lock size={13} /> End-to-end encrypted. Everyone on this server can read it, and the server itself can't.
      </p>
      {isAdmin && conversation.groupId && (
        <button className="channel-welcome-edit" onClick={() => setOverlay({ type: "channel", channelId: conversation.groupId! })}>
          <Pencil size={15} /> Edit channel
        </button>
      )}
    </div>
  );
}

// The same empty lists every time, as zustand renders again for a new one.
const NO_IDS: string[] = [];
const NO_MESSAGES: MessageView[] = [];

/** What can be done with the picked messages, in place of the composer, as in Telegram. */
function SelectionBar({ conversation, listId }: { conversation: ConversationView; listId: string }) {
  const selfId = useActiveField((server) => server.self?.userId, undefined);
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const toggleSelected = useApp((state) => state.toggleSelected);
  const ids = useApp((state) => state.selection?.ids ?? NO_IDS);
  const items = useApp((state) => state.lists[listId]?.items ?? NO_MESSAGES);
  const { busy, run } = useAction();
  // In the chat's order, whatever order they were picked in.
  const picked = items.filter((item) => ids.includes(item.id));
  const isAdmin = conversation.members.find((member) => member.userId === selfId)?.role === "admin";
  const canDelete = picked.length > 0 && picked.every((item) => item.senderId === selfId || (conversation.kind !== "dm" && isAdmin));
  const stop = () => toggleSelected(listId, null);
  useEscape(stop);

  const copy = async () => {
    const users = activeServerNow()?.users ?? {};
    const name = (id: string) => (id === selfId ? "You" : (users[id]?.displayName ?? "Unknown"));
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
        onClick={() => useApp.getState().setOverlay({ type: "forward", serverId: useApp.getState().activeServerId!, groupId: conversation.groupId!, ids: picked.map((item) => item.id) })}
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

export function ChatView({ conversation, voice, onClose }: { conversation: ConversationView; /** It's the chat of a voice channel, beside its call. */ voice?: boolean; onClose?: () => void }) {
  // Only what this uses, so presence and typing elsewhere on the server don't redraw the chat.
  const serverId = useApp((state) => state.activeServerId);
  const selfId = useActiveField((server) => server.self?.userId, undefined);
  const callsOn = useActiveField((server) => !!server.info?.calls, false);
  const peer = useActiveField((server) => (conversation.peerId ? (server.users[conversation.peerId] ?? null) : null), null);
  const listId = listIdFor(conversation);
  const loadList = useApp((state) => state.loadList);
  const togglePanel = useApp((state) => state.togglePanel);
  const panel = useApp((state) => state.panel);
  const setOverlay = useApp((state) => state.setOverlay);
  const session = useApp((state) => state.session);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const isSaved = conversation.peerId === selfId;
  const selecting = useApp((state) => state.selection?.listId === listId);
  const isChannel = conversation.kind === "channel";
  // Made once per conversation: the message list redraws every row its start or empty
  // state is given anew.
  const welcome = useMemo(() => (isChannel ? <ChannelWelcome conversation={conversation} voice={voice} /> : <EmptyChat conversation={conversation} />), [isChannel, conversation, voice]);
  const callsHere = !isChannel && callsOn && !isSaved && canCall(conversation, selfId, !!peer?.banned || !!peer?.deleted);
  // Who's in this conversation's call, and whether it's this device.
  const inCall = useVoice((state) => !!conversation.groupId && state.status !== "idle" && state.serverId === serverId && state.channelId === conversation.groupId);
  const callPeople = useApp(
    useShallow((state) => {
      const server = state.activeServerId ? state.servers[state.activeServerId] : null;
      return [...new Set(Object.values(server?.voice ?? {}).filter((member) => member.channelId === conversation.groupId).map((member) => member.userId))];
    }),
  );
  const [callExpanded, setCallExpanded] = useState(false);
  // A channel's member list stays open or closed across channels, as in Discord.
  const [showMembers, setShowMembers] = useState(() => localStorage.getItem(MEMBERS_KEY) !== "hidden");
  const toggleMembers = () => {
    // It takes the place of whatever panel was open.
    if (panel) {
      useApp.getState().setPanel(null);
      if (showMembers) return;
    }
    localStorage.setItem(MEMBERS_KEY, showMembers ? "hidden" : "shown");
    setShowMembers(!showMembers);
  };

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
      className={`chat${isChannel ? " is-channel" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
    >
      <div className="chat-column">
        {isChannel ? (
          <ChannelHeader conversation={conversation} voice={voice} showMembers={showMembers} onToggleMembers={voice ? undefined : toggleMembers} onClose={onClose} />
        ) : (
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
                  {conversation.disappearAfter > 0 && (
                    <Tooltip text={`Messages disappear after ${timerText(conversation.disappearAfter)}`}>
                      <Timer size={14} className="chat-timer" aria-label={`Messages disappear after ${timerText(conversation.disappearAfter)}`} />
                    </Tooltip>
                  )}
                </span>
                <HeaderStatus conversation={conversation} />
              </span>
            </button>
            <div className="chat-actions">
              {onClose && (
                <Tooltip text="Hide chat">
                  <button className="icon-btn" onClick={onClose} aria-label="Hide chat">
                    <X size={17} />
                  </button>
                </Tooltip>
              )}
              {callsHere && !inCall && <CallButtons conversation={conversation} going={callPeople.length > 0} />}
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
                <button className={`icon-btn${panel?.type === "info" || panel?.type === "media" ? " is-active" : ""}`} onClick={() => togglePanel("info")} aria-label="Details">
                  <PanelRight size={17} />
                </button>
              </Tooltip>
            </div>
          </header>
        )}

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

        {inCall && conversation.groupId ? (
          <VoiceStage
            room={{ id: conversation.groupId, call: true, title: conversation.title, conversation, screenLimit: 0, sounds: true }}
            expanded={callExpanded}
            onExpand={() => setCallExpanded(!callExpanded)}
          />
        ) : (
          !isChannel && <CallBanner conversation={conversation} people={callPeople} />
        )}

        <div className="chat-scroll" hidden={inCall && callExpanded}>
          <MessageList conversation={conversation} listId={listId} emptyState={welcome} start={isChannel ? welcome : undefined} />
        </div>

        {inCall && callExpanded ? null : selecting ? (
          <SelectionBar conversation={conversation} listId={listId} />
        ) : conversation.removed ? (
          <RemovedFromChat conversation={conversation} />
        ) : (peer?.banned || peer?.deleted) && !isSaved ? (
          <div className="composer-disabled">
            <X size={15} /> {peer.deleted ? "This account was deleted." : "This person was removed from the server."}
          </div>
        ) : conversation.blocked && peer ? (
          <div className="composer-disabled">
            <Ban size={15} /> You blocked {peer.displayName}.
            <button className="btn btn-small" onClick={() => void session().setBlocked(peer.id, false)}>
              Unblock
            </button>
          </div>
        ) : (
          <Composer ref={composer} conversation={conversation} listId={listId} />
        )}
        {isChannel && <ChannelTyping conversation={conversation} />}
      </div>

      {panel ? <SidePanel conversation={conversation} /> : isChannel && !voice && showMembers && <MemberList />}

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

/** The messages here stay on this device until the person clears them, or for a while. */
function RemovedFromChat({ conversation }: { conversation: ConversationView }) {
  const session = useApp((state) => state.session);
  const selectConversation = useApp((state) => state.selectConversation);
  return (
    <div className="composer-disabled">
      <X size={15} /> You're no longer in this conversation. Its messages stay on this device for 30 days.
      <button
        className="btn btn-small"
        onClick={() => {
          selectConversation(null);
          void session().forgetConversation(conversation.groupId!);
        }}
      >
        Remove now
      </button>
    </div>
  );
}

function EmptyChat({ conversation }: { conversation: ConversationView }) {
  const setOverlay = useApp((state) => state.setOverlay);
  const peer = useActiveField((server) => (conversation.peerId ? (server.users[conversation.peerId] ?? null) : null), null);
  const isSaved = useActiveField((server) => conversation.peerId === server.self?.userId, false);
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
