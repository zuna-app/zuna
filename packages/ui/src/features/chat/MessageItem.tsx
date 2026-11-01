import type { Attachment, EmoteRef, LinkPreview, MessageView, ReactionView } from "@zuna/core";
import {
  AlertCircle,
  Check,
  CircleCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Download,
  File as FileIcon,
  Forward,
  MoreHorizontal,
  Pause,
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
import { linkHost } from "@zuna/core/links";
import { plainText } from "@zuna/core/plain-text";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Emote } from "@/components/Emote";
import { Avatar, PopupMenu, Spinner, Tooltip, useAction, useContextMenu, type MenuEntry } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { formatBytes, formatDuration, formatFull, formatTime, nameColor } from "@/lib/format";
import { emoteFor, jumboSize, renderMarkup } from "@/lib/markup";
import { downloadAttachment, loadsByItself, useDecryptedUrl } from "@/lib/media";
import { decodeWaveform, playOnly } from "@/lib/voice";
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
  // A very large picture waits for a click, as a video does.
  const [wanted, setWanted] = useState(() => loadsByItself(attachment));
  const { url, failed } = useDecryptedUrl(serverId, attachment, !uploading && wanted);
  const setOverlay = useApp((state) => state.setOverlay);
  const width = attachment.width ?? 320;
  const height = attachment.height ?? 240;
  const scale = single ? Math.min(1, 420 / width, 380 / height) : 1;
  return (
    <button
      className={`media-tile${single ? " is-single" : ""}`}
      // The box is sized up front, so the list doesn't jump when the image arrives.
      style={single ? { width: Math.max(140, width * scale), minWidth: "100%", aspectRatio: `${width} / ${height}` } : undefined}
      onClick={() => (url ? setOverlay({ type: "image", url, name: attachment.name }) : setWanted(true))}
      aria-label={wanted ? `Open ${attachment.name}` : `Load ${attachment.name}, ${formatBytes(attachment.size)}`}
    >
      {attachment.thumb && <img className={`media-thumb${url ? " is-hidden" : ""}`} src={attachment.thumb} alt="" draggable={false} />}
      {url && <img className="media-full" src={url} alt={attachment.name} draggable={false} />}
      {!wanted && (
        <span className="media-state">
          <span className="media-load">
            <Download size={15} /> {formatBytes(attachment.size)}
          </span>
        </span>
      )}
      {wanted && !url && !failed && <span className="media-state">{uploading ? <UploadRing progress={uploadProgress ?? 0} /> : <Spinner delayed />}</span>}
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
        className="upload-ring-done"
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

/** How far one file is, from how far the whole message is: its files go up one after another. */
function fileProgress(message: MessageView, attachment: Attachment): number {
  const total = message.attachments.reduce((sum, item) => sum + item.size, 0);
  let before = 0;
  for (const item of message.attachments) {
    if (item === attachment) break;
    before += item.size;
  }
  const done = (message.uploadProgress ?? 0) * total - before;
  return Math.min(1, Math.max(0, attachment.size ? done / attachment.size : 0));
}

/** A thin bar under a file's name while it goes up, as in Telegram. */
function UploadBar({ progress }: { progress: number }) {
  return (
    <span className="upload-bar" role="progressbar" aria-label="Uploading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <span style={{ transform: `scaleX(${progress})` }} />
    </span>
  );
}

const uploadedOf = (attachment: Attachment, progress: number) => `${formatBytes(attachment.size * progress)} of ${formatBytes(attachment.size)}`;

/**
 * A video, with its picture straight away: the frame the sender's device took,
 * then the video itself, which only plays when someone presses play.
 */
function VideoAttachment({ attachment, serverId, uploadProgress }: { attachment: Attachment; serverId: string; uploadProgress?: number }) {
  const uploading = !attachment.fileId;
  // Those small enough load by themselves, so their first frame shows without pressing anything.
  const [load, setLoad] = useState(() => loadsByItself(attachment));
  const { url, failed } = useDecryptedUrl(serverId, attachment, load && !uploading);
  const width = attachment.width ?? 16;
  const height = attachment.height ?? 9;
  const scale = Math.min(1, 420 / width, 380 / height);
  // The box is sized up front, so the list doesn't jump when the video arrives.
  const style = { width: Math.max(200, width * scale), aspectRatio: `${width} / ${height}` };
  if (url) return <video className="media-video" src={url} controls preload="metadata" playsInline style={style} />;
  return (
    <div className="media-video is-waiting" style={style}>
      {attachment.thumb && <img className="media-poster" src={attachment.thumb} alt="" draggable={false} />}
      <span className="media-state">
        {uploading ? (
          <UploadRing progress={uploadProgress ?? 0} />
        ) : failed ? (
          <AlertCircle size={22} />
        ) : load ? (
          <Spinner delayed />
        ) : (
          <button className="media-load" onClick={() => setLoad(true)} aria-label={`Load ${attachment.name}, ${formatBytes(attachment.size)}`}>
            <Download size={15} /> {formatBytes(attachment.size)}
          </button>
        )}
      </span>
      <span className="media-badge">
        {uploading
          ? uploadedOf(attachment, uploadProgress ?? 0)
          : failed
            ? "Couldn't load"
            : attachment.duration
              ? formatDuration(attachment.duration)
              : ""}
      </span>
    </div>
  );
}

/** A sound file, which plays once it's pressed. */
function AudioAttachment({ attachment, serverId, uploadProgress }: { attachment: Attachment; serverId: string; uploadProgress?: number }) {
  const [load, setLoad] = useState(false);
  const uploading = !attachment.fileId;
  const { url, failed } = useDecryptedUrl(serverId, attachment, load && !uploading);
  if (url) return <audio className="media-audio" src={url} controls autoPlay />;
  return (
    <button className="file-card" onClick={() => setLoad(true)} disabled={uploading}>
      <span className="file-icon">{uploading ? <UploadRing progress={uploadProgress ?? 0} /> : load && !failed ? <Spinner size={16} /> : <Play size={16} fill="currentColor" />}</span>
      <span className="file-info">
        <span className="file-name truncate">{attachment.name}</span>
        {uploading && <UploadBar progress={uploadProgress ?? 0} />}
        <span className="file-size">
          {uploading ? uploadedOf(attachment, uploadProgress ?? 0) : failed ? "Couldn't load" : formatBytes(attachment.size)}
          {!uploading && attachment.duration ? ` · ${formatDuration(attachment.duration)}` : ""}
        </span>
      </span>
    </button>
  );
}

/** A voice message, as in Telegram: play, a waveform that fills as it plays and seeks on a click, and the time. */
function VoiceAttachment({ attachment, serverId, own, uploadProgress }: { attachment: Attachment; serverId: string; own: boolean; uploadProgress?: number }) {
  const [load, setLoad] = useState(false);
  const { url, failed } = useDecryptedUrl(serverId, attachment, load && !!attachment.fileId);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  /** Where to start once the file is ready, after a press of Play or a click on the waveform. */
  const pending = useRef<number | null>(null);
  const bars = useMemo(() => decodeWaveform(attachment.waveform), [attachment.waveform]);
  const duration = attachment.duration ?? 0;
  const uploading = !attachment.fileId;

  const start = (source: string, at: number) => {
    let element = audio.current;
    if (!element) {
      element = new Audio(source);
      element.ontimeupdate = () => setPosition(element!.currentTime);
      element.onplay = () => setPlaying(true);
      element.onpause = () => setPlaying(false);
      element.onended = () => {
        setPlaying(false);
        setPosition(0);
      };
      audio.current = element;
    }
    element.currentTime = at;
    playOnly(element);
    element.play().catch(() => setPlaying(false));
  };

  // The file is decrypted on the first play, which starts once it's ready.
  useEffect(() => {
    if (url && pending.current !== null && !audio.current) {
      start(url, pending.current);
      pending.current = null;
    }
  }, [url]);
  useEffect(() => () => audio.current?.pause(), []);

  const play = (at: number) => {
    if (url) start(url, at);
    else {
      pending.current = at;
      setLoad(true);
    }
  };

  const toggle = () => {
    if (audio.current && !audio.current.paused) audio.current.pause();
    else play(audio.current?.currentTime ?? position);
  };

  const seek = (event: React.MouseEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const time = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
    setPosition(time);
    if (audio.current && !audio.current.paused) audio.current.currentTime = time;
    else play(time);
  };

  const progress = duration ? position / duration : 0;
  return (
    <div className={`voice${own ? " is-own" : ""}`}>
      <button className="voice-play" onClick={toggle} disabled={uploading || failed} aria-label={playing ? "Pause" : "Play voice message"}>
        {uploading ? (
          <UploadRing progress={uploadProgress ?? 0} />
        ) : load && !url && !failed ? (
          <Spinner size={16} />
        ) : failed ? (
          <AlertCircle size={18} />
        ) : playing ? (
          <Pause size={18} fill="currentColor" />
        ) : (
          <Play size={18} fill="currentColor" />
        )}
      </button>
      <span className="voice-body">
        <span className="voice-wave" onClick={seek} role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(position)}>
          {bars.map((height, index) => (
            <i key={index} className={index / bars.length < progress ? "is-played" : ""} style={{ height: `${Math.max(12, height * 100)}%` }} />
          ))}
        </span>
        <span className="voice-time">{formatDuration(playing || position ? position : duration)}</span>
      </span>
    </div>
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
        {uploading && <UploadBar progress={uploadProgress ?? 0} />}
        <span className="file-size">{uploading ? uploadedOf(attachment, uploadProgress ?? 0) : formatBytes(attachment.size)}</span>
      </span>
      {!uploading && !busy && <Download size={15} className="file-download" />}
    </button>
  );
}

function Attachments({ message, serverId, flush, own }: { message: MessageView; serverId: string; flush: boolean; own: boolean }) {
  const images = message.attachments.filter((item) => item.mime.startsWith("image/") && item.width);
  const others = message.attachments.filter((item) => !images.includes(item));
  return (
    <>
      {images.length > 0 && (
        <div className={`media-grid media-count-${Math.min(images.length, 4)}${flush ? " has-no-text" : ""}`}>
          {images.map((attachment, index) => (
            <ImageAttachment key={attachment.fileId || index} attachment={attachment} serverId={serverId} single={images.length === 1} uploadProgress={fileProgress(message, attachment)} />
          ))}
        </div>
      )}
      {others.map((attachment, index) => {
        const key = attachment.fileId || `file-${index}`;
        const progress = fileProgress(message, attachment);
        if (attachment.voice) return <VoiceAttachment key={key} attachment={attachment} serverId={serverId} own={own} uploadProgress={progress} />;
        if (attachment.mime.startsWith("video/")) return <VideoAttachment key={key} attachment={attachment} serverId={serverId} uploadProgress={progress} />;
        if (attachment.mime.startsWith("audio/")) return <AudioAttachment key={key} attachment={attachment} serverId={serverId} uploadProgress={progress} />;
        return <FileAttachment key={key} attachment={attachment} serverId={serverId} uploadProgress={progress} />;
      })}
    </>
  );
}

/** Whose message this was, as in Telegram. Forwarded from another server, it only says it's forwarded. */
function ForwardedFrom({ userId }: { userId?: string }) {
  const name = useServerField((server) => {
    if (!userId) return null;
    if (userId === server.self?.userId) return "You";
    return server.users[userId]?.displayName ?? null;
  }, null);
  return (
    <span className="msg-forwarded">
      <Forward size={13} />
      {name && userId ? (
        <>
          Forwarded from{" "}
          <button className="msg-forwarded-name" onClick={() => useApp.getState().setOverlay({ type: "verify", userId })}>
            {name}
          </button>
        </>
      ) : (
        "Forwarded"
      )}
    </span>
  );
}

/**
 * A link's preview, sent by whoever wrote the message. What it says about the page
 * is their claim, so where the link really goes is always shown with it. A wide
 * picture goes below, a small one beside the text.
 */
function LinkCard({ preview }: { preview: LinkPreview }) {
  const image = preview.image;
  const wide = !!image && image.width >= 300 && image.width >= image.height * 1.2;
  const host = linkHost(preview.url);
  const site = preview.siteName && preview.siteName.toLowerCase() !== host ? `${host} · ${preview.siteName}` : host;
  return (
    <a className={`link-card${wide ? " is-wide" : ""}`} href={preview.url} target="_blank" rel="noreferrer noopener" title={preview.url} draggable={false}>
      <span className="link-card-text">
        <span className="link-card-site truncate">{site}</span>
        {preview.title && <span className="link-card-title">{preview.title}</span>}
        {preview.description && <span className="link-card-description">{preview.description}</span>}
      </span>
      {image && <img className="link-card-image" src={image.data} alt="" draggable={false} style={wide ? { aspectRatio: `${image.width} / ${image.height}` } : undefined} />}
    </a>
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

/** Thin and slanted, as in Telegram. Reading a message adds a second tick beside the first, which stays put. */
function Ticks({ read }: { read: boolean }) {
  return (
    <svg className={`msg-tick${read ? " is-read" : ""}`} width="18" height="10" viewBox="0 0 18 10" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M.6 5.6 3.7 8.8 12 .6" />
      {read && <path d="M7.4 7.4 8.9 8.8 17.2 .6" />}
    </svg>
  );
}

function ReadTicks({ message, readUpTo }: { message: MessageView; readUpTo: number }) {
  if (message.status === "sending") return <Clock size={11} className="msg-tick is-sending" />;
  if (message.status === "failed") return <AlertCircle size={12} className="msg-tick is-failed" />;
  if (message.seq === null) return null;
  return <Ticks read={readUpTo >= message.seq} />;
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
  const selecting = useApp((state) => state.selection?.listId === listId);
  const selected = useApp((state) => state.selection?.listId === listId && state.selection.ids.includes(message.id));

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
  // The time goes at the end of the text, or below a link's preview, or below a big emote.
  const metaInText =
    !!message.text && !jumbo && !message.preview && !hasReactions && !isDeleted && message.status !== "undecryptable" && message.status !== "unverified" && message.status !== "invalid";
  const images = message.attachments.filter((item) => item.mime.startsWith("image/") && item.width);
  const onlyImages = !message.text && images.length > 0 && images.length === message.attachments.length && !hasReactions;

  const meta = (
    <span
      className={`msg-meta${onlyImages ? " is-overlay" : ""}`}
      title={message.timeDiffers ? `${formatFull(message.createdAt)}. The sender's device gives a very different time for this message.` : formatFull(message.createdAt)}
    >
      {message.timeDiffers && <ShieldAlert size={11} aria-label="The time of this message may not be right" />}
      {message.pinnedAt && <Pin size={10} className="msg-pinned" />}
      {message.editedAt && !isDeleted && <span>edited</span>}
      <span>{formatTime(message.createdAt)}</span>
      {own && !isDeleted && (
        <span className="msg-ticks">
          <ReadTicks message={message} readUpTo={readUpTo} />
        </span>
      )}
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
              const emote = emoteFor(message.emotes, word);
              return emote ? (
                <Emote key={index} name={word} emote={emote} serverUrl={context.serverUrl} size="jumbo" stackOnPrevious={emote.zeroWidth} />
              ) : (
                <span key={index} className="jumbo-emoji">
                  {word}
                </span>
              );
            })}
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
    ...(canAct
      ? [
          { label: "Forward", icon: <Forward size={15} />, onSelect: () => useApp.getState().setOverlay({ type: "forward", serverId, groupId: message.groupId, ids: [message.id] }) },
          { label: "Select", icon: <CircleCheck size={15} />, onSelect: () => useApp.getState().toggleSelected(listId, message.id) },
        ]
      : []),
    ...(message.text && !isDeleted
      ? [
          {
            label: window.getSelection()?.toString() ? "Copy selection" : "Copy text",
            icon: <Copy size={15} />,
            onSelect: () => void copyText(window.getSelection()?.toString() || message.text).then(() => toast("Copied")),
          },
        ]
      : []),
    ...(canAct && own && message.text && !message.forwarded ? [{ label: "Edit", icon: <Pencil size={15} />, onSelect: () => setEditing(listId, message) }] : []),
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

  const className = [
    "msg",
    own ? "is-own" : "is-other",
    grouped ? "is-grouped" : "",
    lastInGroup ? "is-last" : "",
    highlighted ? "is-highlighted" : "",
    jumbo ? "is-jumbo" : "",
    fresh ? "is-fresh" : "",
    selecting ? "is-selecting" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const totalReactors = message.reactions.reduce((sum, reaction) => sum + reaction.userIds.length, 0);

  return (
    <div
      className={className}
      onContextMenu={(event) => !selecting && entries.length > 0 && menu.open(event)}
      // While picking messages, a click picks this one instead of opening links or pictures.
      onClickCapture={
        selecting
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (canAct) useApp.getState().toggleSelected(listId, message.id);
            }
          : undefined
      }
    >
      {selecting && (
        <span className={`msg-check${selected ? " is-on" : ""}${canAct ? "" : " is-disabled"}`} role="checkbox" aria-checked={selected} aria-label="Select message">
          {selected && <Check size={13} strokeWidth={3} />}
        </span>
      )}
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
              <ShieldAlert size={14} /> This message couldn't be verified, so it isn't shown.
            </span>
          ) : message.status === "invalid" ? (
            <span className="msg-placeholder is-danger">
              <ShieldAlert size={14} /> This message couldn't be displayed.
            </span>
          ) : (
            <>
              {message.forwarded && <ForwardedFrom userId={message.forwarded.userId} />}
              {message.reply && (
                <button className="msg-reply" onClick={() => jump(message.groupId, message.reply!.id)}>
                  <span className="msg-reply-author" style={{ color: nameColor(message.reply.senderId || "x") }}>
                    {replyName}
                  </span>
                  <span className="msg-reply-text truncate">{message.reply.deleted ? "Message deleted" : plainText(message.reply.text) || (message.reply.hasAttachment ? "Attachment" : "Tap to view")}</span>
                </button>
              )}
              {message.attachments.length > 0 && <Attachments message={message} serverId={serverId} flush={onlyImages} own={own} />}
              {body && (
                <div className="msg-text selectable">
                  {body}
                </div>
              )}
              {message.preview && <LinkCard preview={message.preview} />}
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
      {canAct && !selecting && (
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
