import type { Invite, UserView } from "@zuna/core";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Copy,
  Link as LinkIcon,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar, Field, Modal, Spinner, Switch, useAction, useReturnFocus } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatUpcoming } from "@/lib/format";
import { useActiveServer, useApp } from "@/state/store";
import { JoinFlow } from "@/features/onboarding/Onboarding";
import { ServerSettings } from "./ServerSettings";
import { Settings } from "./Settings";

export function Overlays() {
  const overlay = useApp((state) => state.overlay);
  const setOverlay = useApp((state) => state.setOverlay);
  const close = () => setOverlay(null);
  return (
    <AnimatePresence>
      {overlay?.type === "add-server" && (
        <Modal key="add-server" onClose={close} width={420} bare>
          <div className="modal-flow">
            <button className="icon-btn is-small modal-close" onClick={close} aria-label="Close">
              <X size={17} />
            </button>
            <JoinFlow initialLink={overlay.link} initialSignInUrl={overlay.signInUrl} onDone={close} embedded />
          </div>
        </Modal>
      )}
      {overlay?.type === "settings" && <Settings key="settings" initialSection={overlay.section} onClose={close} />}
      {overlay?.type === "server-settings" && <ServerSettings key="server-settings" initialSection={overlay.section} onClose={close} />}
      {overlay?.type === "new-group" && <NewGroup key="new-group" onClose={close} />}
      {overlay?.type === "invite" && <InvitePeople key="invite" onClose={close} />}
      {overlay?.type === "verify" && <VerifyIdentity key="verify" userId={overlay.userId} onClose={close} />}
      {overlay?.type === "add-members" && <AddMembers key="add-members" groupId={overlay.groupId} onClose={close} />}
      {overlay?.type === "image" && <ImageViewer key="image" url={overlay.url} name={overlay.name} onClose={close} />}
      {overlay?.type === "forward" && <ForwardPicker key="forward" serverId={overlay.serverId} groupId={overlay.groupId} ids={overlay.ids} onClose={close} />}
    </AnimatePresence>
  );
}

const MAX_ZOOM = 8;

interface View {
  scale: number;
  /** Where the picture's center is, from the middle of the window. */
  x: number;
  y: number;
}

const FITTED: View = { scale: 1, x: 0, y: 0 };

/** A mouse wheel moves in steps; a trackpad scrolls smoothly, and pans instead. */
const isMouseWheel = (event: WheelEvent) => event.deltaX === 0 && event.deltaY !== 0 && Math.abs((event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 1) % 120 === 0;

/**
 * A picture, fitted to the window. It zooms with a pinch, the mouse wheel, a
 * double click or the buttons, towards where the pointer is, and once it's
 * bigger than the window it can be dragged and scrolled around.
 */
function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useReturnFocus();
  const [view, setView] = useState<View>(FITTED);
  const [dragging, setDragging] = useState(false);
  // Steps glide; pinching, scrolling and dragging follow the fingers exactly.
  const [gliding, setGliding] = useState(true);
  // How big the fitted picture is next to its own size, for the zoom shown.
  const [fitted, setFitted] = useState(1);
  const measure = () => {
    const element = image.current;
    if (element?.naturalWidth) setFitted(element.offsetWidth / element.naturalWidth);
  };
  const image = useRef<HTMLImageElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  // Wheel and pointer events can come faster than the view is drawn, so each builds on the last.
  const latest = useRef<View>(FITTED);
  const drag = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null);

  // The picture can't be moved further than its edges reach past the window.
  const show = useCallback((next: View, glide = true) => {
    const element = image.current;
    const scale = Math.min(MAX_ZOOM, Math.max(1, next.scale));
    let limited = FITTED;
    if (element && scale > 1) {
      const spareX = Math.max(0, (element.offsetWidth * scale - window.innerWidth) / 2);
      const spareY = Math.max(0, (element.offsetHeight * scale - window.innerHeight) / 2);
      limited = { scale, x: Math.min(spareX, Math.max(-spareX, next.x)), y: Math.min(spareY, Math.max(-spareY, next.y)) };
    }
    latest.current = limited;
    setView(limited);
    setGliding(glide);
  }, []);

  // The point under the pointer stays where it is.
  const zoomTo = useCallback(
    (scale: number, clientX = window.innerWidth / 2, clientY = window.innerHeight / 2, glide = true) => {
      const current = latest.current;
      const target = Math.min(MAX_ZOOM, Math.max(1, scale));
      const pointX = clientX - window.innerWidth / 2;
      const pointY = clientY - window.innerHeight / 2;
      const ratio = target / current.scale;
      show({ scale: target, x: pointX - (pointX - current.x) * ratio, y: pointY - (pointY - current.y) * ratio }, glide);
    },
    [show],
  );

  // Double clicking shows the picture at its own size, or twice as big if it already fits.
  const closerScale = () => {
    const element = image.current;
    if (!element?.offsetWidth) return 2;
    return Math.max(2, Math.min(MAX_ZOOM, element.naturalWidth / element.offsetWidth));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") zoomTo(latest.current.scale * 1.5);
      else if (event.key === "-") zoomTo(latest.current.scale / 1.5);
      else if (event.key === "0") show(FITTED);
    };
    const onResize = () => {
      measure();
      show(latest.current, false);
    };
    // Handled here rather than through React, whose wheel events can't stop the page from scrolling.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = latest.current;
      if (event.ctrlKey || event.metaKey || isMouseWheel(event)) {
        // A pinch comes as small steps with ctrlKey set, a mouse wheel as big ones.
        const pinch = event.ctrlKey && !isMouseWheel(event);
        zoomTo(current.scale * (pinch ? Math.exp(-event.deltaY / 100) : event.deltaY < 0 ? 1.25 : 0.8), event.clientX, event.clientY, !pinch);
      } else {
        show({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }, false);
      }
    };
    const element = viewer.current!;
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      element.removeEventListener("wheel", onWheel);
    };
  }, [onClose, zoomTo, show]);

  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  const zoomed = view.scale > 1;
  return createPortal(
    <div
      ref={viewer}
      className={`image-viewer${zoomed ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img
        ref={image}
        src={url}
        alt={name}
        draggable={false}
        onLoad={measure}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transition: gliding ? undefined : "none" }}
        onDoubleClick={(event) => (zoomed ? show(FITTED) : zoomTo(closerScale(), event.clientX, event.clientY))}
        onPointerDown={(event) => {
          if (!zoomed || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerX: event.clientX, pointerY: event.clientY, x: view.x, y: view.y };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start) show({ ...latest.current, x: start.x + event.clientX - start.pointerX, y: start.y + event.clientY - start.pointerY }, false);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <div className="image-tools" onClick={(event) => event.stopPropagation()}>
        <button className="icon-btn" onClick={() => zoomTo(view.scale / 1.5)} disabled={!zoomed} aria-label="Zoom out">
          <ZoomOut size={17} />
        </button>
        <button className="image-zoom" onClick={() => show(FITTED)} disabled={!zoomed} aria-label="Fit to the window">
          {Math.round(view.scale * fitted * 100)}%
        </button>
        <button className="icon-btn" onClick={() => zoomTo(view.scale * 1.5)} disabled={view.scale >= MAX_ZOOM} aria-label="Zoom in">
          <ZoomIn size={17} />
        </button>
        <a className="btn image-save" href={url} download={name}>
          Save
        </a>
      </div>
      <button className="icon-btn image-close" onClick={onClose} aria-label="Close">
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}

/**
 * Where to forward a message: any chat on any server, this one first. Picking
 * one sends it there and opens it, as Telegram's desktop app does.
 */
function ForwardPicker({ serverId, groupId, ids, onClose }: { serverId: string; groupId: string; ids: string[]; onClose: () => void }) {
  const servers = useApp((state) => state.servers);
  const order = useApp((state) => state.order);
  const toast = useApp((state) => state.toast);
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const sections = [serverId, ...order.filter((id) => id !== serverId)]
    .map((id) => servers[id])
    .filter((server): server is NonNullable<typeof server> => !!server)
    .map((server) => ({
      server,
      chats: server.conversations.filter((chat) => !server.prefs.hidden.includes(chat.key) && (!needle || chat.title.toLowerCase().includes(needle))),
    }))
    .filter((section) => section.chats.length > 0);

  const forward = async (toServerId: string, key: string) => {
    setSending(`${toServerId}/${key}`);
    try {
      await useApp.getState().core!.client.forwardMessages(serverId, groupId, ids, toServerId, key);
      const state = useApp.getState();
      state.toggleSelected("", null);
      if (state.activeServerId !== toServerId) state.selectServer(toServerId);
      useApp.getState().selectConversation(key);
      onClose();
    } catch (error) {
      toast((error as Error).message, "error");
      setSending(null);
    }
  };

  return (
    <Modal title="Forward to" onClose={onClose}>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder="Search chats" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} aria-label="Search chats" />
      </div>
      <div className="people-list forward-list">
        {sections.map(({ server, chats }) => (
          <div key={server.entry.id} className="forward-section">
            {sections.length > 1 || server.entry.id !== serverId ? <span className="forward-server">{server.entry.name}</span> : null}
            {chats.map((chat) => {
              const id = `${server.entry.id}/${chat.key}`;
              return (
                <button key={id} className="person-row" disabled={sending !== null} onClick={() => void forward(server.entry.id, chat.key)}>
                  <Avatar name={chat.title} seed={chat.peerId ?? chat.groupId ?? chat.key} avatar={chat.avatar} size={36} />
                  <span className="grow truncate" style={{ fontWeight: 550 }}>{chat.title}</span>
                  {sending === id && <Spinner size={14} />}
                </button>
              );
            })}
          </div>
        ))}
        {sections.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 16 }}>No chats match that search.</p>}
      </div>
    </Modal>
  );
}

function PeoplePicker({ users, selected, onToggle }: { users: UserView[]; selected: Set<string>; onToggle: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => users.filter((user) => !needle || user.displayName.toLowerCase().includes(needle) || user.username.toLowerCase().includes(needle)),
    [users, needle],
  );
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder="Search people" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search people" />
      </div>
      <div className="people-list">
        {filtered.map((user) => (
          <button key={user.id} className={`person-row${selected.has(user.id) ? " is-selected" : ""}`} onClick={() => onToggle(user.id)} role="checkbox" aria-checked={selected.has(user.id)}>
            <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={36} online={user.online} />
            <span className="grow">
              <span className="truncate" style={{ display: "block", fontWeight: 550 }}>{user.displayName}</span>
              <span className="faint truncate" style={{ display: "block", fontSize: 12 }}>@{user.username}</span>
            </span>
            <span className="person-check">{selected.has(user.id) && <Check size={13} strokeWidth={3} />}</span>
          </button>
        ))}
        {filtered.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 16 }}>Nobody matches that search.</p>}
      </div>
    </div>
  );
}

function NewGroup({ onClose }: { onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const selectConversation = useApp((state) => state.selectConversation);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [history, setHistory] = useState(false);
  const { busy, run } = useAction();
  const selfId = server?.self?.userId;
  const users = Object.values(server?.users ?? {})
    .filter((user) => user.id !== selfId && !user.banned)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const create = () =>
    run(async () => {
      const groupId = await session().createGroup(name.trim(), [...selected], history);
      selectConversation(`group:${groupId}`);
      onClose();
    });

  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? <Spinner /> : `Create${selected.size ? ` with ${selected.size + 1} people` : ""}`}
          </button>
        </>
      }
    >
      <Field label="Group name" placeholder="Weekend trip" value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} />
      <div className="field">
        <span className="field-label">Invite people</span>
        <PeoplePicker
          users={users}
          selected={selected}
          onToggle={(id) => {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelected(next);
          }}
        />
      </div>
      <div className="setting-row">
        <span className="grow">
          <b>New members can read earlier messages</b>
          <span className="setting-hint">If off, people only see what's sent after they join.</span>
        </span>
        <Switch on={history} onChange={setHistory} label="New members can read earlier messages" />
      </div>
    </Modal>
  );
}

function AddMembers({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const [selected, setSelected] = useState(new Set<string>());
  const { busy, run } = useAction();
  const conversation = server?.conversations.find((item) => item.groupId === groupId);
  const memberIds = new Set(conversation?.members.map((member) => member.userId));
  const users = Object.values(server?.users ?? {})
    .filter((user) => !memberIds.has(user.id) && !user.banned)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <Modal
      title="Add people"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={selected.size === 0 || busy}
            onClick={() =>
              run(async () => {
                await session().addMembers(groupId, [...selected]);
                onClose();
              })
            }
          >
            {busy ? <Spinner /> : "Add"}
          </button>
        </>
      }
    >
      {conversation?.historyVisible && (
        <div className="notice">
          <UsersRound size={15} />
          <span>This group shares its history, so they'll be able to read earlier messages.</span>
        </div>
      )}
      {users.length === 0 ? (
        <p className="muted" style={{ textAlign: "center", padding: 16 }}>Everyone on this server is already here.</p>
      ) : (
        <PeoplePicker
          users={users}
          selected={selected}
          onToggle={(id) => {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelected(next);
          }}
        />
      )}
    </Modal>
  );
}

const EXPIRY_OPTIONS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
  { label: "Never", seconds: 0 },
];
const USE_OPTIONS = [
  { label: "1 use", value: 1 },
  { label: "5 uses", value: 5 },
  { label: "25 uses", value: 25 },
  { label: "No limit", value: 0 },
];

export function InvitePanel() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const { busy, run } = useAction();
  const [expiry, setExpiry] = useState(EXPIRY_OPTIONS[1]!.seconds);
  const [uses, setUses] = useState(USE_OPTIONS[3]!.value);
  const [link, setLink] = useState<string | null>(null);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const canManage = server?.self?.role !== "member" || server?.info?.allow_member_invites;

  const refresh = () => {
    if (!canManage) return;
    void session().invites().then(setInvites).catch(() => setInvites([]));
  };
  useEffect(refresh, [canManage, session]);

  const copy = async (value: string) => {
    await copyText(value);
    toast("Invite link copied");
  };

  if (!canManage) {
    return (
      <div className="notice">
        <LinkIcon size={15} />
        <span>On this server, only admins can create invite links. Ask one of them for a link.</span>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="field grow">
          <span className="field-label">Expires after</span>
          <select className="select" value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
            {EXPIRY_OPTIONS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
          </select>
        </div>
        <div className="field grow">
          <span className="field-label">Can be used</span>
          <select className="select" value={uses} onChange={(event) => setUses(Number(event.target.value))}>
            {USE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const created = await session().createInvite(uses, expiry);
            setLink(created);
            await copy(created).catch(() => undefined);
            refresh();
          })
        }
      >
        {busy ? <Spinner /> : <><LinkIcon size={15} /> Create invite link</>}
      </button>
      {link && (
        <div className="invite-link">
          <span className="mono truncate selectable">{link}</span>
          <button className="icon-btn is-small" onClick={() => copy(link)} aria-label="Copy link">
            <Copy size={14} />
          </button>
        </div>
      )}
      {invites && invites.length > 0 && (
        <div className="field">
          <span className="field-label">Active links</span>
          <div className="invite-list">
            {invites.map((invite) => (
              <div key={invite.code} className="invite-row">
                <span className="grow">
                  <span className="mono" style={{ fontSize: 12.5 }}>{invite.code}</span>
                  <span className="faint" style={{ display: "block", fontSize: 11.5 }}>
                    {invite.uses} used{invite.max_uses ? ` of ${invite.max_uses}` : ""}
                    {invite.expires_at ? ` · expires ${formatUpcoming(invite.expires_at)}` : ""}
                  </span>
                </span>
                <button
                  className="icon-btn is-small"
                  aria-label="Copy link"
                  onClick={() => void session().linkForInvite(invite.code).then(copy)}
                >
                  <Copy size={14} />
                </button>
                <button
                  className="icon-btn is-small"
                  aria-label="Revoke link"
                  onClick={() => run(async () => {
                    await session().revokeInvite(invite.code);
                    refresh();
                  })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InvitePeople({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Invite people" onClose={onClose}>
      <p className="muted" style={{ fontSize: 13.5 }}>
        Anyone with a link can create an account here. It also holds the key that protects member profiles, so only share it with people you trust.
      </p>
      <InvitePanel />
    </Modal>
  );
}

function VerifyIdentity({ userId, onClose }: { userId: string; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const { run } = useAction();
  const [check, setCheck] = useState<Awaited<ReturnType<ReturnType<typeof session>["safetyCheck"]>>>(null);
  const user = server?.users[userId];

  useEffect(() => {
    void session().safetyCheck(userId).then(setCheck);
  }, [userId, session, user?.trust]);

  if (!user) return null;
  const isSelf = userId === server?.self?.userId;
  const trust = check?.trust ?? user.trust;

  return (
    <Modal title={isSelf ? "Your security key" : `Verify ${user.displayName} (@${user.username})`} onClose={onClose} width={460}>
      {trust === "changed" && (
        <div className="notice is-danger">
          <ShieldAlert size={16} />
          <span>
            <b>{user.displayName}'s security key changed</b> in a way that doesn't follow from the one before, so this may mean someone is intercepting your messages. Only continue after comparing these emoji with them directly.
          </span>
        </div>
      )}
      {trust === "verified" && (
        <div className="notice">
          <ShieldCheck size={16} />
          <span>You've verified {user.displayName}. Nobody can quietly get between you.</span>
        </div>
      )}
      {trust === "unverified" && (
        <p className="muted" style={{ fontSize: 13.5 }}>
          Compare these emoji with {user.displayName} in person or on a call. If they match exactly, nobody, including this server, is reading your conversation.
        </p>
      )}
      <div className="safety-grid">
        {check?.emoji.map((item, index) => (
          <div className="safety-cell" key={index}>
            <span className="safety-emoji">{item.emoji}</span>
            <span className="safety-name">{item.name}</span>
          </div>
        ))}
      </div>
      {!isSelf && (
        <div className="row">
          {trust === "verified" ? (
            <button className="btn grow" onClick={() => run(async () => { await session().clearVerification(userId); })}>
              Remove verification
            </button>
          ) : (
            <>
              <button
                className="btn grow"
                onClick={() => {
                  toast("If they see 12 emoji, their app needs updating. Otherwise, don't share anything private with them until you know why the emoji differ.", "security");
                  onClose();
                }}
              >
                <AlertTriangle size={15} /> They don't match
              </button>
              <button
                className="btn btn-primary grow"
                disabled={!check}
                onClick={() =>
                  run(async () => {
                    if (!check) return;
                    try {
                      await session().markVerified(userId, check.covers);
                    } catch (error) {
                      // Whatever changed, these are no longer the emoji to compare.
                      void session().safetyCheck(userId).then(setCheck);
                      throw error;
                    }
                    toast(`${user.displayName} is verified`);
                    onClose();
                  })
                }
              >
                <BadgeCheck size={16} /> They match
              </button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
