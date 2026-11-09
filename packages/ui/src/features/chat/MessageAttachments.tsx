// What a message carries: pictures, videos, sound files, voice messages and files with their
// upload progress, link previews and shared places.

import type { Attachment, LinkPreview, MessageView, SharedLocation } from "@zuna/core";
import { AlertCircle, Download, File as FileIcon, MapPin, Pause, Play } from "lucide-react";
import { linkHost } from "@zuna/core/links";
import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner, useAction } from "@/components/ui";
import { formatBytes, formatDuration } from "@/lib/format";
import { accuracyText, coordinatesText, mapLink } from "@/lib/location";
import { downloadAttachment, loadsByItself, picturesAmong, useDecryptedUrl } from "@/lib/media";
import { RoundAttachment } from "./Round";
import { decodeWaveform, playOnly } from "@/lib/voice";
import { VOICE_SPEEDS } from "@/state/settings";
import { useApp } from "@/state/store";

function ImageAttachment({ attachment, message, serverId, single, uploadProgress }: { attachment: Attachment; message: MessageView; serverId: string; single: boolean; uploadProgress?: number }) {
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
      onClick={() => {
        if (!url) return setWanted(true);
        // With the chat's other pictures loaded, which the viewer goes between.
        const state = useApp.getState();
        const loaded = state.lists[message.groupId]?.items ?? [message];
        setOverlay({ type: "image", serverId, ...picturesAmong(loaded, attachment, state.servers[serverId]?.prefs.blocked) });
      }}
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
  // How fast it plays, the same for all of them, as in Telegram. A browser keeps the pitch.
  const speed = useApp((state) => state.settings.voiceSpeed);
  const updateSettings = useApp((state) => state.updateSettings);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

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
    element.playbackRate = speed;
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
        <span className="voice-meta">
          <span className="voice-time">{formatDuration(playing || position ? position : duration)}</span>
          {(playing || position > 0) && (
            <button
              className="voice-speed"
              onClick={() => updateSettings({ voiceSpeed: VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(speed) + 1) % VOICE_SPEEDS.length] })}
              aria-label={`Playback speed, ${speed} times`}
              title="Playback speed"
            >
              {speed}×
            </button>
          )}
        </span>
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

export function Attachments({ message, serverId, flush, own }: { message: MessageView; serverId: string; flush: boolean; own: boolean }) {
  const images = message.attachments.filter((item) => item.mime.startsWith("image/") && item.width);
  const others = message.attachments.filter((item) => !images.includes(item));
  return (
    <>
      {images.length > 0 && (
        <div className={`media-grid media-count-${Math.min(images.length, 4)}${flush ? " has-no-text" : ""}`}>
          {images.map((attachment, index) => (
            <ImageAttachment key={attachment.fileId || index} attachment={attachment} message={message} serverId={serverId} single={images.length === 1} uploadProgress={fileProgress(message, attachment)} />
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

/**
 * A link's preview, sent by whoever wrote the message. What it says about the page
 * is their claim, so where the link really goes is always shown with it. A wide
 * picture goes below, a small one beside the text.
 */
export function LinkCard({ preview }: { preview: LinkPreview }) {
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
export function LocationCard({ location }: { location: SharedLocation }) {
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
