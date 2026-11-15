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
import { Avatar, BotBadge, Field, PopupMenu, Switch, Tooltip, useAction } from "@/components/ui";
import { timerEntries, timerText } from "@/lib/disappearing";
import { formatFull, formatListTime, nameColor } from "@/lib/format";
import { LastSeen } from "@/lib/last-seen";
import { prepareAvatar } from "@/lib/media";
import { muteEntries, mutedUntilText } from "@/lib/mute";
import { REPORT_REASON_LABELS } from "@/lib/report";
import { useActiveServer, useApp } from "@/state/store";
import { SharedMediaContent, SharedMediaRows, sharedTitle } from "./SharedMedia";
import { t } from "@/lib/i18n";

export function SidePanel({ conversation }: { conversation: ConversationView }) {
  const panel = useApp((state) => state.panel);
  const setPanel = useApp((state) => state.setPanel);
  return (
    <aside className="side-panel">
      <div className="side-panel-inner">
        <header className="side-head">
          {panel?.type === "media" ? (
            <h3 className="row" style={{ gap: 4 }}>
              <button className="icon-btn is-small" onClick={() => setPanel({ type: "info" })} aria-label={t("details.back")}>
                <ChevronLeft size={17} />
              </button>
              {sharedTitle(panel.kind)}
            </h3>
          ) : (
            <h3>
              {panel?.type === "search"
                ? conversation.kind === "channel"
                  ? t("channels.header.search")
                  : t("chat.header.search")
                : panel?.type === "pins"
                  ? t("chat.pinned")
                  : conversation.kind === "group"
                    ? t("details.groupTitle")
                    : conversation.kind === "channel"
                      ? t("channels.header.details")
                      : t("chat.header.details")}
            </h3>
          )}
          <button className="icon-btn is-small" onClick={() => setPanel(null)} aria-label={t("common.close")}>
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
          {t("details.notifications")}
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
          <Switch on={!conversation.muted} onChange={() => void session().unmute(conversation.key)} label={t("details.notifications")} />
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
            {t("details.mentionsOnly")}
            <span className="side-row-hint">{t("details.mentionsOnlyHint")}</span>
          </span>
          <Switch on={conversation.mentionsOnly} onChange={(on) => void session().setMentionsOnly(conversation.key, on)} label={t("details.mentionsOnly")} />
        </div>
      )}
      <button className="side-row is-button" onClick={() => toggle("pinned")}>
        {conversation.pinned ? <PinOff size={17} /> : <Pin size={17} />}
        <span className="grow">{conversation.pinned ? t("details.unpinFromTop") : t("details.pinToTop")}</span>
      </button>
      <button className="side-row is-button" onClick={() => toggle("hidden")}>
        {conversation.hidden ? <Eye size={17} /> : <EyeOff size={17} />}
        <span className="grow">{conversation.hidden ? t("details.showInList") : t("details.hideFromList")}</span>
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
        {t("details.disappearing.title")}
        <span className="side-hint">
          {conversation.disappearAfter > 0
            ? t("details.disappearing.on", { time: timerText(conversation.disappearAfter) })
            : t("details.disappearing.off")}
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
            {peer.deleted ? t("chat.header.deleted") : peer.bot ? <BotBadge /> : peer.online ? t("chat.header.online") : <LastSeen at={peer.lastSeenAt} hidden={peer.hidesLastSeen} full />}
          </p>
        )}
        {peer?.bot && !peer.deleted && (
          <p className="faint" style={{ fontSize: 12.5, textAlign: "center" }}>
            {peer.bot.ownerId === server?.self?.userId ? t("details.bot.yours") : t("details.bot.theirs", { name: server?.users[peer.bot.ownerId]?.displayName ?? t("common.someone") })}
          </p>
        )}
        {peer?.bio && <p className="profile-bio selectable">{peer.bio}</p>}
      </div>
      {peer && !isSelf && !peer.deleted && (
        <div className="side-section">
          <h4>{t("details.encryption.title")}</h4>
          <button className={`trust-card trust-${peer.trust}`} onClick={() => setOverlay({ type: "verify", userId: peer.id })}>
            {peer.trust === "verified" ? <ShieldCheck size={20} /> : peer.trust === "changed" ? <ShieldAlert size={20} /> : <Shield size={20} />}
            <span className="grow">
              <b>{peer.trust === "verified" ? t("details.encryption.verified") : peer.trust === "changed" ? t("details.encryption.changed") : t("details.encryption.notVerified")}</b>
              <span>{peer.trust === "verified" ? t("details.encryption.verifiedHint") : t("details.encryption.compareHint")}</span>
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
        <span className="grow faint">{t("details.report.done")}</span>
      </div>
    );
  }
  return (
    <>
      <button
        className="side-row is-button is-danger"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <Flag size={17} />
        <span className="grow">
          {t("details.report.title", { name })}
          <span className="side-row-hint">{t("details.report.hint")}</span>
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
                toast(t("details.report.done"));
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
        {blocked ? t("details.block.unblock", { name }) : t("details.block.block", { name })}
        {!blocked && <span className="side-row-hint">{t("details.block.hint")}</span>}
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
  const adminOnly = !!server?.channels.find((channel) => channel.id === conversation.groupId)?.adminOnly;
  return (
    <div className="side-body">
      <div className="side-section">
        <h3 style={{ padding: "4px 8px" }}>#{conversation.title}</h3>
        {conversation.description && <p className="side-hint selectable" style={{ padding: "0 8px 6px" }}>{conversation.description}</p>}
        {isAdmin && (
          <button className="side-row is-button" onClick={() => setOverlay({ type: "channel", channelId: conversation.groupId! })}>
            <Pencil size={17} />
            <span className="grow">{t("channels.edit")}</span>
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
            {conversation.muted ? t("details.channel.unmute") : t("details.channel.mute")}
            <span className="side-row-hint">{conversation.muted ? t("details.channel.mutedHint") : t("details.channel.unmutedHint")}</span>
          </span>
        </button>
        {muteMenu && <PopupMenu x={muteMenu.x} y={muteMenu.y} alignRight entries={muteEntries((until) => void session().mute(conversation.key, until))} onClose={() => setMuteMenu(null)} />}
      </div>
      <SharedMediaRows conversation={conversation} />
      <div className="side-section">
        <div className="side-row">
          <Lock size={17} />
          <span className="grow">
            {t("details.channel.encrypted")}
            <span className="side-row-hint">{adminOnly ? t("details.channel.adminsRead") : t("details.channel.everyoneReads")}</span>
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
              <button className="avatar-edit-button" onClick={() => avatarInput.current?.click()} aria-label={t("details.group.changePicture")}>
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
            <Field label={t("details.group.name")} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoFocus />
            <Field label={t("details.group.description")} value={description} maxLength={300} onChange={(event) => setDescription(event.target.value)} />
            <div className="row">
              <button className="btn btn-small grow" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
              <button className="btn btn-small btn-primary grow" onClick={saveDetails}>{t("common.save")}</button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="row" style={{ gap: 6 }}>
              {conversation.title}
              {isAdmin && (
                <button className="icon-btn is-small" onClick={() => setEditing(true)} aria-label={t("details.group.edit")}>
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
        <span>{t("details.group.serverSees")}</span>
      </div>

      <SharedMediaRows conversation={conversation} />

      <div className="side-section">
        <h4 className="row" style={{ justifyContent: "space-between" }}>
          {t("details.group.members", { count: conversation.members.length })}
          {isAdmin && (
            <Tooltip text={t("details.group.addPeople")}>
              <button className="icon-btn is-small" onClick={() => setOverlay({ type: "add-members", groupId })} aria-label={t("details.group.addPeople")}>
                <UserPlus size={15} />
              </button>
            </Tooltip>
          )}
        </h4>
        {members.map((member) => {
          const user = server?.users[member.userId];
          const name = user?.displayName ?? t("chat.unknown");
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
                  {user?.bot && <> <BotBadge /></>}
                  {member.userId === selfId && <span className="faint"> {t("details.group.you")}</span>}
                </span>
                <span className="faint truncate" style={{ display: "block", fontSize: 12 }}>
                  {member.notOnRoster ? t("details.group.notOnRoster") : member.noKeys ? t("details.group.noKeys") : `@${user?.username}`}
                </span>
              </span>
              {member.notOnRoster && <ShieldAlert size={14} className="conv-warning" aria-label={t("details.group.notListed")} />}
              {member.role === "admin" && <Crown size={13} className="faint" aria-label={t("details.group.admin")} />}
              {user?.trust === "verified" && <BadgeCheck size={14} className="conv-verified" aria-label={t("details.encryption.verified")} />}
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
              {t("details.group.history")}
              <span className="side-hint">{t("details.group.historyHint")}</span>
            </span>
            <Switch
              on={conversation.historyVisible}
              onChange={(value) => void run(() => session().updateGroupMeta(groupId, {}, undefined, value))}
              label={t("details.group.history")}
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
          <span className="grow">{t("details.group.leave")}</span>
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
            <span className="grow">{t("details.group.delete")}</span>
          </button>
        )}
      </div>

      {memberMenu && (
        <PopupMenu
          x={memberMenu.x}
          y={memberMenu.y}
          onClose={() => setMemberMenu(null)}
          entries={[
            { label: t("channels.members.message"), icon: <Check size={15} />, onSelect: () => selectConversation(`user:${memberMenu.userId}`) },
            { label: t("details.member.verify"), icon: <Shield size={15} />, onSelect: () => setOverlay({ type: "verify", userId: memberMenu.userId }) },
            ...(memberMenu.userId !== selfId
              ? [
                  server?.prefs.blocked?.includes(memberMenu.userId)
                    ? { label: t("composer.disabled.unblock"), icon: <Ban size={15} />, onSelect: () => void run(() => session().setBlocked(memberMenu.userId, false)) }
                    : { label: t("details.member.block"), icon: <Ban size={15} />, onSelect: () => void run(() => session().setBlocked(memberMenu.userId, true)) },
                ]
              : []),
            ...(isAdmin
              ? [
                  {
                    label: conversation.members.find((item) => item.userId === memberMenu.userId)?.role === "admin" ? t("details.member.removeAdmin") : t("details.member.makeAdmin"),
                    icon: <Crown size={15} />,
                    onSelect: () => {
                      const role = conversation.members.find((item) => item.userId === memberMenu.userId)?.role === "admin" ? "member" : "admin";
                      void run(() => session().setGroupRole(groupId, memberMenu.userId, role));
                    },
                  },
                  { separator: true },
                  {
                    label: t("details.member.remove"),
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
          <span className="truncate" style={{ fontWeight: 600, fontSize: 13, color: nameColor(message.senderId) }}>{sender?.displayName ?? t("chat.unknown")}</span>
          <span className="faint" style={{ fontSize: 11 }} title={formatFull(message.createdAt)}>{formatListTime(message.createdAt)}</span>
        </span>
        <span className="result-text">{plainText(message.text) || message.attachments[0]?.name || t("message.reply.attachment")}</span>
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
  // From a key press until its results are in, so "No messages found" waits for them.
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!conversation.groupId || query.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const [found, indexed] = await Promise.all([session().search(query, conversation.groupId!), session().searchCoverage()]);
        if (!cancelled) {
          setResults(found);
          setCoverage(indexed);
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
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
        <input className="input" placeholder={t("details.search.placeholder")} value={query} autoFocus onChange={(event) => setQuery(event.target.value)} aria-label={t("details.search.placeholder")} />
      </div>
      {partial && <p className="faint" style={{ fontSize: 12 }}>{t("details.search.partial")}</p>}
      {query.trim().length >= 2 && results.length === 0 && !searching && <p className="muted" style={{ textAlign: "center", padding: 18 }}>{t("details.search.none")}</p>}
      {query.trim().length < 2 && (
        <p className="faint" style={{ fontSize: 12.5, textAlign: "center", padding: "18px 10px" }}>
          {t("details.search.private")}
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
          <p>{t("details.pins.empty")}</p>
        </div>
      )}
      {pins?.map((message) => (
        <ResultRow
          key={message.id}
          message={message}
          onOpen={() => void jump(message.groupId, message.id, message.seq)}
          action={
            <Tooltip text={t("message.action.unpin")}>
              <button
                className="icon-btn is-small"
                aria-label={t("message.action.unpin")}
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
