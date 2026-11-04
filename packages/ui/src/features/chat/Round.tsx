// Video messages, as Telegram's: a circle that plays by itself without sound, over and
// over, and from the start with its sound on a click, a ring going round as it plays.

import type { Attachment } from "@zuna/core";
import { AlertCircle, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import { useDecryptedUrl } from "@/lib/media";
import { playOnly } from "@/lib/voice";

/** How far round something has got, from 0 to 1, as a ring around a circle. */
function Ring({ progress }: { progress: number }) {
  return (
    <svg className="round-ring" viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="48.5" pathLength={1} strokeDasharray={`${Math.min(1, Math.max(0, progress))} 1`} />
    </svg>
  );
}

/** The camera while a video message is being recorded, mirrored as the person sees themselves, with the minute going round. */
export function RoundPreview({ stream, progress }: { stream: MediaStream; progress: number }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="round-preview" aria-hidden>
      <video ref={video} autoPlay muted playsInline />
      <Ring progress={progress} />
    </div>
  );
}

export function RoundAttachment({ attachment, serverId, uploadProgress }: { attachment: Attachment; serverId: string; uploadProgress?: number }) {
  const uploading = !attachment.fileId;
  // Small, and seen as soon as it's on screen, so it's fetched as a picture is.
  const { url, failed } = useDecryptedUrl(serverId, attachment, !uploading);
  const video = useRef<HTMLVideoElement>(null);
  /** Playing from the start with its sound, rather than by itself without. */
  const [heard, setHeard] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const duration = attachment.duration ?? 0;

  /** Back to playing by itself, without sound, over and over. */
  const quietly = () => {
    const element = video.current;
    if (!element) return;
    setHeard(false);
    setPosition(0);
    element.muted = true;
    element.loop = true;
    void element.play().catch(() => undefined);
  };

  useEffect(() => {
    if (url) quietly();
  }, [url]);

  const toggle = () => {
    const element = video.current;
    if (!element || !url) return;
    if (heard) {
      if (element.paused) {
        playOnly(element);
        void element.play().catch(() => undefined);
      } else element.pause();
      return;
    }
    setHeard(true);
    element.loop = false;
    element.muted = false;
    element.currentTime = 0;
    playOnly(element);
    void element.play().catch(() => quietly());
  };

  const label = `Video message, ${formatDuration(duration)}`;
  return (
    <button className={`round${heard ? " is-heard" : ""}`} onClick={toggle} disabled={uploading || failed} aria-label={heard && playing ? "Pause video message" : label}>
      {attachment.thumb && <img className="round-thumb" src={attachment.thumb} alt="" />}
      {url && (
        <video
          ref={video}
          src={url}
          playsInline
          muted
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => heard && setPosition(event.currentTarget.currentTime)}
          onEnded={quietly}
        />
      )}
      {uploading ? (
        <span className="round-state">
          <Spinner size={22} />
        </span>
      ) : failed ? (
        <span className="round-state">
          <AlertCircle size={22} />
        </span>
      ) : !url ? (
        <span className="round-state">
          <Spinner size={22} delayed />
        </span>
      ) : null}
      <Ring progress={uploading ? (uploadProgress ?? 0) : heard && duration ? position / duration : 0} />
      <span className="round-time">{formatDuration(heard ? position : duration)}</span>
      {url && !heard && (
        <span className="round-muted">
          <VolumeX size={13} />
        </span>
      )}
    </button>
  );
}
