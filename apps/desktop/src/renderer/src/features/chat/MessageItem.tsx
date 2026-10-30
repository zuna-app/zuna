import type { Attachment, EmoteRef, MessageView, ReactionView } from "@zuna/core";
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Download,
  File as FileIcon,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  ShieldAlert,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { plainText } from "@zuna/core/plain-text";
import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Emote } from "@/components/Emote";
import { Avatar, PopupMenu, Spinner, Tooltip, useAction, useContextMenu, type MenuEntry } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatBytes, formatDuration, formatFull, formatTime, nameColor } from "@/lib/format";
import { jumboSize, renderMarkup } from "@/lib/markup";
import { downloadAttachment, useDecryptedUrl } from "@/lib/media";
import { useApp } from "@/state/store";
import { useMarkupContext } from "./use-markup-context";
import { EmotePicker } from "./EmotePicker";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "😮", "😢"];

/** Narrow selectors, so a message only re-renders when something it shows changes. */
const useServerField = <T,>(pick: (server: NonNullable<ReturnType<typeof serverOf>>) => T, fallback: T): T =>
  useApp((state) => {
    const server = serverOf(state);
    return server ? pick(server) : fallback;
  });

function serverOf(state: ReturnType<typeof useApp.getState>) {
  return state.activeServerId ? state.servers[state.activeServerId] : undefined;
}

function SystemMessage({ message, highlighted }: { message: MessageView; highlighted: boolean }) {
  const text = useServerField((server) => {
    const name = (id?: string) => {
      if (!id) return "Someone";
      if (id === server.self?.userId) return "You";
      return server.users[id]?.displayName ?? "Someone";
    };
    const system = message.system!;
    const targets = (system.targetIds ?? []).map(name).join(", ");
    switch (system.type) {
      case "group_created":
        return `${name(system.actorId)} created this group`;
      case "member_added":
        return `${name(system.actorId)} added ${targets}`;
      case "member_removed":
        return `${name(system.actorId)} removed ${targets}`;
      case "member_left":
        return `${name(system.actorId)} left the group`;
      case "member_rejoined":
        return `${name(system.actorId)} rejoined this chat`;
      case "unexpected_join":
        return `${name(system.actorId)} joined without being added by a member. Check that this is expected.`;
      case "identity_changed":
        return `${name(system.actorId)}'s security key changed. Verify it before trusting new messages.`;
      case "device_added":
        return `${name(system.actorId)} added a device`;
    }
  }, "");
  const warning = message.system!.type === "unexpected_join" || message.system!.type === "identity_changed";
  return (
    <div className={`system-row${highlighted ? " is-highlighted" : ""}`}>
      <span className={warning ? "system-pill is-warning" : "system-pill"}>
        {warning && <ShieldAlert size={13} />}
        {text}
      </span>
    </div>
  );
}

function ImageAttachment({ attachment, serverId, single, uploadProgress }: { attachment: Attachment; serverId: string; single: boolean; uploadProgress?: number }) {
  const uploading = !attachment.fileId;
  const { url, failed } = useDecryptedUrl(serverId, attachment, !uploading);
  const setOverlay = useApp((state) => state.setOverlay);
  const width = attachment.width ?? 320;
  const height = attachment.height ?? 240;
  const scale = single ? Math.min(1, 420 / width, 380 / height) : 1;
  return (
    <button
      className={`media-tile${single ? " is-single" : ""}`}
      // The box is sized up front, so the list doesn't jump when the image arrives.
      style={single ? { width: Math.max(140, width * scale), minWidth: "100%", aspectRatio: `${width} / ${height}` } : undefined}
      onClick={() => url && setOverlay({ type: "image", url, name: attachment.name })}
      aria-label={`Open ${attachment.name}`}
    >
      {attachment.thumb && <img className={`media-thumb${url ? " is-hidden" : ""}`} src={attachment.thumb} alt="" draggable={false} />}
      {url && <img className="media-full" src={url} alt={attachment.name} draggable={false} />}
      {!url && !failed && <span className="media-state">{uploading ? <UploadRing progress={uploadProgress ?? 0} /> : <Spinner delayed />}</span>}
      {failed && (
        <span className="media-state">
          <AlertCircle size={20} />
        </span>
      )}
    </button>
  );
}

function UploadRing({ progress }: { progress: number }) {
  const circumference = 2 * Math.PI * 14;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="upload-ring" aria-label={`Uploading ${Math.round(progress * 100)}%`}>
      <circle cx="18" cy="18" r="14" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.2)" strokeWidth="2.5" />
      <circle
        cx="18"
        cy="18"
        r="14"
        fill="none"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

function MediaAttachment({ attachment, serverId }: { attachment: Attachment; serverId: string }) {
  const [load, setLoad] = useState(false);
  const { url, failed } = useDecryptedUrl(serverId, attachment, load && !!attachment.fileId);
  const isVideo = attachment.mime.startsWith("video/");
  if (url) {
    return isVideo ? (
      <video className="media-video" src={url} controls autoPlay style={{ aspectRatio: attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : undefined }} />
    ) : (
      <audio className="media-audio" src={url} controls autoPlay />
    );
  }
  return (
    <button className="file-card" onClick={() => setLoad(true)} disabled={!attachment.fileId}>
      <span className="file-icon">{load && !failed ? <Spinner size={16} /> : <Play size={16} fill="currentColor" />}</span>
      <span className="file-info">
        <span className="file-name truncate">{attachment.name}</span>
        <span className="file-size">
          {failed ? "Couldn't load" : formatBytes(attachment.size)}
          {attachment.duration ? ` · ${formatDuration(attachment.duration)}` : ""}
        </span>
      </span>
    </button>
  );
}

function FileAttachment({ attachment, serverId, uploadProgress }: { attachment: Attachment; serverId: string; uploadProgress?: number }) {
  const { busy, run } = useAction();
  const uploading = !attachment.fileId;
  return (
    <button className="file-card" disabled={uploading || busy} onClick={() => run(() => downloadAttachment(serverId, attachment))}>
      <span className="file-icon">{busy ? <Spinner size={16} /> : uploading ? <UploadRing progress={uploadProgress ?? 0} /> : <FileIcon size={17} />}</span>
      <span className="file-info">
        <span className="file-name truncate">{attachment.name}</span>
        <span className="file-size">{uploading ? `Encrypting and uploading, ${Math.round((uploadProgress ?? 0) * 100)}%` : formatBytes(attachment.size)}</span>
      </span>
      {!uploading && !busy && <Download size={15} className="file-download" />}
    </button>
  );
}

function Attachments({ message, serverId, flush }: { message: MessageView; serverId: string; flush: boolean }) {
  const images = message.attachments.filter((item) => item.mime.startsWith("image/") && item.width);
  const others = message.attachments.filter((item) => !images.includes(item));
  return (
    <>
      {images.length > 0 && (
        <div className={`media-grid media-count-${Math.min(images.length, 4)}${flush ? " has-no-text" : ""}`}>
          {images.map((attachment, index) => (
            <ImageAttachment key={attachment.fileId || index} attachment={attachment} serverId={serverId} single={images.length === 1} uploadProgress={message.uploadProgress} />
          ))}
        </div>
      )}
      {others.map((attachment, index) =>
        attachment.mime.startsWith("video/") || attachment.mime.startsWith("audio/") ? (
          <MediaAttachment key={attachment.fileId || index} attachment={attachment} serverId={serverId} />
        ) : (
          <FileAttachment key={attachment.fileId || index} attachment={attachment} serverId={serverId} uploadProgress={message.uploadProgress} />
        ),
      )}
    </>
  );
}

/** A reaction, as in Telegram: emoji with the people who reacted, or a count once there are many. */
function ReactionChip({
  reaction,
  selfId,
  serverUrl,
  showPeople,
  onToggle,
}: {
  reaction: ReactionView;
  selfId: string;
  serverUrl: string;
  showPeople: boolean;
  onToggle: () => void;
}) {
  const names = useServerField((server) => reaction.userIds.map((id) => (id === selfId ? "You" : (server.users[id]?.displayName ?? "Someone"))).join(", "), "");
  const people = useApp(
    useShallow((state) => {
      const server = serverOf(state);
      return showPeople && server ? reaction.userIds.map((id) => server.users[id]) : null;
    }),
  );
  const mine = reaction.userIds.includes(selfId);
  const chip = (
    <button className={`reaction${mine ? " is-mine" : ""}`} onClick={onToggle} aria-label={`${reaction.key}, ${names}`}>
      {reaction.emote ? <Emote name={reaction.key} emote={reaction.emote} serverUrl={serverUrl} size="reaction" note={`Reacted by ${names}`} /> : <span className="reaction-emoji">{reaction.key}</span>}
      {people ? (
        <span className="reaction-people">
          {reaction.userIds.map((id, index) => (
            <Avatar key={id} name={people[index]?.displayName ?? "?"} seed={id} avatar={people[index]?.avatar} size={16} />
          ))}
        </span>
      ) : (
        <span>{reaction.userIds.length}</span>
      )}
    </button>
  );
  return reaction.emote ? (
    chip
  ) : (
    <Tooltip text={names} side="top">
      {chip}
    </Tooltip>
  );
}

function ReadTicks({ message, readUpTo }: { message: MessageView; readUpTo: number }) {
  if (message.status === "sending") return <Clock size={11} className="msg-tick" />;
  if (message.status === "failed") return <AlertCircle size={12} className="msg-tick is-failed" />;
  if (message.seq === null) return null;
  return readUpTo >= message.seq ? <CheckCheck size={14} className="msg-tick is-read" /> : <Check size={14} className="msg-tick" />;
}

interface MessageItemProps {
  message: MessageView;
  listId: string;
  isGroup: boolean;
  isGroupAdmin: boolean;
  readUpTo: number;
  grouped: boolean;
  lastInGroup: boolean;
  fresh: boolean;
  highlighted: boolean;
  own: boolean;
}

export const MessageItem = memo(function MessageItem({ message, listId, isGroup, isGroupAdmin, readUpTo, grouped, lastInGroup, fresh, highlighted, own }: MessageItemProps) {
  const session = useApp((state) => state.session);
  const setReply = useApp((state) => state.setReply);
  const setEditing = useApp((state) => state.setEditing);
  const jump = useApp((state) => state.jumpToMessage);
  const toast = useApp((state) => state.toast);
  const serverId = useApp((state) => state.activeServerId) ?? "";
  const senderName = useServerField((server) => server.users[message.senderId]?.displayName ?? "Unknown", "Unknown");
  const senderAvatar = useServerField((server) => server.users[message.senderId]?.avatar ?? null, null);
  const replyName = useServerField((server) => {
    const id = message.reply?.senderId;
    if (!id) return "Earlier message";
    return id === server.self?.userId ? "You" : (server.users[id]?.displayName ?? "Unknown");
  }, "");
  const baseContext = useMarkupContext();
  const menu = useContextMenu();
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const { run } = useAction();

  const selfId = baseContext.selfId;
  const canDelete = own || (isGroup && isGroupAdmin);
  const isDeleted = message.deletedAt !== null;
  const canAct = message.seq !== null && !isDeleted && message.status === "sent";

  const context = useMemo(
    () => ({
      ...baseContext,
      emotes: message.emotes,
      onMention: (userId: string) => useApp.getState().setOverlay({ type: "verify", userId }),
    }),
    [baseContext, message.emotes],
  );
  const jumbo = useMemo(() => (message.attachments.length === 0 ? jumboSize(message.text, message.emotes) : 0), [message.text, message.emotes, message.attachments.length]);

  const hasReactions = message.reactions.length > 0;
  const metaInText = !!message.text && !hasReactions && !isDeleted && message.status !== "undecryptable" && message.status !== "unverified";
  const images = message.attachments.filter((item) => item.mime.startsWith("image/") && item.width);
  const onlyImages = !message.text && images.length > 0 && images.length === message.attachments.length && !hasReactions;

  const meta = (
    <span className={`msg-meta${onlyImages ? " is-overlay" : ""}`} title={formatFull(message.createdAt)}>
      {message.pinnedAt && <Pin size={10} className="msg-pinned" />}
      {message.editedAt && !isDeleted && <span>edited</span>}
      <span>{formatTime(message.createdAt)}</span>
      {own && !isDeleted && <ReadTicks message={message} readUpTo={readUpTo} />}
    </span>
  );

  const renderBody = () => {
    if (!message.text) return null;
    if (jumbo) {
      return (
        <>
          {message.text
            .trim()
            .split(/\s+/)
            .map((word, index) => {
              const emote: EmoteRef | undefined = message.emotes[word];
              return emote ? (
                <Emote key={index} name={word} emote={emote} serverUrl={context.serverUrl} size="jumbo" stackOnPrevious={emote.zeroWidth} />
              ) : (
                <span key={index} className="jumbo-emoji">
                  {word}
                </span>
              );
            })}
          {metaInText && meta}
        </>
      );
    }
    return renderMarkup(message.text, context, metaInText ? meta : undefined);
  };
  const body = renderBody();

  if (message.system) return <SystemMessage message={message} highlighted={highlighted} />;

  const toggleReaction = (key: string, emote?: EmoteRef) => {
    void run(() => session().toggleReaction(message.groupId, message.id, key, emote));
  };

  const entries: MenuEntry[] = [
    ...(canAct ? [{ label: "Reply", icon: <CornerUpLeft size={15} />, onSelect: () => setReply(listId, message) }] : []),
    ...(message.text && !isDeleted
      ? [
          {
            label: window.getSelection()?.toString() ? "Copy selection" : "Copy text",
            icon: <Copy size={15} />,
            onSelect: () => void copyText(window.getSelection()?.toString() || message.text).then(() => toast("Copied")),
          },
        ]
      : []),
    ...(canAct && own && message.text ? [{ label: "Edit", icon: <Pencil size={15} />, onSelect: () => setEditing(listId, message) }] : []),
    ...(canAct
      ? [
          {
            label: message.pinnedAt ? "Unpin" : "Pin",
            icon: message.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />,
            onSelect: () => void run(() => session().setPinned(message.groupId, message.id, !message.pinnedAt)),
          },
        ]
      : []),
    ...(message.status === "failed"
      ? [
          { label: "Try again", icon: <RefreshCw size={15} />, onSelect: () => void session().retryMessage(message.groupId, message.id) },
          { label: "Discard", icon: <Trash2 size={15} />, danger: true, onSelect: () => void session().discardMessage(message.groupId, message.id) },
        ]
      : []),
    ...(canAct && canDelete
      ? [{ separator: true }, { label: "Delete for everyone", icon: <Trash2 size={15} />, danger: true, onSelect: () => void run(() => session().deleteMessage(message.groupId, message.id)) }]
      : []),
  ];

  const quickReactions = canAct ? (
    <div className="menu-react">
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => {
            menu.close();
            toggleReaction(emoji);
          }}
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  ) : undefined;

  const className = ["msg", own ? "is-own" : "is-other", grouped ? "is-grouped" : "", lastInGroup ? "is-last" : "", highlighted ? "is-highlighted" : "", jumbo ? "is-jumbo" : "", fresh ? "is-fresh" : ""]
    .filter(Boolean)
    .join(" ");
  const totalReactors = message.reactions.reduce((sum, reaction) => sum + reaction.userIds.length, 0);

  return (
    <div className={className} onContextMenu={(event) => entries.length > 0 && menu.open(event)}>
      {!own && isGroup && <span className="msg-avatar">{lastInGroup && <Avatar name={senderName} seed={message.senderId} avatar={senderAvatar} size={32} />}</span>}
      <div className="msg-stack">
        <div className={`bubble${message.status === "sending" ? " is-sending" : ""}${message.status === "failed" ? " is-failed" : ""}`}>
          {!own && isGroup && !grouped && !jumbo && (
            <span className="msg-author" style={{ color: nameColor(message.senderId) }}>
              {senderName}
            </span>
          )}
          {isDeleted ? (
            <span className="msg-placeholder">Message deleted</span>
          ) : message.status === "undecryptable" ? (
            <span className="msg-placeholder">
              <Spinner size={12} /> Waiting for this message's keys
            </span>
          ) : message.status === "unverified" ? (
            <span className="msg-placeholder is-danger">
              <ShieldAlert size={14} /> This message's signature is invalid, so it isn't shown.
            </span>
          ) : (
            <>
              {message.reply && (
                <button className="msg-reply" onClick={() => jump(message.groupId, message.reply!.id)}>
                  <span className="msg-reply-author" style={{ color: nameColor(message.reply.senderId || "x") }}>
                    {replyName}
                  </span>
                  <span className="msg-reply-text truncate">{message.reply.deleted ? "Message deleted" : plainText(message.reply.text) || (message.reply.hasAttachment ? "Attachment" : "Tap to view")}</span>
                </button>
              )}
              {message.attachments.length > 0 && <Attachments message={message} serverId={serverId} flush={onlyImages} />}
              {body && (
                <div className="msg-text selectable">
                  {body}
                </div>
              )}
            </>
          )}
          {hasReactions ? (
            <div className="reactions">
              {message.reactions.map((reaction) => (
                <ReactionChip key={reaction.key} reaction={reaction} selfId={selfId} serverUrl={context.serverUrl} showPeople={totalReactors <= 3} onToggle={() => toggleReaction(reaction.key, reaction.emote)} />
              ))}
              {meta}
            </div>
          ) : (
            !metaInText && meta
          )}
        </div>
        {message.status === "failed" && (
          <button className="msg-retry" onClick={() => void session().retryMessage(message.groupId, message.id)}>
            <AlertCircle size={13} /> Not sent. Try again
          </button>
        )}
      </div>
      {canAct && (
        <div className="msg-actions">
          <Tooltip text="React" side="top">
            <button
              className="icon-btn is-small"
              aria-label="React"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setPicker({ x: rect.left, y: rect.top });
              }}
            >
              <SmilePlus size={15} />
            </button>
          </Tooltip>
          <Tooltip text="Reply" side="top">
            <button className="icon-btn is-small" onClick={() => setReply(listId, message)} aria-label="Reply">
              <CornerUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip text="More" side="top">
            <button
              className="icon-btn is-small"
              aria-label="More"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                menu.open({ clientX: own ? rect.left : rect.right, clientY: rect.bottom + 2 });
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          </Tooltip>
        </div>
      )}
      <AnimatePresence>
        {menu.menu && <PopupMenu x={menu.menu.x} y={menu.menu.y} entries={entries} onClose={menu.close} header={quickReactions} />}
        {picker && (
          <EmotePicker
            key="reaction-picker"
            anchor={picker}
            onClose={() => setPicker(null)}
            onPick={(pick) => {
              setPicker(null);
              if (pick.kind === "emoji") toggleReaction(pick.value);
              else toggleReaction(pick.name, { id: pick.id, animated: pick.animated, zeroWidth: pick.zeroWidth, owner: pick.owner });
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
});
