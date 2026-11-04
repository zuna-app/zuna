import type { Attachment, EmoteRef, LinkPreview, MessageView, ReactionView, SharedLocation, UserView } from "@zuna/core";
import {
  AlertCircle,
  ArrowRight,
  Ban,
  Check,
  CheckCheck,
  CircleCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Download,
  File as FileIcon,
  Forward,
  Image as ImageIcon,
  MapPin,
  MoreHorizontal,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  ShieldAlert,
  SmilePlus,
  Timer,
  Trash2,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { linkHost } from "@zuna/core/links";
import { plainText } from "@zuna/core/plain-text";
import { MAX_TEXT_LENGTH } from "@zuna/core/validate";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Emote } from "@/components/Emote";
import { Avatar, PopupMenu, Spinner, Tooltip, useAction, useContextMenu, type MenuEntry } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { focusComposer } from "@/lib/focus";
import { formatBytes, formatDuration, formatFull, formatStamp, formatTime, nameColor } from "@/lib/format";
import { emoteFor, jumboSize, renderMarkup } from "@/lib/markup";
import { timerChangeText } from "@/lib/disappearing";
import { accuracyText, coordinatesText, mapLink } from "@/lib/location";
import { downloadAttachment, loadsByItself, useDecryptedUrl } from "@/lib/media";
import { RoundAttachment } from "./Round";
import { decodeWaveform, playOnly } from "@/lib/voice";
import { useApp } from "@/state/store";
import { emotesIn, mentionsIn } from "./Composer";
import { canActOn } from "./use-drag-pick";
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

function SystemMessage({ message, highlighted, channel }: { message: MessageView; highlighted: boolean; channel: boolean }) {
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
      case "identity_rotated":
        return `${name(system.actorId)}'s security key changed since you verified it. You can compare keys again if you'd like.`;
      case "device_added":
        return `${name(system.actorId)} added a device`;
      case "timer_changed":
        return timerChangeText(name(system.actorId), system.seconds ?? 0);
    }
  }, "");
  const warning = message.system!.type === "unexpected_join" || message.system!.type === "identity_changed";
  // In a channel it's a line of its own, with an arrow where a picture would be, as in Discord.
  if (channel) {
    return (
      <div className={`msg is-channel cmsg-system${warning ? " is-warning" : ""}${highlighted ? " is-highlighted" : ""}`}>
        <span className="cmsg-system-icon">{warning ? <ShieldAlert size={16} /> : <ArrowRight size={16} />}</span>
        <span className="cmsg-system-text">
          {text}
          <time className="cmsg-time" title={formatFull(message.createdAt)}>
            {formatStamp(message.createdAt)}
          </time>
        </span>
      </div>
    );
  }
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
export function AudioAttachment({ attachment, serverId, uploadProgress }: { attachment: Attachment; serverId: string; uploadProgress?: number }) {
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
export function VoiceAttachment({ attachment, serverId, own, uploadProgress }: { attachment: Attachment; serverId: string; own: boolean; uploadProgress?: number }) {
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

export function FileAttachment({ attachment, serverId, uploadProgress }: { attachment: Attachment; serverId: string; uploadProgress?: number }) {
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
        if (attachment.round && attachment.mime.startsWith("video/")) return <RoundAttachment key={key} attachment={attachment} serverId={serverId} uploadProgress={progress} />;
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

/**
 * A place someone shared. No map is drawn, since that would mean fetching it from
 * a map's server: it opens on OpenStreetMap in the browser instead.
 */
function LocationCard({ location }: { location: SharedLocation }) {
  return (
    <a className="location-card" href={mapLink(location)} target="_blank" rel="noreferrer noopener" title="Open on OpenStreetMap" draggable={false}>
      <span className="location-pin">
        <MapPin size={20} />
      </span>
      <span className="location-text">
        <b>Location</b>
        <span>{coordinatesText(location)}</span>
        {location.accuracy !== undefined && <span className="location-accuracy">{accuracyText(location.accuracy)}</span>}
      </span>
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
  // Below zero means nobody's reading is known here, as in a channel.
  if (message.seq === null || readUpTo < 0) return null;
  return <Ticks read={readUpTo >= message.seq} />;
}

const openProfile = (userId: string) => useApp.getState().setOverlay({ type: "verify", userId });

/** What a message in a channel answers: above it, joined to its picture by a line, as in Discord. */
function ChannelReply({ message, blocked }: { message: MessageView; blocked: boolean }) {
  const reply = message.reply!;
  const jump = useApp((state) => state.jumpToMessage);
  const user = useServerField((server) => server.users[reply.senderId] ?? null, null);
  const name = user?.displayName ?? "Unknown";
  const text = reply.deleted ? "Original message was deleted" : blocked ? "Message from someone you blocked" : plainText(reply.text);
  return (
    <div className="cmsg-reply">
      {reply.deleted ? (
        <span className="cmsg-reply-gone">
          <CornerUpLeft size={10} />
        </span>
      ) : (
        <>
          <Avatar name={name} seed={reply.senderId} avatar={user?.avatar} size={16} />
          <button className="cmsg-reply-name" style={{ color: nameColor(reply.senderId || "x") }} onClick={() => reply.senderId && openProfile(reply.senderId)}>
            @{name}
          </button>
        </>
      )}
      <button className={`cmsg-reply-text${text ? "" : " is-empty"}`} onClick={() => jump(message.groupId, reply.id)}>
        <span className="truncate">{text || (reply.hasAttachment ? "Click to see attachment" : "Click to see message")}</span>
        {!text && reply.hasAttachment && <ImageIcon size={15} />}
      </button>
    </div>
  );
}

/** A message in a channel is edited where it is, as in Discord: Enter saves it, Escape leaves it as it was. */
function InlineEditor({ message, listId }: { message: MessageView; listId: string }) {
  const session = useApp((state) => state.session);
  const setEditing = useApp((state) => state.setEditing);
  const toast = useApp((state) => state.toast);
  const enterToSend = useApp((state) => state.settings.enterToSend);
  const [text, setText] = useState(message.text);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = input.current!;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const stop = () => {
    setEditing(listId, null);
    focusComposer();
  };
  const save = () => {
    const value = text.trim();
    if (value.length > MAX_TEXT_LENGTH) {
      toast("That message is too long.", "error");
      return;
    }
    if (value && value !== message.text) {
      const state = useApp.getState();
      const server = state.activeServerId ? state.servers[state.activeServerId] : undefined;
      void session().editMessage(message.groupId, message.id, value, emotesIn(value, server?.emotes.emotes ?? []), mentionsIn(value, server?.users ?? {}));
    }
    stop();
  };

  return (
    <div className="cmsg-editor">
      <textarea
        ref={input}
        className="cmsg-editor-input"
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            stop();
          } else if (event.key === "Enter" && ((!event.shiftKey && enterToSend) || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
        aria-label="Edit message"
        spellCheck
      />
      <span className="cmsg-editor-hint">
        escape to{" "}
        <button className="link-button" onClick={stop}>
          cancel
        </button>{" "}
        • enter to{" "}
        <button className="link-button" onClick={save}>
          save
        </button>
      </span>
    </div>
  );
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
  /** Laid out as in a Discord channel, rather than in bubbles. */
  channel: boolean;
}

/** Who in a group has read a message, as far as their read receipts say. People who turned them off never show. */
function readersOf(serverId: string, message: MessageView): UserView[] {
  const server = useApp.getState().servers[serverId];
  const conversation = server?.conversations.find((item) => item.groupId === message.groupId);
  const seq = message.seq;
  if (!server || !conversation || seq === null) return [];
  return conversation.members
    .filter((member) => member.userId !== server.self?.userId && (conversation.readBy[member.userId] ?? 0) >= seq)
    .map((member) => server.users[member.userId])
    .filter((user): user is UserView => !!user)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export const MessageItem = memo(function MessageItem({ message, listId, isGroup, isGroupAdmin, readUpTo, grouped, lastInGroup, fresh, highlighted, own, channel }: MessageItemProps) {
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
  // Someone blocked shows as a line, as in Discord, and their message only when asked.
  const blockedSender = useServerField((server) => !own && (server.prefs.blocked?.includes(message.senderId) ?? false), false);
  const blockedReply = useServerField((server) => !!message.reply && (server.prefs.blocked?.includes(message.reply.senderId) ?? false), false);
  const [revealed, setRevealed] = useState(false);
  const editingHere = useApp((state) => channel && state.editing[listId]?.id === message.id);

  const selfId = baseContext.selfId;
  const canDelete = own || (isGroup && isGroupAdmin);
  const isDeleted = message.deletedAt !== null;
  const canAct = canActOn(message);

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
  const onlyRound = !message.text && message.attachments.length === 1 && !!message.attachments[0]!.round && !message.reply && !message.forwarded;

  const meta = (
    <span
      className={`msg-meta${onlyImages ? " is-overlay" : ""}`}
      title={[
        formatFull(message.createdAt),
        message.timeDiffers ? ". The sender's device gives a very different time for this message." : "",
        message.expiresAt ? `. Disappears ${formatFull(message.expiresAt)}.` : "",
      ].join("")}
    >
      {message.timeDiffers && <ShieldAlert size={11} aria-label="The time of this message may not be right" />}
      {message.expiresAt && <Timer size={10} className="msg-timer" aria-label="Disappears" />}
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

  // In a channel the time is beside the name, and only these follow the text.
  const trailing = channel ? (
    <>
      {message.editedAt && !isDeleted && (
        <span className="cmsg-edited" title={formatFull(message.editedAt)}>
          (edited)
        </span>
      )}
      {message.timeDiffers && (
        <span className="cmsg-flag" title="The sender's device gives a very different time for this message.">
          <ShieldAlert size={13} aria-label="The time of this message may not be right" />
        </span>
      )}
      {message.expiresAt && (
        <span className="cmsg-flag" title={`Disappears ${formatFull(message.expiresAt)}`}>
          <Timer size={12} className="msg-timer" aria-label="Disappears" />
        </span>
      )}
    </>
  ) : metaInText ? (
    meta
  ) : undefined;

  const renderBody = (after?: ReactNode) => {
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
          {channel && after}
        </>
      );
    }
    return renderMarkup(message.text, context, after);
  };
  const body = renderBody(trailing);

  if (message.system) return <SystemMessage message={message} highlighted={highlighted} channel={channel} />;
  if (blockedSender && !revealed) {
    return (
      <div className={`msg is-other is-blocked${channel ? " is-channel" : ""}${highlighted ? " is-highlighted" : ""}`}>
        {isGroup && !channel && <span className="msg-avatar" />}
        <span className="msg-blocked">
          <Ban size={13} /> A message from someone you blocked
          <button className="link-button" onClick={() => setRevealed(true)}>
            Show
          </button>
        </span>
      </div>
    );
  }

  const toggleReaction = (key: string, emote?: EmoteRef) => {
    void run(() => session().toggleReaction(message.groupId, message.id, key, emote));
  };

  // Worked out as the menu opens, as in Telegram, for your own messages in a group.
  const readers = menu.menu && own && isGroup && canAct ? readersOf(serverId, message) : [];
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
    ...(readers.length > 0
      ? [
          {
            label: `Read by ${readers.length}`,
            icon: <CheckCheck size={15} />,
            submenu: readers.map((user) => ({
              label: user.displayName,
              icon: <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={20} />,
              onSelect: () => useApp.getState().selectConversation(`user:${user.id}`),
            })),
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
    // A video message alone is a circle, without a bubble, as large emoji are.
    onlyRound ? "is-jumbo is-round" : "",
    fresh ? "is-fresh" : "",
    selecting ? "is-selecting" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Not on something with its own click, such as a link, a picture or a reaction.
  const repliesOnDoubleClick = (event: React.MouseEvent) =>
    canAct && !selecting && !(event.target as Element).closest("button, a, input, textarea, video, audio, [role='slider']");
  const totalReactors = message.reactions.reduce((sum, reaction) => sum + reaction.userIds.length, 0);
  const placeholder = isDeleted ? (
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
  ) : null;
  const check = selecting && (
    <span className={`msg-check${selected ? " is-on" : ""}${canAct ? "" : " is-disabled"}`} role="checkbox" aria-checked={selected} aria-label="Select message">
      {selected && <Check size={13} strokeWidth={3} />}
    </span>
  );
  const pickReaction = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPicker({ x: rect.left, y: rect.top });
  };
  const popups = (
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
  );

  // As in a Discord channel: a picture and a name over a run of messages, each a full-width
  // row with its time beside the name, or on the left on hover further down the run.
  if (channel) {
    const mentionsMe = !own && (message.mentions.includes(selfId) || message.reply?.senderId === selfId);
    const canEdit = canAct && own && !!message.text && !message.forwarded;
    const classes = [
      className,
      "is-channel",
      mentionsMe ? "is-mentioned" : "",
      menu.menu || picker ? "is-menu-open" : "",
      message.status === "sending" ? "is-sending" : "",
      message.status === "failed" ? "is-failed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        className={classes}
        onContextMenu={(event) => !selecting && entries.length > 0 && menu.open(event)}
        onClickCapture={
          selecting
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (canAct) useApp.getState().toggleSelected(listId, message.id);
              }
            : undefined
        }
        onMouseDown={(event) => event.detail > 1 && repliesOnDoubleClick(event) && event.preventDefault()}
        onDoubleClick={(event) => !editingHere && repliesOnDoubleClick(event) && setReply(listId, message)}
      >
        {check}
        {message.reply && !placeholder && <ChannelReply message={message} blocked={blockedReply} />}
        <div className="cmsg-main">
          {grouped ? (
            <time className="cmsg-gutter-time" title={formatFull(message.createdAt)}>
              {formatTime(message.createdAt)}
            </time>
          ) : (
            <>
              <button className="cmsg-avatar" onClick={() => openProfile(message.senderId)} aria-label={`${senderName}'s profile`} tabIndex={-1}>
                <Avatar name={senderName} seed={message.senderId} avatar={senderAvatar} size={40} />
              </button>
              <h3 className="cmsg-head">
                <button className="cmsg-author" style={{ color: nameColor(message.senderId) }} onClick={() => openProfile(message.senderId)}>
                  {senderName}
                </button>
                <time className="cmsg-time" title={formatFull(message.createdAt)}>
                  {formatStamp(message.createdAt)}
                </time>
              </h3>
            </>
          )}
          <div className="cmsg-body">
            {placeholder ??
              (editingHere ? (
                <InlineEditor message={message} listId={listId} />
              ) : (
                <>
                  {message.forwarded && <ForwardedFrom userId={message.forwarded.userId} />}
                  {body && <div className="msg-text selectable">{body}</div>}
                  {message.attachments.length > 0 && (
                    <div className="cmsg-attachments">
                      <Attachments message={message} serverId={serverId} flush={false} own={false} />
                    </div>
                  )}
                  {message.preview && <LinkCard preview={message.preview} />}
                  {message.location && <LocationCard location={message.location} />}
                </>
              ))}
            {hasReactions && (
              <div className="reactions">
                {message.reactions.map((reaction) => (
                  <ReactionChip key={reaction.key} reaction={reaction} selfId={selfId} serverUrl={context.serverUrl} showPeople={false} onToggle={() => toggleReaction(reaction.key, reaction.emote)} />
                ))}
                {canAct && (
                  <Tooltip text="Add reaction" side="top">
                    <button className="reaction reaction-add" onClick={pickReaction} aria-label="Add reaction">
                      <SmilePlus size={16} />
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
            {message.status === "failed" && (
              <button className="msg-retry" onClick={() => void session().retryMessage(message.groupId, message.id)}>
                <AlertCircle size={13} /> Not sent. Try again
              </button>
            )}
          </div>
        </div>
        {canAct && !selecting && !editingHere && (
          <div className="cmsg-toolbar">
            {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
              <button key={emoji} className="cmsg-tool is-emoji" onClick={() => toggleReaction(emoji)} aria-label={`React with ${emoji}`}>
                {emoji}
              </button>
            ))}
            <span className="cmsg-tool-divider" />
            <Tooltip text="Add reaction" side="top">
              <button className="cmsg-tool" onClick={pickReaction} aria-label="Add reaction">
                <SmilePlus size={19} />
              </button>
            </Tooltip>
            {canEdit && (
              <Tooltip text="Edit" side="top">
                <button className="cmsg-tool" onClick={() => setEditing(listId, message)} aria-label="Edit">
                  <Pencil size={17} />
                </button>
              </Tooltip>
            )}
            <Tooltip text="Reply" side="top">
              <button className="cmsg-tool" onClick={() => setReply(listId, message)} aria-label="Reply">
                <CornerUpLeft size={19} />
              </button>
            </Tooltip>
            <Tooltip text="Forward" side="top">
              <button className="cmsg-tool" onClick={() => useApp.getState().setOverlay({ type: "forward", serverId, groupId: message.groupId, ids: [message.id] })} aria-label="Forward">
                <Forward size={19} />
              </button>
            </Tooltip>
            <Tooltip text="More" side="top">
              <button
                className="cmsg-tool"
                aria-label="More"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  menu.open({ clientX: rect.right, clientY: rect.bottom + 2 });
                }}
              >
                <MoreHorizontal size={19} />
              </button>
            </Tooltip>
          </div>
        )}
        {popups}
      </div>
    );
  }

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
      {check}
      {!own && isGroup && <span className="msg-avatar">{lastInGroup && <Avatar name={senderName} seed={message.senderId} avatar={senderAvatar} size={32} />}</span>}
      <div className="msg-stack">
        <div
          className={`bubble${message.status === "sending" ? " is-sending" : ""}${message.status === "failed" ? " is-failed" : ""}`}
          // A double click replies, as in Telegram, rather than selecting a word.
          onMouseDown={(event) => event.detail > 1 && repliesOnDoubleClick(event) && event.preventDefault()}
          onDoubleClick={(event) => repliesOnDoubleClick(event) && setReply(listId, message)}
        >
          {!own && isGroup && !grouped && !jumbo && (
            <span className="msg-author" style={{ color: nameColor(message.senderId) }}>
              {senderName}
            </span>
          )}
          {placeholder ?? (
            <>
              {message.forwarded && <ForwardedFrom userId={message.forwarded.userId} />}
              {message.reply && (
                <button className="msg-reply" onClick={() => jump(message.groupId, message.reply!.id)}>
                  <span className="msg-reply-author" style={{ color: nameColor(message.reply.senderId || "x") }}>
                    {replyName}
                  </span>
                  <span className="msg-reply-text truncate">{message.reply.deleted ? "Message deleted" : blockedReply ? "A message from someone you blocked" : plainText(message.reply.text) || (message.reply.hasAttachment ? "Attachment" : "Tap to view")}</span>
                </button>
              )}
              {message.attachments.length > 0 && <Attachments message={message} serverId={serverId} flush={onlyImages} own={own} />}
              {body && (
                <div className="msg-text selectable">
                  {body}
                </div>
              )}
              {message.preview && <LinkCard preview={message.preview} />}
              {message.location && <LocationCard location={message.location} />}
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
            <button className="icon-btn is-small" aria-label="React" onClick={pickReaction}>
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
      {popups}
    </div>
  );
});
