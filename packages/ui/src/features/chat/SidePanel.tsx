import type { ConversationView, MessageView, ReportReason, SearchResult } from "@zuna/core";
import { plainText } from "@zuna/core/plain-text";
import {
  AtSign,
  Ban,
  BadgeCheck,
  Bell,
  BellOff,
  Camera,
  ChevronLeft,
  Crown,
  Eye,
  EyeOff,
  Flag,
  Lock,
  LogOut,
  Pin,
  PinOff,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trash2,
  UserMinus,
  UserPlus,
  X,
  Check,
  Pencil,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar, Field, PopupMenu, Switch, Tooltip, useAction } from "@/components/ui";
import { timerEntries, timerText } from "@/lib/disappearing";
import { formatFull, formatLastSeen, formatListTime, nameColor } from "@/lib/format";
import { prepareAvatar } from "@/lib/media";
import { muteEntries, mutedUntilText } from "@/lib/mute";
import { REPORT_REASON_LABELS } from "@/lib/report";
import { useActiveServer, useApp } from "@/state/store";
import { SharedMediaContent, SharedMediaRows, sharedTitle } from "./SharedMedia";

export function SidePanel({ conversation }: { conversation: ConversationView }) {
  const panel = useApp((state) => state.panel);
  const setPanel = useApp((state) => state.setPanel);
  return (
    <aside className="side-panel">
      <div className="side-panel-inner">
        <header className="side-head">
          {panel?.type === "media" ? (
            <h3 className="row" style={{ gap: 4 }}>
              <button className="icon-btn is-small" onClick={() => setPanel({ type: "info" })} aria-label="Back to details">
                <ChevronLeft size={17} />
              </button>
              {sharedTitle(panel.kind)}
            </h3>
          ) : (
            <h3>{panel?.type === "search" ? (conversation.kind === "channel" ? "Search this channel" : "Search this chat") : panel?.type === "pins" ? "Pinned messages" : conversation.kind === "group" ? "Group details" : conversation.kind === "channel" ? "Channel details" : "Details"}</h3>
          )}
          <button className="icon-btn is-small" onClick={() => setPanel(null)} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {panel?.type === "info" && <InfoContent conversation={conversation} />}
        {panel?.type === "search" && <SearchContent conversation={conversation} />}
        {panel?.type === "pins" && <PinsContent conversation={conversation} />}
        {panel?.type === "media" && <SharedMediaContent key={panel.kind} conversation={conversation} kind={panel.kind} />}
      </div>
    </aside>
  );
}

function PreferenceRows({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const [muteMenu, setMuteMenu] = useState<{ x: number; y: number } | null>(null);
  const toggle = (list: "pinned" | "hidden") => {
    const current = server!.prefs[list];
    void session().updatePreferences({
      [list]: current.includes(conversation.key) ? current.filter((item) => item !== conversation.key) : [...current, conversation.key],
    });
  };
  return (
    <div className="side-section">
      <div className="side-row">
        {conversation.muted ? <BellOff size={17} /> : <Bell size={17} />}
        <span className="grow">
          Notifications
          {conversation.mutedUntil && <span className="side-row-hint">{mutedUntilText(conversation.mutedUntil)}</span>}
        </span>
        <span
          onClickCapture={(event) => {
            // Turning them off asks for how long.
            if (conversation.muted) return;
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            setMuteMenu({ x: rect.right, y: rect.bottom + 4 });
          }}
        >
          <Switch on={!conversation.muted} onChange={() => void session().unmute(conversation.key)} label="Notifications" />
        </span>
        {muteMenu && (
          <PopupMenu
            x={muteMenu.x}
            y={muteMenu.y}
            alignRight
            entries={muteEntries((until) => void session().mute(conversation.key, until))}
            onClose={() => setMuteMenu(null)}
          />
        )}
      </div>
      {conversation.kind === "group" && (
        <div className="side-row">
          <AtSign size={17} />
          <span className="grow">
            Only mentions
            <span className="side-row-hint">Notify only when someone mentions you or replies to you</span>
          </span>
          <Switch on={conversation.mentionsOnly} onChange={(on) => void session().setMentionsOnly(conversation.key, on)} label="Only mentions" />
        </div>
      )}
      <button className="side-row is-button" onClick={() => toggle("pinned")}>
        {conversation.pinned ? <PinOff size={17} /> : <Pin size={17} />}
        <span className="grow">{conversation.pinned ? "Unpin from top" : "Pin to top"}</span>
      </button>
      <button className="side-row is-button" onClick={() => toggle("hidden")}>
        {conversation.hidden ? <Eye size={17} /> : <EyeOff size={17} />}
        <span className="grow">{conversation.hidden ? "Show in list" : "Hide from list"}</span>
      </button>
    </div>
  );
}

/**
 * How long messages sent here last. In a direct message either person can change
 * it, and in a group its admins. Shown once the chat has started.
 */
function DisappearingRow({ conversation, canChange }: { conversation: ConversationView; canChange: boolean }) {
  const session = useApp((state) => state.session);
  const { run } = useAction();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  if (!conversation.groupId || !conversation.ready) return null;
  const label = (
    <>
      <Timer size={17} />
      <span className="grow">
        Disappearing messages
        <span className="side-hint">
          {conversation.disappearAfter > 0
            ? `New messages disappear ${timerText(conversation.disappearAfter)} after they're sent.`
            : "New messages stay until they're deleted."}
        </span>
      </span>
      <span className="faint">{timerText(conversation.disappearAfter)}</span>
    </>
  );
  return (
    <div className="side-section">
      {canChange ? (
        <button
          className="side-row is-button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.right, y: rect.bottom + 4 });
          }}
        >
          {label}
        </button>
      ) : (
        <div className="side-row">{label}</div>
      )}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          alignRight
          entries={timerEntries(conversation.disappearAfter, (seconds) => void run(() => session().setDisappearing(conversation.groupId!, seconds)))}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function InfoContent({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const setOverlay = useApp((state) => state.setOverlay);
  const peer = conversation.peerId ? server?.users[conversation.peerId] : null;
  const isSelf = conversation.peerId === server?.self?.userId;

  if (conversation.kind === "channel") return <ChannelInfo conversation={conversation} />;
  if (conversation.kind === "group") return <GroupInfo conversation={conversation} />;

  return (
    <div className="side-body">
      <div className="profile-card">
        <Avatar name={conversation.title} seed={conversation.peerId ?? ""} avatar={conversation.avatar} size={80} online={peer?.online} />
        <h2>{isSelf ? peer?.displayName : conversation.title}</h2>
        {peer && !peer.deleted && <p className="muted">@{peer.username}</p>}
        {peer && !isSelf && (
          <p className={peer.online ? "profile-online" : "faint"} style={{ fontSize: 12.5 }}>
            {peer.deleted ? "Deleted their account" : peer.online ? "online" : formatLastSeen(peer.lastSeenAt, peer.hidesLastSeen)}
          </p>
        )}
        {peer?.bio && <p className="profile-bio selectable">{peer.bio}</p>}
      </div>
      {peer && !isSelf && !peer.deleted && (
        <div className="side-section">
          <h4>Encryption</h4>
          <button className={`trust-card trust-${peer.trust}`} onClick={() => setOverlay({ type: "verify", userId: peer.id })}>
            {peer.trust === "verified" ? <ShieldCheck size={20} /> : peer.trust === "changed" ? <ShieldAlert size={20} /> : <Shield size={20} />}
            <span className="grow">
              <b>{peer.trust === "verified" ? "Verified" : peer.trust === "changed" ? "Security key changed" : "Not verified yet"}</b>
              <span>{peer.trust === "verified" ? "You've confirmed this is really them." : "Compare emoji to make sure nobody is in between."}</span>
            </span>
          </button>
        </div>
      )}
      <SharedMediaRows conversation={conversation} />
      <DisappearingRow conversation={conversation} canChange />
      <PreferenceRows conversation={conversation} />
      {peer && !isSelf && !peer.deleted && (
        <div className="side-section">
          <BlockRow userId={peer.id} name={peer.displayName} />
          {!peer.banned && <ReportRow userId={peer.id} name={peer.displayName} />}
        </div>
      )}
    </div>
  );
}

/**
 * Reporting someone to the server's admins, last in their profile. The admins learn
 * whom and why, never what was said nor who reported them.
 */
function ReportRow({ userId, name }: { userId: string; name: string }) {
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const reported = useActiveServer()?.prefs.reported?.includes(userId) ?? false;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { run } = useAction();
  if (reported) {
    return (
      <div className="side-row">
        <Flag size={17} />
        <span className="grow faint">Reported to the server's admins</span>
      </div>
    );
  }
  return (
    <>
      <button
        className="side-row is-button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <Flag size={17} />
        <span className="grow">
          Report {name}
          <span className="side-row-hint">The server's admins see whom and why, never what was said or who reported.</span>
        </span>
      </button>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          entries={Object.entries(REPORT_REASON_LABELS).map(([reason, label]) => ({
            label,
            onSelect: () =>
              void run(async () => {
                await session().reportUser(userId, reason as ReportReason);
                toast("Reported to the server's admins");
              }),
          }))}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Blocking someone, or unblocking them. Nobody is told, so it needs no warning. */
function BlockRow({ userId, name }: { userId: string; name: string }) {
  const session = useApp((state) => state.session);
  const blocked = useActiveServer()?.prefs.blocked?.includes(userId) ?? false;
  const { run } = useAction();
  return (
    <button className={`side-row is-button${blocked ? "" : " is-danger"}`} onClick={() => void run(() => session().setBlocked(userId, !blocked))}>
      <Ban size={17} />
      <span className="grow">
        {blocked ? `Unblock ${name}` : `Block ${name}`}
        {!blocked && <span className="side-row-hint">You won't see their messages or hear about them. They aren't told.</span>}
      </span>
    </button>
  );
}

/** A channel's details: what it's for, and what's been shared there. Who's in it is everyone. */
function ChannelInfo({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const setOverlay = useApp((state) => state.setOverlay);
  const [muteMenu, setMuteMenu] = useState<{ x: number; y: number } | null>(null);
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";
  return (
    <div className="side-body">
      <div className="side-section">
        <h3 style={{ padding: "4px 8px" }}>#{conversation.title}</h3>
        {conversation.description && <p className="side-hint selectable" style={{ padding: "0 8px 6px" }}>{conversation.description}</p>}
        {isAdmin && (
          <button className="side-row is-button" onClick={() => setOverlay({ type: "channel", channelId: conversation.groupId! })}>
            <Pencil size={17} />
            <span className="grow">Edit channel</span>
          </button>
        )}
        <button
          className="side-row is-button"
          onClick={(event) => {
            if (conversation.muted) {
              void session().unmute(conversation.key);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            setMuteMenu({ x: rect.right, y: rect.bottom + 4 });
          }}
        >
          {conversation.muted ? <BellOff size={17} /> : <Bell size={17} />}
          <span className="grow">
            {conversation.muted ? "Unmute" : "Mute"}
            <span className="side-row-hint">{conversation.muted ? "You won't hear about anything here." : "You hear about what's said to you."}</span>
          </span>
        </button>
        {muteMenu && <PopupMenu x={muteMenu.x} y={muteMenu.y} alignRight entries={muteEntries((until) => void session().mute(conversation.key, until))} onClose={() => setMuteMenu(null)} />}
      </div>
      <SharedMediaRows conversation={conversation} />
      <div className="side-section">
        <div className="side-row">
          <Lock size={17} />
          <span className="grow">
            End-to-end encrypted
            <span className="side-row-hint">Everyone on this server can read it, and the server itself can't.</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function GroupInfo({ conversation }: { conversation: ConversationView }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const setOverlay = useApp((state) => state.setOverlay);
  const selectConversation = useApp((state) => state.selectConversation);
  const { run } = useAction();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(conversation.title);
  const [description, setDescription] = useState(conversation.description);
  const [memberMenu, setMemberMenu] = useState<{ x: number; y: number; userId: string } | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const selfId = server?.self?.userId ?? "";
  const isAdmin = conversation.members.find((member) => member.userId === selfId)?.role === "admin";
  const groupId = conversation.groupId!;

  const members = [...conversation.members].sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return (server?.users[a.userId]?.displayName ?? "").localeCompare(server?.users[b.userId]?.displayName ?? "");
  });

  const saveDetails = async () => {
    await run(() => session().updateGroupMeta(groupId, { name: name.trim() || conversation.title, description }));
    setEditing(false);
  };

  return (
    <div className="side-body">
      <div className="profile-card">
        <div className="avatar-edit">
          <Avatar name={conversation.title} seed={groupId} avatar={conversation.avatar} size={80} />
          {isAdmin && (
            <>
              <button className="avatar-edit-button" onClick={() => avatarInput.current?.click()} aria-label="Change group picture">
                <Camera size={18} />
              </button>
              <input
                ref={avatarInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void run(async () => session().updateGroupMeta(groupId, {}, await prepareAvatar(file)));
                  event.target.value = "";
                }}
              />
            </>
          )}
        </div>
        {editing ? (
          <div className="col" style={{ width: "100%" }}>
            <Field label="Name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoFocus />
            <Field label="Description" value={description} maxLength={300} onChange={(event) => setDescription(event.target.value)} />
            <div className="row">
              <button className="btn btn-small grow" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn-small btn-primary grow" onClick={saveDetails}>Save</button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="row" style={{ gap: 6 }}>
              {conversation.title}
              {isAdmin && (
                <button className="icon-btn is-small" onClick={() => setEditing(true)} aria-label="Edit group details">
                  <Pencil size={14} />
                </button>
              )}
            </h2>
            {conversation.description && <p className="profile-bio selectable">{conversation.description}</p>}
          </>
        )}
      </div>

      <div className="notice">
        <Lock size={15} />
        <span>The server can see who is in this group, but not its name, picture or messages.</span>
      </div>

      <SharedMediaRows conversation={conversation} />

      <div className="side-section">
        <h4 className="row" style={{ justifyContent: "space-between" }}>
          {conversation.members.length} {conversation.members.length === 1 ? "member" : "members"}
          {isAdmin && (
            <Tooltip text="Add people">
              <button className="icon-btn is-small" onClick={() => setOverlay({ type: "add-members", groupId })} aria-label="Add people">
                <UserPlus size={15} />
              </button>
            </Tooltip>
          )}
        </h4>
        {members.map((member) => {
          const user = server?.users[member.userId];
          const name = user?.displayName ?? "Unknown";
          return (
            <button
              key={member.userId}
              className="member-row"
              onClick={(event) => {
                if (member.userId === selfId) return;
                setMemberMenu({ x: event.clientX, y: event.clientY, userId: member.userId });
              }}
            >
              <Avatar name={name} seed={member.userId} avatar={user?.avatar} size={36} online={user?.online} />
              <span className="grow">
                <span className="truncate" style={{ display: "block", fontWeight: 550 }}>
                  {name}
                  {member.userId === selfId && <span className="faint"> (you)</span>}
                </span>
                <span className="faint truncate" style={{ display: "block", fontSize: 12 }}>
                  {member.notOnRoster ? "Has this chat's keys, but isn't listed as a member" : member.noKeys ? "No device in this chat yet" : `@${user?.username}`}
                </span>
              </span>
              {member.notOnRoster && <ShieldAlert size={14} className="conv-warning" aria-label="Not listed as a member" />}
              {member.role === "admin" && <Crown size={13} className="faint" aria-label="Admin" />}
              {user?.trust === "verified" && <BadgeCheck size={14} className="conv-verified" aria-label="Verified" />}
            </button>
          );
        })}
      </div>

      <DisappearingRow conversation={conversation} canChange={isAdmin} />

      {isAdmin && (
        <div className="side-section">
          <div className="side-row">
            <Eye size={17} />
            <span className="grow">
              New members can read earlier messages
              <span className="side-hint">Applies to people added after this is turned on.</span>
            </span>
            <Switch
              on={conversation.historyVisible}
              onChange={(value) => void run(() => session().updateGroupMeta(groupId, {}, undefined, value))}
              label="New members can read earlier messages"
            />
          </div>
        </div>
      )}

      <PreferenceRows conversation={conversation} />

      <div className="side-section">
        <button
          className="side-row is-button is-danger"
          onClick={() =>
            void run(async () => {
              await session().leaveGroup(groupId);
              selectConversation(null);
            })
          }
        >
          <LogOut size={17} />
          <span className="grow">Leave group</span>
        </button>
        {isAdmin && (
          <button
            className="side-row is-button is-danger"
            onClick={() =>
              void run(async () => {
                await session().deleteGroup(groupId);
                selectConversation(null);
              })
            }
          >
            <Trash2 size={17} />
            <span className="grow">Delete group for everyone</span>
          </button>
        )}
      </div>

      {memberMenu && (
        <PopupMenu
          x={memberMenu.x}
          y={memberMenu.y}
          onClose={() => setMemberMenu(null)}
          entries={[
            { label: "Message", icon: <Check size={15} />, onSelect: () => selectConversation(`user:${memberMenu.userId}`) },
            { label: "Verify security key", icon: <Shield size={15} />, onSelect: () => setOverlay({ type: "verify", userId: memberMenu.userId }) },
            ...(memberMenu.userId !== selfId
              ? [
                  server?.prefs.blocked?.includes(memberMenu.userId)
                    ? { label: "Unblock", icon: <Ban size={15} />, onSelect: () => void run(() => session().setBlocked(memberMenu.userId, false)) }
                    : { label: "Block", icon: <Ban size={15} />, onSelect: () => void run(() => session().setBlocked(memberMenu.userId, true)) },
                ]
              : []),
            ...(isAdmin
              ? [
                  {
                    label: conversation.members.find((item) => item.userId === memberMenu.userId)?.role === "admin" ? "Remove admin" : "Make admin",
                    icon: <Crown size={15} />,
                    onSelect: () => {
                      const role = conversation.members.find((item) => item.userId === memberMenu.userId)?.role === "admin" ? "member" : "admin";
                      void run(() => session().setGroupRole(groupId, memberMenu.userId, role));
                    },
                  },
                  { separator: true },
                  {
                    label: "Remove from group",
                    icon: <UserMinus size={15} />,
                    danger: true,
                    onSelect: () => void run(() => session().removeMember(groupId, memberMenu.userId)),
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}

function ResultRow({ message, onOpen, action }: { message: MessageView; onOpen: () => void; action?: React.ReactNode }) {
  const server = useActiveServer();
  const sender = server?.users[message.senderId];
  return (
    <div className="result-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => event.key === "Enter" && onOpen()}>
      <Avatar name={sender?.displayName ?? "?"} seed={message.senderId} avatar={sender?.avatar} size={32} />
      <span className="grow">
        <span className="row" style={{ gap: 6 }}>
          <span className="truncate" style={{ fontWeight: 600, fontSize: 13, color: nameColor(message.senderId) }}>{sender?.displayName ?? "Unknown"}</span>
          <span className="faint" style={{ fontSize: 11 }} title={formatFull(message.createdAt)}>{formatListTime(message.createdAt)}</span>
        </span>
        <span className="result-text">{plainText(message.text) || message.attachments[0]?.name || "Attachment"}</span>
      </span>
      {action}
    </div>
  );
}

function SearchContent({ conversation }: { conversation: ConversationView }) {
  const session = useApp((state) => state.session);
  const jump = useApp((state) => state.jumpToMessage);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [coverage, setCoverage] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!conversation.groupId || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const [found, indexed] = await Promise.all([session().search(query, conversation.groupId!), session().searchCoverage()]);
      if (!cancelled) {
        setResults(found);
        setCoverage(indexed);
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, conversation.groupId, session]);

  const partial = coverage && coverage.total > 0 && coverage.done < coverage.total;

  return (
    <div className="side-body">
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder="Search messages" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} aria-label="Search messages" />
      </div>
      {partial && <p className="faint" style={{ fontSize: 12 }}>Still downloading your history. Older messages will appear in results soon.</p>}
      {query.trim().length >= 2 && results.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 18 }}>No messages found.</p>}
      {query.trim().length < 2 && (
        <p className="faint" style={{ fontSize: 12.5, textAlign: "center", padding: "18px 10px" }}>
          Search runs on this device. The server never sees what you look for.
        </p>
      )}
      {results.map((result) => (
        <ResultRow key={result.message.id} message={result.message} onOpen={() => void jump(result.message.groupId, result.message.id, result.message.seq)} />
      ))}
    </div>
  );
}

function PinsContent({ conversation }: { conversation: ConversationView }) {
  const session = useApp((state) => state.session);
  const jump = useApp((state) => state.jumpToMessage);
  const { run } = useAction();
  const [pins, setPins] = useState<MessageView[] | null>(null);
  const list = useApp((state) => (conversation.groupId ? state.lists[conversation.groupId] : undefined));
  const signature = list?.items.filter((item) => item.pinnedAt).map((item) => item.id).join(",") ?? "";

  useEffect(() => {
    if (!conversation.groupId) return;
    void session().loadPins(conversation.groupId).then(setPins).catch(() => setPins([]));
  }, [conversation.groupId, signature, session]);

  return (
    <div className="side-body">
      {pins?.length === 0 && (
        <div className="empty-state">
          <Pin size={22} className="empty-icon" />
          <p>Nothing is pinned yet. Right-click a message to pin it.</p>
        </div>
      )}
      {pins?.map((message) => (
        <ResultRow
          key={message.id}
          message={message}
          onOpen={() => void jump(message.groupId, message.id, message.seq)}
          action={
            <Tooltip text="Unpin">
              <button
                className="icon-btn is-small"
                aria-label="Unpin"
                onClick={(event) => {
                  event.stopPropagation();
                  void run(async () => {
                    await session().setPinned(message.groupId, message.id, false);
                    setPins((current) => current?.filter((item) => item.id !== message.id) ?? null);
                  });
                }}
              >
                <PinOff size={14} />
              </button>
            </Tooltip>
          }
        />
      ))}
    </div>
  );
}
