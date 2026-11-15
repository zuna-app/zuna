// Watching a YouTube video together in a voice channel or a call. The video comes from
// YouTube to each device whose person pressed Watch, in YouTube's own player, which nothing
// is drawn over. Until then the tile shows what came inside the room's state, and this
// device contacts nobody. Zuna's own controls are under the player, never on it.

import type { WatchView } from "@zuna/core";
import { readYouTubeLink } from "@zuna/core";
import { WatchController, type WatchError, type WatchStatus } from "@zuna/watch";
import { Clapperboard, Square, Tv, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Modal, Spinner, Tooltip } from "@/components/ui";
import { mark, t, type MessageKey } from "@/lib/i18n";
import { useActiveServer, useApp } from "@/state/store";
import { useVoice, WATCH_FOCUS } from "@/voice/store";

/** What each of YouTube's errors is, in words, so people know it isn't Zuna. */
const WATCH_ERRORS: Record<WatchError, MessageKey> = {
  gone: mark("voice.watch.goneOrPrivate"),
  "not-embeddable": mark("voice.watch.ownerOnlyYouTube"),
  unplayable: mark("voice.watch.wontPlayHere"),
  "no-referrer": mark("voice.watch.errorNoReferrer"),
  unknown: mark("voice.watch.errorOther"),
};

const YOUTUBE_TERMS = "https://www.youtube.com/t/terms";
const GOOGLE_PRIVACY = "https://policies.google.com/privacy";

/** Asks once before this device first contacts YouTube, saying what Google learns, and remembers the answer in Privacy. */
export function WatchConsent({ action, onCancel, onAgree }: { action: string; onCancel: () => void; onAgree: () => void }) {
  const update = useApp((state) => state.updateSettings);
  return (
    <Modal
      title={t("voice.watch.consentTitle")}
      onClose={onCancel}
      width={460}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            className="btn btn-primary"
            autoFocus
            onClick={() => {
              update({ playYouTube: true });
              onAgree();
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 13.5 }}>{t("voice.watch.consentText")}</p>
      <p className="muted" style={{ fontSize: 13.5 }}>{t("voice.watch.consentNote")}</p>
      <p style={{ fontSize: 13 }}>
        <a href={YOUTUBE_TERMS} target="_blank" rel="noreferrer">
          {t("voice.watch.terms")}
        </a>
        {" · "}
        <a href={GOOGLE_PRIVACY} target="_blank" rel="noreferrer">
          {t("voice.watch.privacy")}
        </a>
      </p>
    </Modal>
  );
}

/** A YouTube link to put on for everyone in the room. */
export function WatchLinkDialog({ onClose }: { onClose: () => void }) {
  const watchStart = useVoice((state) => state.watchStart);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!readYouTubeLink(link)) {
      setError(t("voice.watch.notALink"));
      return;
    }
    setBusy(true);
    try {
      await watchStart(link);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("voice.watch.title")}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy || !link.trim()} onClick={() => void submit()}>
            {busy ? <Spinner /> : t("voice.watch.share")}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{t("voice.watch.link")}</span>
        <input
          className="input"
          autoFocus
          placeholder="https://www.youtube.com/watch?v=…"
          value={link}
          onChange={(event) => {
            setLink(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => event.key === "Enter" && void submit()}
          aria-label={t("voice.watch.link")}
        />
      </label>
      {error && <p className="field-error">{error}</p>}
      <p className="setting-hint">{t("voice.watch.linkHint")}</p>
    </Modal>
  );
}

/** The call's button for putting a video on, which asks first if this device hasn't been allowed to contact YouTube. */
export function WatchButton({ allowed }: { /** Whether watching together is on in this room. */ allowed: boolean }) {
  const playYouTube = useApp((state) => state.settings.playYouTube);
  const watch = useVoice((state) => state.watch);
  const [step, setStep] = useState<"consent" | "link" | null>(null);
  const label = !allowed ? t("voice.watch.off") : watch ? t("voice.watch.another") : t("voice.watch.title");
  return (
    <>
      <Tooltip text={label} side="top">
        <button className={`voice-control${watch ? " is-on" : ""}`} disabled={!allowed} onClick={() => setStep(playYouTube ? "link" : "consent")} aria-label={label}>
          <Clapperboard size={20} />
        </button>
      </Tooltip>
      {step === "consent" && <WatchConsent action={t("common.continue")} onCancel={() => setStep(null)} onAgree={() => setStep("link")} />}
      {step === "link" && <WatchLinkDialog onClose={() => setStep(null)} />}
    </>
  );
}

/**
 * A line about who did something to the video, worded for this person if it was them, for
 * someone by name, or for someone this device doesn't know.
 */
function byWhom(server: ReturnType<typeof useActiveServer>, userId: string, keys: { you: MessageKey; name: MessageKey; someone: MessageKey }): string {
  if (userId === server?.self?.userId) return t(keys.you);
  const name = server?.users[userId]?.displayName;
  return name ? t(keys.name, { name }) : t(keys.someone);
}

const PAUSED_BY = { you: mark("voice.watch.pausedByYou"), name: mark("voice.watch.pausedBy"), someone: mark("voice.watch.pausedBySomeone") };
const SHARED_BY = { you: mark("voice.watch.sharedByYou"), name: mark("voice.watch.sharedBy"), someone: mark("voice.watch.sharedBySomeone") };
const SHARED_BY_PRESS = { you: mark("voice.watch.coverByYou"), name: mark("voice.watch.coverBy"), someone: mark("voice.watch.coverBySomeone") };

/** What's on, small, in the strip under something else that fills the stage. */
export function WatchThumb({ watch }: { watch: WatchView }) {
  const setFocus = useVoice((state) => state.setFocus);
  return (
    <div className="voice-tile is-watch" onClick={() => setFocus(WATCH_FOCUS)} title={watch.video.title || t("voice.watch.untitled")}>
      {watch.video.image ? <img className="watch-poster" src={watch.video.image.data} alt="" /> : <Tv size={28} className="faint" />}
      <div className="voice-tile-label">
        <Tv size={13} />
        <span className="truncate">{watch.video.title || t("voice.watch.untitled")}</span>
      </div>
    </div>
  );
}

/** Whether the page can be seen, as a video plays only where its player shows. */
function usePageShown(): boolean {
  const [shown, setShown] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return shown;
}

/** YouTube's player, kept in step with the room. */
function WatchPlayer({ watch, onStatus, onBlocked }: { watch: WatchView; onStatus: (status: WatchStatus) => void; onBlocked: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const controller = useRef<WatchController | null>(null);
  const shown = usePageShown();
  const volume = useVoice((state) => state.settings.watchVolume);
  const muted = useVoice((state) => state.settings.watchMuted);
  const deafened = useVoice((state) => state.deafened);
  const handlers = useRef({ onStatus, onBlocked });
  handlers.current = { onStatus, onBlocked };

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const { settings, deafened } = useVoice.getState();
    const made = new WatchController(
      element,
      {
        intent: (change) => useVoice.getState().watchControl(change),
        status: (status) => handlers.current.onStatus(status),
        volume: ({ level, muted }) => useVoice.getState().updateSettings({ watchVolume: level, watchMuted: muted }),
        blocked: () => handlers.current.onBlocked(),
      },
      { muted: settings.watchMuted || deafened },
    );
    controller.current = made;
    // As the player remembers nothing between sessions, once it's started.
    made.setVolume(settings.watchVolume);
    made.setMuted(settings.watchMuted || deafened);
    return () => {
      made.destroy();
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    controller.current?.apply({ video: watch.video.id, playing: watch.playing, position: watch.position, age: Date.now() - watch.at, rate: watch.rate });
  }, [watch]);

  useEffect(() => controller.current?.hold(!shown), [shown]);
  useEffect(() => controller.current?.setVolume(volume), [volume]);
  useEffect(() => controller.current?.setMuted(muted || deafened), [muted, deafened]);

  return <div ref={holder} className="watch-player" />;
}

/** The video watched together, filling the stage: the picture until Watch is pressed, then YouTube's player, with Zuna's bar under it. */
export function WatchStage({ watch }: { watch: WatchView }) {
  const server = useActiveServer();
  const watching = useVoice((state) => state.watching === watch.session);
  const setWatching = useVoice((state) => state.setWatching);
  const watchStop = useVoice((state) => state.watchStop);
  const volume = useVoice((state) => state.settings.watchVolume);
  const muted = useVoice((state) => state.settings.watchMuted);
  const deafened = useVoice((state) => state.deafened);
  const updateSettings = useVoice((state) => state.updateSettings);
  const playYouTube = useApp((state) => state.settings.playYouTube);
  /** What the question about YouTube is in the way of. */
  const [asking, setAsking] = useState<"watch" | "another" | null>(null);
  const [another, setAnother] = useState(false);
  const [status, setStatus] = useState<WatchStatus | null>(null);
  const [blocked, setBlocked] = useState(false);
  const title = watch.video.title || t("voice.watch.untitled");
  const silent = muted || deafened;

  useEffect(() => {
    setStatus(null);
    setBlocked(false);
  }, [watch.video.id, watching]);
  useEffect(() => {
    if (status?.phase === "in-step") setBlocked(false);
  }, [status?.phase]);

  const press = () => (playYouTube ? setWatching(true) : setAsking("watch"));
  const changed = watch.playing ? null : byWhom(server, watch.changedBy, PAUSED_BY);
  const sharedBy = byWhom(server, watch.video.startedBy, SHARED_BY);
  const note = status?.error
    ? t(WATCH_ERRORS[status.error])
    : blocked
      ? t("voice.watch.blockedByBrowser")
      : watching && status?.phase === "catching-up"
        ? t("voice.watch.catchingUp")
        : null;

  return (
    <div className="watch-stage">
      {watching ? (
        <WatchPlayer key={watch.session} watch={watch} onStatus={setStatus} onBlocked={() => setBlocked(true)} />
      ) : (
        <div className="watch-cover">
          {watch.video.image && <img className="watch-poster" src={watch.video.image.data} alt="" />}
          <div className="watch-cover-text">
            <h3>{title}</h3>
            {watch.video.author && <p>{watch.video.author}</p>}
            <p className="muted">{byWhom(server, watch.video.startedBy, SHARED_BY_PRESS)}</p>
            <button className="btn btn-primary" onClick={press}>
              <Tv size={16} /> {t("voice.watch.watch")}
            </button>
          </div>
        </div>
      )}
      <div className="watch-bar" role="toolbar" aria-label={t("voice.settings.video")}>
        <div className="watch-bar-text">
          <b className="truncate">{title}</b>
          <span className="truncate muted">{note ?? changed ?? (watch.video.author ? `${sharedBy} · ${watch.video.author}` : sharedBy)}</span>
        </div>
        {watching && (
          <div className="watch-volume">
            <Tooltip text={deafened ? t("voice.watch.deafened") : silent ? t("voice.watch.unmute") : t("voice.watch.mute")} side="top">
              <button className="icon-btn is-small" disabled={deafened} onClick={() => updateSettings({ watchMuted: !muted })} aria-label={silent ? t("voice.watch.unmute") : t("voice.watch.mute")}>
                {silent ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
            </Tooltip>
            <input
              className="voice-slider"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => updateSettings({ watchVolume: Number(event.target.value), watchMuted: false })}
              aria-label={t("voice.watch.volume")}
              title={t("voice.watch.volumeAt", { percent: Math.round(volume * 100) })}
            />
          </div>
        )}
        <button className="btn btn-small" onClick={() => (playYouTube ? setAnother(true) : setAsking("another"))}>
          {t("voice.watch.another")}
        </button>
        <Tooltip text={t("voice.watch.stopTooltip")} side="top">
          <button className="btn btn-small" onClick={watchStop} aria-label={t("voice.watch.stopAll")}>
            <Square size={13} /> {t("voice.watch.stop")}
          </button>
        </Tooltip>
        {watching && (
          <Tooltip text={t("voice.watch.leaveTooltip")} side="top">
            <button className="icon-btn is-small" onClick={() => setWatching(false)} aria-label={t("voice.watch.stopHere")}>
              <X size={16} />
            </button>
          </Tooltip>
        )}
      </div>
      {asking && (
        <WatchConsent
          action={asking === "watch" ? t("voice.watch.watch") : t("common.continue")}
          onCancel={() => setAsking(null)}
          onAgree={() => {
            setAsking(null);
            if (asking === "watch") setWatching(true);
            else setAnother(true);
          }}
        />
      )}
      {another && <WatchLinkDialog onClose={() => setAnother(false)} />}
    </div>
  );
}
