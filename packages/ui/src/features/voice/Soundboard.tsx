// The soundboard: sounds a server's admins add, which anyone in a voice channel or a call
// can play to everyone there. Each device plays a sound itself from its file, so it goes
// out as it was made rather than through someone's microphone.

import type { SoundView } from "@zuna/core";
import { SOUND_INPUT_MAX_MS, SOUND_RATE, writeWav } from "@zuna/core/sounds";
import { AudioLines, Pencil, Play, Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Field, Spinner, Tooltip, useAction, useReturnFocus } from "@/components/ui";
import { useEscape } from "@/lib/escape";
import { t } from "@/lib/i18n";
import { useActiveServer, useApp } from "@/state/store";
import { playClip } from "@/voice/sounds";
import { useVoice } from "@/voice/store";

/**
 * What someone picked, as the core makes a sound from: WAV in one channel at 48 kHz, of
 * no more than its first 20 seconds. The core cuts the silence and the rest.
 */
async function soundFromFile(file: File): Promise<Blob> {
  let decoded: AudioBuffer;
  try {
    // Decoding comes out at the context's own rate, which an offline context never plays.
    decoded = await new OfflineAudioContext(1, 1, SOUND_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(t("voice.soundboard.unreadable"));
  }
  const frames = Math.min(decoded.length, (SOUND_RATE * SOUND_INPUT_MAX_MS) / 1000);
  // Rendered into one channel, which mixes any others into it.
  const offline = new OfflineAudioContext(1, frames, SOUND_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = (await offline.startRendering()).getChannelData(0);
  const samples = new Int16Array(rendered.length);
  for (let index = 0; index < rendered.length; index++) samples[index] = Math.max(-32768, Math.min(32767, Math.round(rendered[index]! * 32768)));
  return new Blob([writeWav(samples)], { type: "audio/wav" });
}

const seconds = (sound: SoundView) => t("voice.soundboard.seconds", { seconds: (sound.durationMs / 1000).toFixed(1) });

/** Why this person can't play a sound in the room they're in, if they can't. */
function useRefusal(roomSounds: boolean): string | null {
  const muted = useVoice((state) => state.muted);
  const deafened = useVoice((state) => state.deafened);
  const serverMuted = useVoice((state) => state.serverMuted);
  const noMic = useVoice((state) => state.noMic);
  if (!roomSounds) return t("server.theSoundboardIsOffIn");
  if (serverMuted) return t("server.anAdminMutedYouSo");
  if (deafened) return t("server.undeafenToPlaySounds");
  // Without a microphone, someone can only listen, and so they're muted.
  if (muted || noMic) return t("server.unmuteToPlaySounds");
  return null;
}

function SoundboardPanel({ anchor, roomSounds, onClose }: { anchor: DOMRect; roomSounds: boolean; onClose: () => void }) {
  const server = useActiveServer();
  const setOverlay = useApp((state) => state.setOverlay);
  const playSound = useVoice((state) => state.playSound);
  const volume = useVoice((state) => state.settings.soundboardVolume);
  const updateSettings = useVoice((state) => state.updateSettings);
  const refusal = useRefusal(roomSounds);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.top });
  const sounds = server?.sounds ?? [];
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";
  useReturnFocus();

  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - rect.width / 2), window.innerWidth - rect.width - 8);
    setPosition({ left, top: Math.max(8, anchor.top - rect.height - 8) });
  }, [anchor, sounds.length, refusal]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEscape(onClose);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) latestClose.current();
    };
    const timer = setTimeout(() => window.addEventListener("mousedown", close));
    ref.current?.querySelector<HTMLButtonElement>(".soundboard-sound:not(:disabled)")?.focus();
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
    };
  }, []);

  const manage = () => {
    onClose();
    setOverlay({ type: "server-settings", section: "soundboard" });
  };

  return createPortal(
    <div ref={ref} className="soundboard" role="dialog" aria-label={t("voice.soundboard.title")} style={position}>
      <header className="soundboard-head">
        <AudioLines size={15} />
        <span className="grow">{t("voice.soundboard.title")}</span>
        {isAdmin && (
          <Tooltip text={t("voice.soundboard.manage")}>
            <button className="icon-btn is-small" onClick={manage} aria-label={t("voice.soundboard.manage")}>
              <Settings size={15} />
            </button>
          </Tooltip>
        )}
      </header>
      {refusal && sounds.length > 0 && <p className="soundboard-note">{refusal}</p>}
      {sounds.length === 0 ? (
        <p className="soundboard-empty">
          {t("voice.soundboard.empty")}{" "}
          {isAdmin ? (
            <button className="soundboard-link" onClick={manage}>
              {t("voice.soundboard.addSome")}
            </button>
          ) : (
            t("voice.soundboard.adminsCanAdd")
          )}
        </p>
      ) : (
        <div className="soundboard-grid">
          {sounds.map((sound) => (
            <button key={sound.id} className="soundboard-sound" disabled={!!refusal} onClick={() => void playSound(sound.id)} title={t("voice.soundboard.soundTitle", { name: sound.name, length: seconds(sound) })}>
              <span className="soundboard-emoji" aria-hidden>
                {sound.emoji || "🔊"}
              </span>
              <span className="truncate">{sound.name}</span>
            </button>
          ))}
        </div>
      )}
      <label className="soundboard-volume">
        <span>
          {t("voice.soundboard.volume")} <b>{Math.round(volume * 100)}%</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => updateSettings({ soundboardVolume: Number(event.target.value) })} aria-label={t("voice.settings.soundboardVolume")} />
      </label>
    </div>,
    document.body,
  );
}

/** The soundboard's button among a call's controls. */
export function SoundboardButton({ roomSounds }: { /** Whether the soundboard plays in this room. */ roomSounds: boolean }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <Tooltip text={t("voice.soundboard.title")} side="top">
        <button
          className={`voice-control${anchor ? " is-on" : ""}`}
          onClick={(event) => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())}
          aria-label={t("voice.soundboard.title")}
          aria-expanded={!!anchor}
        >
          <AudioLines size={20} />
        </button>
      </Tooltip>
      {anchor && <SoundboardPanel anchor={anchor} roomSounds={roomSounds} onClose={() => setAnchor(null)} />}
    </>
  );
}

function SoundRow({ sound }: { sound: SoundView }) {
  const session = useApp((state) => state.session);
  const volume = useVoice((state) => state.settings.outputVolume * state.settings.soundboardVolume);
  const [editing, setEditing] = useState(false);
  // While a sound's being renamed, Escape leaves the name as it was, and the soundboard open.
  useEscape(editing ? () => setEditing(false) : null);
  const [name, setName] = useState(sound.name);
  const [emoji, setEmoji] = useState(sound.emoji);
  const { busy, run } = useAction();
  const preview = () => run(async () => playClip(await (await session().soundFile(sound.id)).arrayBuffer(), volume || 0.6));
  const save = () =>
    run(async () => {
      await session().updateSound(sound.id, { name: name.trim(), emoji: emoji.trim() });
      setEditing(false);
    });
  const remove = () =>
    run(async () => {
      if (!window.confirm(t("voice.soundboard.deleteConfirm", { name: sound.name }))) return;
      await session().deleteSound(sound.id);
    });

  if (editing) {
    return (
      <div className="sound-row is-editing">
        <input className="input sound-emoji-input" value={emoji} maxLength={8} placeholder="🔊" onChange={(event) => setEmoji(event.target.value)} aria-label={t("voice.soundboard.emoji")} />
        <input
          className="input grow"
          autoFocus
          value={name}
          maxLength={32}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) void save();
          }}
          aria-label={t("common.name")}
        />
        <button className="btn" onClick={() => setEditing(false)}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? <Spinner size={15} /> : t("common.save")}
        </button>
      </div>
    );
  }
  return (
    <div className="sound-row">
      <span className="sound-row-emoji" aria-hidden>
        {sound.emoji || "🔊"}
      </span>
      <span className="grow truncate">{sound.name}</span>
      <span className="faint sound-row-length">{seconds(sound)}</span>
      <Tooltip text={t("voice.soundboard.listen")}>
        <button className="icon-btn is-small" disabled={busy} onClick={() => void preview()} aria-label={t("voice.soundboard.listenTo", { name: sound.name })}>
          <Play size={15} />
        </button>
      </Tooltip>
      <Tooltip text={t("voice.soundboard.rename")}>
        <button
          className="icon-btn is-small"
          onClick={() => {
            setName(sound.name);
            setEmoji(sound.emoji);
            setEditing(true);
          }}
          aria-label={t("voice.soundboard.renameNamed", { name: sound.name })}
        >
          <Pencil size={15} />
        </button>
      </Tooltip>
      <Tooltip text={t("common.delete")}>
        <button className="icon-btn is-small" disabled={busy} onClick={() => void remove()} aria-label={t("voice.soundboard.deleteNamed", { name: sound.name })}>
          <Trash2 size={15} />
        </button>
      </Tooltip>
    </div>
  );
}

/** The soundboard in a server's settings, for its admins. */
export function ServerSoundboardSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  if (!server) return null;
  const sounds = server.sounds;

  const add = () =>
    run(async () => {
      if (!file) return;
      await session().addSound(await soundFromFile(file), name.trim(), emoji.trim());
      toast(t("voice.soundboard.added", { name: name.trim() }));
      setFile(null);
      setName("");
      setEmoji("");
    });

  return (
    <>
      <h1>{t("serverSettings.sections.soundboard")}</h1>
      <p className="settings-lead">{t("voice.soundboard.lead")}</p>
      <div className="sound-add">
        <div className="sound-add-fields">
          <Field label={t("voice.soundboard.emoji")} value={emoji} maxLength={8} placeholder="🔊" onChange={(event) => setEmoji(event.target.value)} />
          <Field
            label={t("common.name")}
            value={name}
            maxLength={32}
            placeholder={t("voice.soundboard.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && file && name.trim() && !busy) void add();
            }}
          />
        </div>
        <div className="sound-add-actions">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            {file ? <span className="truncate sound-add-file">{file.name}</span> : t("voice.soundboard.choose")}
          </button>
          <button className="btn btn-primary" disabled={!file || !name.trim() || busy || sounds.length >= 50} onClick={() => void add()}>
            {busy ? <Spinner size={15} /> : (
              <>
                <Plus size={15} /> {t("voice.soundboard.add")}
              </>
            )}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*"
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) {
              setFile(picked);
              if (!name.trim()) setName(picked.name.replace(/\.[^.]+$/, "").slice(0, 32));
            }
            event.target.value = "";
          }}
        />
        <span className="setting-hint">{sounds.length >= 50 ? t("server.theSoundboardIsFullDelete") : t("voice.soundboard.count", { used: sounds.length })}</span>
      </div>
      {sounds.length > 0 && (
        <div className="sound-list">
          {sounds.map((sound) => (
            <SoundRow key={sound.id} sound={sound} />
          ))}
        </div>
      )}
    </>
  );
}
