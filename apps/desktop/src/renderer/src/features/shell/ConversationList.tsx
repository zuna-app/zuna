import type { ConversationView, MessageView, SearchResult, UserView } from "@zuna/core";
import { plainText } from "@zuna/core/plain-text";
import {
  BadgeCheck,
  Bookmark,
  BellOff,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Link as LinkIcon,
  LogOut,
  Pin,
  PinOff,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  SquarePen,
  UsersRound,
  VolumeX,
  X,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Avatar, PopupMenu, Tooltip, useContextMenu, type MenuEntry } from "@/components/ui";
import { refocusComposer } from "@/lib/focus";
import { formatListTime } from "@/lib/format";
import { useActiveServer, useApp } from "@/state/store";

type Filter = "all" | "people" | "groups" | "unread";

function previewFor(message: MessageView | null, users: Record<string, UserView>, selfId: string, kind: string): string {
  if (!message) return "";
  if (message.system) return "Membership changed";
  if (message.status === "undecryptable") return "Waiting for keys";
  const author = message.senderId === selfId ? "You" : kind === "group" ? users[message.senderId]?.displayName.split(" ")[0] : null;
  const body = message.text
    ? plainText(message.text).slice(0, 80)
    : message.attachments[0]
      ? message.attachments[0].mime.startsWith("image/")
        ? "Photo"
        : message.attachments[0].mime.startsWith("video/")
          ? "Video"
          : message.attachments[0].name
      : "";
  return author ? `${author}: ${body}` : body;
}

const ConversationRow = memo(function ConversationRow({
  item,
  active,
  peer,
  typing,
  preview,
  isSaved,
  onSelect,
  onMenu,
}: {
  item: ConversationView;
  active: boolean;
  peer: UserView | null;
  typing: boolean;
  preview: string;
  isSaved: boolean;
  onSelect: (key: string) => void;
  onMenu: (event: React.MouseEvent, item: ConversationView) => void;
}) {
  const fallback = item.kind === "dm" && !isSaved && peer ? `@${peer.username}` : isSaved ? "Notes to yourself" : "";
  return (
    <button
      data-row-key={item.key}
      className={`conv-row${active ? " is-active" : ""}`}
      onClick={() => onSelect(item.key)}
      onContextMenu={(event) => onMenu(event, item)}
      aria-current={active}
    >
      {isSaved ? (
        <span className="avatar saved-avatar" style={{ width: 46, height: 46 }}>
          <Bookmark size={19} />
        </span>
      ) : (
        <Avatar name={item.title} seed={item.peerId ?? item.groupId ?? item.key} avatar={item.avatar} size={46} online={peer?.online} />
      )}
      <span className="conv-body">
        <span className="conv-line">
          <span className="conv-title truncate">
            {item.kind === "group" && <UsersRound size={13} className="conv-kind" />}
            <span className="truncate">{item.title}</span>
            {peer?.trust === "verified" && <BadgeCheck size={14} className="conv-verified" />}
            {peer?.trust === "changed" && <ShieldAlert size={14} className="conv-warning" />}
            {item.muted && <BellOff size={12} className="conv-muted" />}
          </span>
          <span className="conv-time">{formatListTime(item.lastMessage?.createdAt ?? 0)}</span>
        </span>
        <span className="conv-line">
          <span className={`conv-preview truncate${typing ? " is-typing" : ""}`}>
            {typing ? "typing…" : preview || <span className="faint">{fallback}</span>}
          </span>
          {item.pinned && !item.unread && <Pin size={13} className="conv-pin" />}
          {item.unread > 0 && <span className={`conv-badge${item.muted ? " is-muted" : ""}`}>{item.unread > 99 ? "99+" : item.unread}</span>}
        </span>
      </span>
    </button>
  );
});

/** Slides rows to their new places when the order changes, by measuring before and after. */
function useRowReorderAnimation(container: React.RefObject<HTMLDivElement | null>, order: string) {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const next = new Map<string, number>();
    const animate = document.documentElement.dataset.motion !== "reduced";
    const top = root.scrollTop;
    const bottom = top + root.clientHeight;
    for (const row of root.querySelectorAll<HTMLElement>("[data-row-key]")) {
      const position = row.offsetTop;
      next.set(row.dataset.rowKey!, position);
      const previous = positions.current.get(row.dataset.rowKey!);
      if (!animate || previous === undefined || previous === position) continue;
      if (position + row.offsetHeight < top || position > bottom) continue;
      const distance = Math.max(-120, Math.min(120, previous - position));
      row.animate([{ transform: `translateY(${distance}px)` }, { transform: "none" }], { duration: 140, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    }
    positions.current = next;
  }, [order]);
}

export function ConversationList() {
  const server = useActiveServer();
  const selectConversation = useApp((state) => state.selectConversation);
  const setOverlay = useApp((state) => state.setOverlay);
  const session = useApp((state) => state.session);
  const jumpToMessage = useApp((state) => state.jumpToMessage);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const rowMenu = useContextMenu();
  const [menuItem, setMenuItem] = useState<ConversationView | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const conversations = server?.conversations ?? [];
  const users = server?.users ?? {};
  const selfId = server?.self?.userId ?? "";
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";

  // Message search runs against the encrypted index on this device.
  const [messageHits, setMessageHits] = useState<SearchResult[]>([]);
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2 || !server) {
      setMessageHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void session()
        .search(needle, undefined, 30)
        .then((hits) => {
          if (!cancelled) setMessageHits(hits);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, server?.entry.id, session]);

  const { visible, hidden } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (item: ConversationView) => {
      if (needle) {
        const username = item.peerId ? users[item.peerId]?.username.toLowerCase() : "";
        if (!item.title.toLowerCase().includes(needle) && !username?.includes(needle)) return false;
      }
      if (filter === "people") return item.kind === "dm";
      if (filter === "groups") return item.kind === "group";
      if (filter === "unread") return item.unread > 0;
      return true;
    };
    const filtered = conversations.filter(matches);
    // Searching looks through hidden conversations too, so nothing gets lost.
    return {
      visible: needle ? filtered : filtered.filter((item) => !item.hidden),
      hidden: needle ? [] : filtered.filter((item) => item.hidden),
    };
  }, [conversations, query, filter, users]);

  useRowReorderAnimation(listRef, visible.map((item) => item.key).join("|"));

  if (!server) return null;

  const toggle = (list: "pinned" | "hidden" | "muted", key: string) => {
    const current = server.prefs[list];
    void session().updatePreferences({
      [list]: current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    });
  };

  const rowEntries = (item: ConversationView): MenuEntry[] => [
    {
      label: item.pinned ? "Unpin" : "Pin to top",
      icon: item.pinned ? <PinOff size={15} /> : <Pin size={15} />,
      onSelect: () => toggle("pinned", item.key),
    },
    {
      label: item.muted ? "Unmute" : "Mute",
      icon: <VolumeX size={15} />,
      onSelect: () => toggle("muted", item.key),
    },
    {
      label: item.hidden ? "Show in list" : "Hide from list",
      icon: item.hidden ? <Eye size={15} /> : <EyeOff size={15} />,
      onSelect: () => toggle("hidden", item.key),
    },
  ];

  const headerEntries: MenuEntry[] = [
    { label: "Invite people", icon: <LinkIcon size={15} />, onSelect: () => setOverlay({ type: "invite" }) },
    { label: "New group", icon: <UsersRound size={15} />, onSelect: () => setOverlay({ type: "new-group" }) },
    ...(isAdmin ? [{ label: "Server settings", icon: <SettingsIcon size={15} />, onSelect: () => setOverlay({ type: "server-settings" }) }] : []),
    { separator: true },
    {
      label: "Leave this server",
      icon: <LogOut size={15} />,
      danger: true,
      onSelect: () => setOverlay({ type: "server-settings", section: "leave" }),
    },
  ];

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "people", label: "People" },
    { id: "groups", label: "Groups" },
    { id: "unread", label: "Unread" },
  ];

  const renderRow = (item: ConversationView) => (
    <ConversationRow
      key={item.key}
      item={item}
      active={server.activeKey === item.key}
      peer={item.peerId ? (users[item.peerId] ?? null) : null}
      typing={!!item.groupId && Object.keys(server.typing[item.groupId] ?? {}).length > 0}
      preview={previewFor(item.lastMessage, users, selfId, item.kind)}
      isSaved={item.peerId === selfId}
      onSelect={selectConversation}
      onMenu={(event, target) => {
        setMenuItem(target);
        rowMenu.open(event);
      }}
    />
  );

  return (
    <>
      <header className="sidebar-head">
        <button
          className="server-title"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHeaderMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <span className="truncate">{server.entry.name}</span>
          <ChevronDown size={15} />
        </button>
        <Tooltip text="New group">
          <button className="icon-btn" onClick={() => setOverlay({ type: "new-group" })} aria-label="New group">
            <SquarePen size={17} />
          </button>
        </Tooltip>
      </header>

      <div className="sidebar-search">
        <div className="input-wrap search-wrap">
          <Search size={14} className="faint" />
          <input
            id="conversation-search"
            className="input"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
                refocusComposer();
              }
            }}
            aria-label="Search people, groups and messages"
          />
          {query && (
            <button className="icon-btn is-small" onClick={() => setQuery("")} aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="filter-tabs" role="tablist">
        {filters.map((item) => (
          <button key={item.id} role="tab" aria-selected={filter === item.id} className={`filter-tab${filter === item.id ? " is-active" : ""}`} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      <div className="conv-list" ref={listRef}>
        {visible.map(renderRow)}
        {messageHits.length > 0 && (
          <div className="message-hits">
            <h4>Messages</h4>
            {messageHits.map((hit) => {
              const conversation = conversations.find((item) => item.key === hit.conversationKey);
              const sender = users[hit.message.senderId];
              return (
                <button
                  key={hit.message.id}
                  className="hit-row"
                  onClick={() => {
                    selectConversation(hit.conversationKey);
                    setTimeout(() => void jumpToMessage(hit.message.groupId, hit.message.id, hit.message.seq), 60);
                  }}
                >
                  <Avatar name={sender?.displayName ?? "?"} seed={hit.message.senderId} avatar={sender?.avatar} size={36} />
                  <span className="conv-body">
                    <span className="conv-line">
                      <span className="conv-title truncate">{conversation?.title ?? "Conversation"}</span>
                      <span className="conv-time">{formatListTime(hit.message.createdAt)}</span>
                    </span>
                    <span className="conv-preview truncate">{plainText(hit.message.text)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {visible.length === 0 && hidden.length === 0 && messageHits.length === 0 && (
          <div className="empty-state" style={{ padding: "32px 20px" }}>
            <p>{query ? "Nothing matches that search." : filter === "unread" ? "You're all caught up." : filter === "groups" ? "No groups yet." : "It's quiet here."}</p>
            {!query && filter !== "unread" && (
              <button className="btn btn-small" onClick={() => setOverlay({ type: filter === "groups" ? "new-group" : "invite" })}>
                {filter === "groups" ? "Create a group" : "Invite people"}
              </button>
            )}
          </div>
        )}
        {hidden.length > 0 && (
          <div className="hidden-section">
            <button className={`hidden-toggle${showHidden ? " is-open" : ""}`} onClick={() => setShowHidden(!showHidden)}>
              <ChevronRight size={14} />
              Hidden ({hidden.length})
            </button>
            {showHidden && hidden.map(renderRow)}
          </div>
        )}
      </div>

      <AnimatePresence>
        {headerMenu && <PopupMenu key="server-menu" x={headerMenu.x} y={headerMenu.y} entries={headerEntries} onClose={() => setHeaderMenu(null)} />}
        {rowMenu.menu && menuItem && <PopupMenu key="row-menu" x={rowMenu.menu.x} y={rowMenu.menu.y} entries={rowEntries(menuItem)} onClose={rowMenu.close} />}
      </AnimatePresence>
    </>
  );
}
