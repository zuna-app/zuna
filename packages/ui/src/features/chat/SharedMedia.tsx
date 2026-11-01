import type { Attachment, ConversationView, MediaCounts, MediaKind, MessageView } from "@zuna/core";
import { linkHost, sharedLinks } from "@zuna/core/links";
import { attachmentKind } from "@zuna/core/media";
import { plainText } from "@zuna/core/plain-text";
import { AlertCircle, Download, File as FileIcon, Headphones, Image as ImageIcon, Link2, MessageSquare, Mic, Play, Users, Video, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, PopupMenu, Spinner } from "@/components/ui";
import { avatarColor, formatDuration, formatFull, nameColor } from "@/lib/format";
import { loadsByItself, useDecryptedUrl } from "@/lib/media";
import { useActiveServer, useApp } from "@/state/store";
import { AudioAttachment, FileAttachment, VoiceAttachment } from "./MessageItem";

/** What a chat's details list, in Telegram's order. GIFs aren't a kind of their own here. */
export type SharedKind = MediaKind | "groups";

const KINDS: { kind: SharedKind; icon: LucideIcon; one: string; many: string; title: string }[] = [
  { kind: "photo", icon: ImageIcon, one: "photo", many: "photos", title: "Photos" },
  { kind: "video", icon: Video, one: "video", many: "videos", title: "Videos" },
  { kind: "file", icon: FileIcon, one: "file", many: "files", title: "Files" },
  { kind: "audio", icon: Headphones, one: "audio file", many: "audio files", title: "Audio files" },
  { kind: "link", icon: Link2, one: "shared link", many: "shared links", title: "Shared links" },
  { kind: "voice", icon: Mic, one: "voice message", many: "voice messages", title: "Voice messages" },
  { kind: "groups", icon: Users, one: "group in common", many: "groups in common", title: "Groups in common" },
];

export const sharedTitle = (kind: SharedKind) => KINDS.find((item) => item.kind === kind)!.title;

/** The groups this person and this account are both in. */
function useGroupsInCommon(peerId: string | null): ConversationView[] {
  const server = useActiveServer();
  if (!peerId || !server || peerId === server.self?.userId) return [];
  return server.conversations.filter(
    (item) => item.kind === "group" && !item.removed && item.members.some((member) => member.userId === peerId && !member.notOnRoster),
  );
}

/** A new value whenever the chat's messages may have changed: those loaded in it, or its last activity. */
function useChatChanged(conversation: ConversationView): object {
  const items = useApp((state) => (conversation.groupId ? state.lists[conversation.groupId]?.items : undefined));
  return useMemo(() => ({}), [items, conversation.lastActivityAt]);
}

/** How many photos, files, links and so on are in a chat, one row each, as in Telegram's details. */
export function SharedMediaRows({ conversation }: { conversation: ConversationView }) {
  const session = useApp((state) => state.session);
  const setPanel = useApp((state) => state.setPanel);
  const groups = useGroupsInCommon(conversation.kind === "group" ? null : conversation.peerId);
  const [counts, setCounts] = useState<MediaCounts | null>(null);
  const changed = useChatChanged(conversation);
  const groupId = conversation.groupId;

  useEffect(() => {
    if (!groupId) {
      setCounts(null);
      return;
    }
    let cancelled = false;
    // New messages come in bursts as history arrives, so counting again waits for a quiet moment.
    const timer = setTimeout(
      () => {
        void session()
          .mediaCounts(groupId)
          .then((found) => !cancelled && setCounts(found))
          .catch(() => undefined);
      },
      counts ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, session, changed]);

  // All the rows at once, rather than the groups in common before the counts.
  if (groupId && !counts) return null;
  const rows = KINDS.map((item) => ({ ...item, count: item.kind === "groups" ? groups.length : (counts?.[item.kind] ?? 0) })).filter((item) => item.count > 0);
  if (rows.length === 0) return null;
  return (
    <div className="side-section">
      {rows.map(({ kind, icon: Icon, one, many, count }) => (
        <button key={kind} className="side-row is-button" onClick={() => setPanel({ type: "media", kind })}>
          <Icon size={17} />
          <span className="grow">
            {count} {count === 1 ? one : many}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One kind of thing from a chat, newest first, more of it as it's scrolled. */
export function SharedMediaContent({ conversation, kind }: { conversation: ConversationView; kind: SharedKind }) {
  if (kind === "groups") return <GroupsInCommon conversation={conversation} />;
  if (!conversation.groupId) {
    return (
      <div className="side-body">
        <Nothing />
      </div>
    );
  }
  return <SharedMessages conversation={conversation} groupId={conversation.groupId} kind={kind} />;
}

function Nothing() {
  return (
    <div className="empty-state">
      <p>Nothing here anymore.</p>
    </div>
  );
}

function SharedMessages({ conversation, groupId, kind }: { conversation: ConversationView; groupId: string; kind: MediaKind }) {
  const session = useApp((state) => state.session);
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const loadingMore = useRef(false);
  const shown = useRef(0);
  const changed = useChatChanged(conversation);

  // When the chat changes, everything shown so far is read again, so deletions and edits show.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void session()
          .loadMedia(groupId, kind, undefined, Math.max(PAGE, shown.current))
          .then((page) => {
            if (cancelled) return;
            shown.current = page.messages.length;
            setMessages(page.messages);
            setHasMore(page.hasMore);
          })
          .catch(() => !cancelled && setMessages((current) => current ?? []));
      },
      shown.current ? 150 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [groupId, kind, session, changed]);

  const loadMore = async () => {
    const oldest = messages?.at(-1)?.seq;
    if (loadingMore.current || !hasMore || oldest == null) return;
    loadingMore.current = true;
    try {
      const page = await session().loadMedia(groupId, kind, oldest);
      setMessages((current) => {
        const have = new Set(current?.map((message) => message.id));
        const next = [...(current ?? []), ...page.messages.filter((message) => !have.has(message.id))];
        shown.current = next.length;
        return next;
      });
      setHasMore(page.hasMore);
    } finally {
      loadingMore.current = false;
    }
  };

  if (!messages) return <div className="side-body" />;
  if (messages.length === 0) {
    return (
      <div className="side-body">
        <Nothing />
      </div>
    );
  }
  return (
    <div className="side-body">
      {kind === "photo" || kind === "video" ? (
        <div className="shared-grid">
          {messages.flatMap((message) =>
            message.attachments
              .filter((attachment) => attachmentKind(attachment) === kind)
              .map((attachment, index) => <MediaTile key={`${message.id}/${index}`} message={message} attachment={attachment} video={kind === "video"} />),
          )}
        </div>
      ) : (
        <div className="shared-list">
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {(index === 0 || monthOf(messages[index - 1]!.createdAt) !== monthOf(message.createdAt)) && <h4 className="shared-month">{monthOf(message.createdAt)}</h4>}
              {kind === "link" ? <LinkRow message={message} /> : <AttachmentRows message={message} kind={kind} />}
            </Fragment>
          ))}
        </div>
      )}
      {/* Made anew for each page, so it asks again if it's still in view. */}
      {hasMore && <LoadMore key={messages.length} onVisible={loadMore} />}
    </div>
  );
}

const PAGE = 50;

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const monthOf = (at: number) => monthFormat.format(at);

/** Asks for more once it's scrolled into view. */
function LoadMore({ onVisible }: { onVisible: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void latest.current();
      },
      { rootMargin: "300px" },
    );
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="shared-more">
      <Spinner size={16} delayed />
    </div>
  );
}

/** Whether an element has been on screen, so what's in it loads only once someone could see it. */
function useSeen(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

/** "Show in chat" on a right click, for anything listed. */
function useShowInChat(message: MessageView) {
  const jump = useApp((state) => state.jumpToMessage);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const show = () => void jump(message.groupId, message.id, message.seq);
  return {
    show,
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY });
    },
    menu: menu && (
      <PopupMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} entries={[{ label: "Show in chat", icon: <MessageSquare size={15} />, onSelect: show }]} />
    ),
  };
}

/**
 * A photo or a video, as a square. A photo opens in the viewer, loading first if
 * it's one too big to load by itself; a video plays where it was sent.
 */
function MediaTile({ message, attachment, video }: { message: MessageView; attachment: Attachment; video: boolean }) {
  const serverId = useApp((state) => state.activeServerId);
  const setOverlay = useApp((state) => state.setOverlay);
  const ref = useRef<HTMLButtonElement>(null);
  const seen = useSeen(ref);
  const [wanted, setWanted] = useState(() => loadsByItself(attachment));
  const { url, failed } = useDecryptedUrl(serverId, attachment, !video && seen && wanted);
  const { show, onContextMenu, menu } = useShowInChat(message);
  return (
    <>
      <button
        ref={ref}
        className="shared-tile"
        onClick={() => (video ? show() : url ? setOverlay({ type: "image", url, name: attachment.name }) : setWanted(true))}
        onContextMenu={onContextMenu}
        title={formatFull(message.createdAt)}
        aria-label={video ? `Show ${attachment.name} in the chat` : wanted ? `Open ${attachment.name}` : `Load ${attachment.name}`}
      >
        {attachment.thumb && <img className="shared-tile-thumb" src={attachment.thumb} alt="" draggable={false} />}
        {url && <img className="shared-tile-full" src={url} alt="" draggable={false} />}
        {video && (
          <>
            <span className="shared-tile-play">
              <Play size={16} fill="currentColor" />
            </span>
            {attachment.duration ? <span className="media-badge">{formatDuration(attachment.duration)}</span> : null}
          </>
        )}
        {!video && !wanted && (
          <span className="shared-tile-play">
            <Download size={15} />
          </span>
        )}
        {failed && (
          <span className="shared-tile-play">
            <AlertCircle size={16} />
          </span>
        )}
      </button>
      {menu}
    </>
  );
}

/** Who sent something, and when. */
function SentBy({ message }: { message: MessageView }) {
  const server = useActiveServer();
  const sender = server?.users[message.senderId];
  return (
    <span className="shared-meta truncate">
      <span style={{ color: nameColor(message.senderId) }}>{message.senderId === server?.self?.userId ? "You" : (sender?.displayName ?? "Unknown")}</span>
      {" · "}
      {formatFull(message.createdAt)}
    </span>
  );
}

/** A message's files, sound files or voice messages, each playing or downloading where it is. */
function AttachmentRows({ message, kind }: { message: MessageView; kind: Exclude<MediaKind, "photo" | "video" | "link"> }) {
  const serverId = useApp((state) => state.activeServerId) ?? "";
  const { onContextMenu, menu } = useShowInChat(message);
  return (
    <>
      {message.attachments
        .filter((attachment) => attachmentKind(attachment) === kind)
        .map((attachment, index) => (
          <div key={index} className="shared-item" onContextMenu={onContextMenu}>
            {kind === "voice" ? (
              <VoiceAttachment attachment={attachment} serverId={serverId} own={false} />
            ) : kind === "audio" ? (
              <AudioAttachment attachment={attachment} serverId={serverId} />
            ) : (
              <FileAttachment attachment={attachment} serverId={serverId} />
            )}
            <SentBy message={message} />
          </div>
        ))}
      {menu}
    </>
  );
}

/**
 * A message's links, under its preview if it has one. What the preview says is
 * the sender's claim, so each link shows where it really goes, as in the chat.
 */
function LinkRow({ message }: { message: MessageView }) {
  const { onContextMenu, menu } = useShowInChat(message);
  const links = sharedLinks(message.text);
  const preview = message.preview && links.includes(message.preview.url) ? message.preview : null;
  const host = linkHost(links[0] ?? "");
  const text = plainText(message.text);
  const description = preview?.description ?? links.reduce((rest, link) => rest.replace(link, ""), text).replace(/\s+/g, " ").trim();
  return (
    <div className="shared-item shared-link" onContextMenu={onContextMenu}>
      {preview?.image ? (
        <img className="shared-link-image" src={preview.image.data} alt="" draggable={false} />
      ) : (
        <span className="shared-link-image is-letter" style={{ background: avatarColor(host) }}>
          {(host[0] ?? "?").toUpperCase()}
        </span>
      )}
      <span className="shared-link-body">
        <span className="shared-link-title truncate">{preview?.title ?? host}</span>
        {description && <span className="shared-link-description">{description}</span>}
        {links.map((link, index) => (
          <a key={index} className="shared-link-url truncate" href={link} target="_blank" rel="noreferrer noopener" title={link} draggable={false}>
            {link}
          </a>
        ))}
        <SentBy message={message} />
      </span>
      {menu}
    </div>
  );
}

function GroupsInCommon({ conversation }: { conversation: ConversationView }) {
  const groups = useGroupsInCommon(conversation.peerId);
  const selectConversation = useApp((state) => state.selectConversation);
  if (groups.length === 0) {
    return (
      <div className="side-body">
        <Nothing />
      </div>
    );
  }
  return (
    <div className="side-body">
      <div className="shared-list">
        {groups.map((group) => (
          <button key={group.key} className="member-row" onClick={() => selectConversation(group.key)}>
            <Avatar name={group.title} seed={group.groupId ?? ""} avatar={group.avatar} size={36} />
            <span className="grow">
              <span className="truncate" style={{ display: "block", fontWeight: 550 }}>{group.title}</span>
              <span className="faint truncate" style={{ display: "block", fontSize: 12 }}>
                {group.members.length} {group.members.length === 1 ? "member" : "members"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
