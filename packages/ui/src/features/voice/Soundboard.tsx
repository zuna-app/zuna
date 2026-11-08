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
    throw new Error("That file isn't a sound Zuna can read.");
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

const seconds = (sound: SoundView) => `${(sound.durationMs / 1000).toFixed(1)} s`;

/** Why this person can't play a sound in the room they're in, if they can't. */
function useRefusal(roomSounds: boolean): string | null {
  const muted = useVoice((state) => state.muted);
  const deafened = useVoice((state) => state.deafened);
  const serverMuted = useVoice((state) => state.serverMuted);
  const noMic = useVoice((state) => state.noMic);
  if (!roomSounds) return "The soundboard is off in this voice channel.";
  if (serverMuted) return "An admin muted you, so you can't play sounds.";
  if (deafened) return "Undeafen to play sounds.";
  // Without a microphone, someone can only listen, and so they're muted.
  if (muted || noMic) return "Unmute to play sounds.";
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
    <div ref={ref} className="soundboard" role="dialog" aria-label="Soundboard" style={position}>
      <header className="soundboard-head">
        <AudioLines size={15} />
        <span className="grow">Soundboard</span>
        {isAdmin && (
          <Tooltip text="Add and change sounds">
            <button className="icon-btn is-small" onClick={manage} aria-label="Add and change sounds">
              <Settings size={15} />
            </button>
          </Tooltip>
        )}
      </header>
      {refusal && sounds.length > 0 && <p className="soundboard-note">{refusal}</p>}
      {sounds.length === 0 ? (
        <p className="soundboard-empty">
          This server has no sounds yet.{" "}
          {isAdmin ? (
            <button className="soundboard-link" onClick={manage}>
              Add some
            </button>
          ) : (
            "Its admins add them."
          )}
        </p>
      ) : (
        <div className="soundboard-grid">
          {sounds.map((sound) => (
            <button key={sound.id} className="soundboard-sound" disabled={!!refusal} onClick={() => void playSound(sound.id)} title={`${sound.name}, ${seconds(sound)}`}>
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
          Volume <b>{Math.round(volume * 100)}%</b>
        </span>
        <input className="voice-slider" type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => updateSettings({ soundboardVolume: Number(event.target.value) })} aria-label="Soundboard volume" />
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
      <Tooltip text="Soundboard" side="top">
        <button
          className={`voice-control${anchor ? " is-on" : ""}`}
          onClick={(event) => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())}
          aria-label="Soundboard"
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
      if (!window.confirm(`Delete ${sound.name}? It goes from everyone's soundboard.`)) return;
      await session().deleteSound(sound.id);
    });

  if (editing) {
    return (
      <div className="sound-row is-editing">
        <input className="input sound-emoji-input" value={emoji} maxLength={8} placeholder="🔊" onChange={(event) => setEmoji(event.target.value)} aria-label="Emoji" />
        <input
          className="input grow"
          autoFocus
          value={name}
          maxLength={32}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) void save();
          }}
          aria-label="Name"
        />
        <button className="btn" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? <Spinner size={15} /> : "Save"}
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
      <Tooltip text="Listen">
        <button className="icon-btn is-small" disabled={busy} onClick={() => void preview()} aria-label={`Listen to ${sound.name}`}>
          <Play size={15} />
        </button>
      </Tooltip>
      <Tooltip text="Rename">
        <button
          className="icon-btn is-small"
          onClick={() => {
            setName(sound.name);
            setEmoji(sound.emoji);
            setEditing(true);
          }}
          aria-label={`Rename ${sound.name}`}
        >
          <Pencil size={15} />
        </button>
      </Tooltip>
      <Tooltip text="Delete">
        <button className="icon-btn is-small" disabled={busy} onClick={() => void remove()} aria-label={`Delete ${sound.name}`}>
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
      toast(`Added ${name.trim()}`);
      setFile(null);
      setName("");
      setEmoji("");
    });

  return (
    <>
      <h1>Soundboard</h1>
      <p className="settings-lead">
        Sounds anyone in a voice channel or a call can play to everyone there. Each is cut to five seconds and made about as loud as the rest. What they're called and how they sound are
        encrypted, so the server can't hear them.
      </p>
      <div className="sound-add">
        <div className="sound-add-fields">
          <Field label="Emoji" value={emoji} maxLength={8} placeholder="🔊" onChange={(event) => setEmoji(event.target.value)} />
          <Field
            label="Name"
            value={name}
            maxLength={32}
            placeholder="Airhorn"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && file && name.trim() && !busy) void add();
            }}
          />
        </div>
        <div className="sound-add-actions">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            {file ? <span className="truncate sound-add-file">{file.name}</span> : "Choose a sound"}
          </button>
          <button className="btn btn-primary" disabled={!file || !name.trim() || busy || sounds.length >= 50} onClick={() => void add()}>
            {busy ? <Spinner size={15} /> : (
              <>
                <Plus size={15} /> Add sound
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
        <span className="setting-hint">{sounds.length >= 50 ? "The soundboard is full. Delete a sound to add another." : `${sounds.length} of 50 sounds.`}</span>
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
